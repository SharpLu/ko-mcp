#!/usr/bin/env node
/**
 * mcp.ko.io deploy guard -- capture, upload, deploy, verify, auto-rollback.
 *
 * This is the I/O shell only. Every decision it makes comes from
 * `scripts/lib/deploy-guard.mjs`, which is unit-tested; this file spawns
 * wrangler, calls mcp.ko.io, posts to Discord and writes $GITHUB_OUTPUT.
 *
 *   node scripts/deploy-guard.mjs capture          # BEFORE the upload
 *   node scripts/deploy-guard.mjs upload
 *   node scripts/deploy-guard.mjs deploy  --version-id <id>
 *   node scripts/deploy-guard.mjs verify  --deployed <id> --previous <id>
 *
 * `verify` is the one that can change state: on a failed post-deploy check it
 * rolls back to --previous, re-verifies the rolled-back Worker, posts to
 * Discord #deploys and exits non-zero either way (a deploy that had to be
 * rolled back is not a successful deploy).
 *
 * Exit codes from `verify`:
 *   0  all post-deploy checks passed
 *   20 checks failed, rollback performed AND verified healthy
 *   21 checks failed, rollback performed but NOT healthy  (page a human)
 *   22 checks failed and no rollback was possible         (page a human)
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DeployGuardError,
  MIN_TOOLS,
  NON_INTERACTIVE_ENV,
  ROLLBACK_TIMEOUT_MS,
  WORKER_NAME,
  buildDiscordMessage,
  buildRollbackArgv,
  evaluateGolden,
  evaluateHealth,
  evaluateTools,
  formatCommand,
  githubOutputEntry,
  parseUploadedVersionId,
  pickServingVersion,
  readVersionsList,
  resolveGoldenContract,
  summarizeChecks,
  truncate,
} from "./lib/deploy-guard.mjs";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_BASE = process.env.MCP_BASE || "https://mcp.ko.io";

// --- tiny I/O helpers ------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const entry = githubOutputEntry(key, value, `ghout_${randomUUID()}`);
  if (file) appendFileSync(file, entry);
  else log(`[output] ${key}=${String(value).split("\n")[0]}`);
}

/**
 * Run a command, capturing combined output, with a hard timeout.
 * Note the shape: `rc` starts at 0 and is only ever assigned from the real
 * process exit -- no `$?` after an assignment, no PIPESTATUS, because there is
 * no shell here at all.
 */
function run(cmd, args, { timeoutMs = 600_000, env = {}, cwd = SERVER_DIR, echo = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (chunk) => {
      const s = chunk.toString();
      out += s;
      if (echo) process.stdout.write(s);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${out}\nspawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: out, timedOut });
    });
  });
}

// Test seams. Production always takes the defaults; the rehearsal test in
// src/__tests__/deploy-guard.rehearsal.test.mjs points WRANGLER at a fake CLI
// and shrinks the retry budget, so the rollback path can actually be executed
// locally instead of merely reasoned about.
const WRANGLER = (process.env.DEPLOY_GUARD_WRANGLER || "npx wrangler").split(" ").filter(Boolean);
const ATTEMPTS = Number(process.env.DEPLOY_GUARD_ATTEMPTS || 3);
const RETRY_DELAY_MS = Number(process.env.DEPLOY_GUARD_DELAY_MS || 5000);

const wrangler = (args, opts = {}) =>
  run(WRANGLER[0], [...WRANGLER.slice(1), ...args], { env: NON_INTERACTIVE_ENV, ...opts });

async function httpText(url, init) {
  try {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.text(), error: null };
  } catch (err) {
    return { status: 0, body: "", error: String(err?.message ?? err) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// --- post-deploy checks ----------------------------------------------------

const TOOLS_RPC = {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
};

async function runChecks({ label, attempts = ATTEMPTS, delayMs = RETRY_DELAY_MS }) {
  let checks = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const health = await httpText(`${MCP_BASE}/health`);
    const healthCheck = health.error
      ? { name: "health", ok: false, examined: 0, detail: `request failed: ${health.error}` }
      : evaluateHealth(health.status, health.body);

    const tools = await httpText(`${MCP_BASE}/mcp`, TOOLS_RPC);
    const toolsCheck = tools.error
      ? { name: "tools_list", ok: false, examined: 0, count: 0, detail: `request failed: ${tools.error}` }
      : evaluateTools(tools.status, tools.body);

    checks = [healthCheck, toolsCheck];
    if (checks.every((c) => c.ok)) break;
    if (attempt < attempts) {
      log(`[${label}] attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms (propagation lag)`);
      await sleep(delayMs);
    }
  }

  // Golden contract (wave M1). Absent -> SKIP, never a silent pass.
  const resolved = resolveGoldenContract({
    envCmd: process.env.MCP_GOLDEN_CONTRACT_CMD,
    candidates: [
      path.join(SERVER_DIR, "scripts", "golden-contract.mjs"),
      path.join(SERVER_DIR, "scripts", "mcp-golden-contract.mjs"),
    ],
    exists: existsSync,
  });
  let goldenRun = null;
  if (resolved.available) {
    const res =
      resolved.kind === "script"
        ? await run(process.execPath, [resolved.command], { timeoutMs: 300_000 })
        : await run("bash", ["-c", resolved.command], { timeoutMs: 300_000 });
    const cases = res.output.match(/(\d+)\s+cases?/i);
    goldenRun = {
      code: res.code,
      examined: cases ? Number(cases[1]) : 0,
      detail: `exit ${res.code}${res.timedOut ? " (TIMED OUT)" : ""}`,
    };
  }
  checks.push(evaluateGolden(resolved, goldenRun));

  const summary = summarizeChecks(checks);
  for (const line of summary.lines) log(`[${label}] ${line}`);
  log(
    `[${label}] gate counts: total=${summary.counts.total} passed=${summary.counts.passed} ` +
      `failed=${summary.counts.failed} skipped=${summary.counts.skipped}`,
  );
  return { checks, summary };
}

// --- Discord ---------------------------------------------------------------

async function notifyDiscord(message) {
  const hook = process.env.DISCORD_WEBHOOK_DEPLOYS;
  if (!hook) {
    log("::warning::DISCORD_WEBHOOK_DEPLOYS missing; rollback notification not sent");
    log(message.content);
    return false;
  }
  const res = await httpText(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message.content }),
  });
  log(`[discord] HTTP ${res.status} (content ${message.content.length} chars, truncated=${message.truncated})`);
  return res.status >= 200 && res.status < 300;
}

// --- commands --------------------------------------------------------------

/**
 * Capture the rollback target BEFORE anything changes, and print the concrete
 * rollback command. After the upload, `versions list` shows the new version and
 * any positional "previous" assumption silently inverts -- so this must run
 * first, and the command it prints must be runnable by a human as-is.
 */
async function cmdCapture() {
  const res = await wrangler(["deployments", "status", "--json", "--name", WORKER_NAME], { echo: false });
  if (res.code !== 0) {
    log(res.output);
    log("::warning::could not read the current deployment; auto-rollback will be UNAVAILABLE for this run");
    setOutput("previous_version_id", "");
    setOutput("rollback_available", "false");
    return 0;
  }
  let serving;
  try {
    serving = pickServingVersion(JSON.parse(res.output.trim()));
  } catch (err) {
    log(res.output);
    log(`::warning::${err.message}; auto-rollback will be UNAVAILABLE for this run`);
    setOutput("previous_version_id", "");
    setOutput("rollback_available", "false");
    return 0;
  }

  log("=".repeat(72));
  log("ROLLBACK PLAN (captured before upload -- valid from this moment on)");
  log(`  currently serving: ${serving.versionId} @ ${serving.percentage}%`);
  if (serving.split) {
    log("  ::warning::traffic is split across multiple versions; rollback targets the largest share only");
  }
  log("  if this deploy misbehaves, run this from server/:");
  log(`    ${formatCommand(buildRollbackArgv(serving.versionId, { reason: "manual rollback" }))}`);
  log("  the failed version is never deleted; it stays in `npx wrangler versions list` for forensics");
  log("=".repeat(72));

  setOutput("previous_version_id", serving.versionId);
  setOutput("rollback_available", "true");
  return 0;
}

async function cmdUpload() {
  const res = await wrangler(["versions", "upload"]);
  if (res.code !== 0) return res.code;
  const versionId = parseUploadedVersionId(res.output);
  log(`uploaded version: ${versionId}`);

  const list = await wrangler(["versions", "list", "--json", "--name", WORKER_NAME], { echo: false });
  if (list.code === 0) {
    try {
      const read = readVersionsList(JSON.parse(list.output.trim()));
      log(
        `versions list: ${read.count} rows, ascending_by_created_on=${read.ascendingByCreatedOn}, ` +
          `newest=${read.newestId} (positional-last-is-newest=${read.positionalLastIsNewest})`,
      );
      if (!read.ascendingByCreatedOn) {
        log("::warning::wrangler versions list is no longer ascending by created_on -- re-check deploy-guard assumptions");
      }
    } catch {
      log("::warning::could not parse versions list --json (diagnostic only)");
    }
  }
  setOutput("version_id", versionId);
  return 0;
}

async function cmdDeploy() {
  const versionId = arg("version-id");
  if (!versionId) throw new DeployGuardError("deploy requires --version-id");
  const res = await wrangler(["versions", "deploy", `${versionId}@100%`, "-y"]);
  return res.code;
}

async function cmdVerify() {
  const deployed = arg("deployed");
  const previous = arg("previous");

  const { summary } = await runChecks({ label: "verify" });
  if (summary.ok) {
    log("post-deploy checks passed; no rollback needed");
    setOutput("outcome", "success");
    setOutput("notified", "false");
    return 0;
  }

  log(`::error::post-deploy check failed: ${summary.firstFailure}`);
  const failLog = summary.lines.join("\n");

  if (!previous) {
    setOutput("outcome", "no_rollback_target");
    const msg = buildDiscordMessage({
      outcome: "rollback_failed",
      rolledBackTo: null,
      failedCheck: summary.firstFailure,
      checkDetail: "no previous version was captured before upload",
      logExcerpt: failLog,
      runUrl: process.env.GITHUB_RUN_URL,
      sha: process.env.GITHUB_SHA,
      repo: process.env.GITHUB_REPOSITORY,
      failedVersionId: deployed || null,
    });
    setOutput("notified", String(await notifyDiscord(msg)));
    log("::error::no rollback target was captured; mcp.ko.io is serving an unverified version");
    return 22;
  }

  const argv = buildRollbackArgv(previous, { reason: `${summary.firstFailure} failed after deploy` });
  log(`rolling back: ${formatCommand(argv)}`);
  const rb = await wrangler(argv.slice(1), { timeoutMs: ROLLBACK_TIMEOUT_MS });

  // A rollback is not a rollback until the rolled-back Worker is verified.
  const after = await runChecks({ label: "verify-rollback", attempts: ATTEMPTS + 1, delayMs: RETRY_DELAY_MS });
  const rolledBackOk = rb.code === 0 && after.summary.ok;

  const excerpt = [
    "-- failed deploy checks --",
    failLog,
    `-- rollback (${rb.timedOut ? "TIMED OUT" : `exit ${rb.code}`}) --`,
    truncate(rb.output, 600).text,
    "-- post-rollback checks --",
    after.summary.lines.join("\n"),
  ].join("\n");

  const msg = buildDiscordMessage({
    outcome: rolledBackOk ? "rolled_back" : "rollback_failed",
    rolledBackTo: previous,
    failedCheck: summary.firstFailure,
    checkDetail: summary.lines.find((l) => l.startsWith("FAIL")) ?? "",
    logExcerpt: excerpt,
    runUrl: process.env.GITHUB_RUN_URL,
    sha: process.env.GITHUB_SHA,
    repo: process.env.GITHUB_REPOSITORY,
    failedVersionId: deployed || null,
  });
  setOutput("outcome", rolledBackOk ? "rolled_back" : "rollback_failed");
  setOutput("rolled_back_to", previous);
  setOutput("failed_check", summary.firstFailure ?? "");
  setOutput("notified", String(await notifyDiscord(msg)));

  if (rolledBackOk) {
    log(`::error::deploy failed ${summary.firstFailure}; rolled back to ${previous} and verified healthy`);
    return 20;
  }
  log(`::error::ROLLBACK DID NOT RESTORE A HEALTHY SERVICE (rollback exit ${rb.code}); mcp.ko.io needs a human`);
  return 21;
}

// --- entrypoint ------------------------------------------------------------

const COMMANDS = { capture: cmdCapture, upload: cmdUpload, deploy: cmdDeploy, verify: cmdVerify };

const command = process.argv[2];
const handler = COMMANDS[command];
if (!handler) {
  log(`usage: node scripts/deploy-guard.mjs <${Object.keys(COMMANDS).join("|")}>`);
  process.exit(2);
}
log(`deploy-guard: ${command} (worker=${WORKER_NAME}, base=${MCP_BASE}, min_tools=${MIN_TOOLS})`);
handler()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`::error::${err?.stack ?? err}`);
    process.exit(1);
  });
