/**
 * End-to-end REHEARSAL of the auto-rollback path.
 *
 * The workflow YAML can never be executed locally, and GitHub Actions is down
 * for this account, so "the rollback works" would otherwise be an assertion
 * about code nobody has ever run. This test actually runs
 * `scripts/deploy-guard.mjs verify` as a child process against:
 *
 *   - a FAKE wrangler CLI (a temp .mjs that records its argv), and
 *   - a loopback HTTP server standing in for mcp.ko.io.
 *
 * No external network: only 127.0.0.1 and a child process. What is proven here
 * is the wiring -- a failed check triggers exactly one rollback, with the exact
 * argv, against the version captured before the upload; the rollback is then
 * re-verified; and the exit code distinguishes "rolled back and healthy" from
 * "rolled back and still broken".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = path.join(SERVER_DIR, "scripts", "deploy-guard.mjs");

const PREV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dir;
let rollbackLog;
let stateFile;
let baseUrl;
let http;

/** Tool count the fake mcp.ko.io reports; the fake wrangler rewrites it on rollback. */
function setToolCount(n) {
  writeFileSync(stateFile, String(n));
}
const toolCount = () => Number(readFileSync(stateFile, "utf8"));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-guard-"));
  rollbackLog = path.join(dir, "rollback.argv");
  stateFile = path.join(dir, "tools.count");
  writeFileSync(rollbackLog, "");
  setToolCount(24);

  // Fake wrangler: records rollback argv and, when told to, "heals" the Worker.
  writeFileSync(
    path.join(dir, "fake-wrangler.mjs"),
    `
import { appendFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const LOG = ${JSON.stringify(rollbackLog)};
const STATE = ${JSON.stringify(stateFile)};
if (argv[0] === "deployments" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ id: "dep-1", created_on: "2026-09-12T00:00:00Z",
    versions: [{ version_id: ${JSON.stringify(PREV)}, percentage: 100 }] }));
} else if (argv[0] === "versions" && argv[1] === "upload") {
  process.stdout.write("Total Upload: 1 KiB\\nWorker Version ID: ${NEW}\\n");
} else if (argv[0] === "versions" && argv[1] === "deploy") {
  process.stdout.write("Deployed ko-mcp-server\\n");
} else if (argv[0] === "rollback") {
  appendFileSync(LOG, JSON.stringify(argv) + "\\n");
  if (process.env.FAKE_ROLLBACK_HEALS === "1") writeFileSync(STATE, "24");
  if (process.env.FAKE_ROLLBACK_FAILS === "1") { process.stderr.write("rollback exploded\\n"); process.exit(1); }
  process.stdout.write("Worker Version ${PREV} has been deployed to 100% of traffic.\\n");
} else {
  process.stderr.write("unexpected argv: " + argv.join(" ") + "\\n");
  process.exit(64);
}
`,
  );

  http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "ko-mcp-server" }));
      return;
    }
    if (req.url === "/mcp") {
      const tools = Array.from({ length: toolCount() }, (_, i) => ({ name: `tool_${i}` }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${http.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
});

function runGuard(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const outFile = path.join(dir, `gh-output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outFile, "");
    const child = spawn(process.execPath, [GUARD, ...args], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        MCP_BASE: baseUrl,
        DEPLOY_GUARD_WRANGLER: `${process.execPath} ${path.join(dir, "fake-wrangler.mjs")}`,
        DEPLOY_GUARD_ATTEMPTS: "2",
        DEPLOY_GUARD_DELAY_MS: "10",
        GITHUB_OUTPUT: outFile,
        DISCORD_WEBHOOK_DEPLOYS: "", // unset -> the message is logged, not posted
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out, outputs: readFileSync(outFile, "utf8") }));
  });
}

const rollbackCalls = () =>
  readFileSync(rollbackLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("deploy guard rehearsal", () => {
  it("capture prints a runnable rollback command BEFORE anything changes", async () => {
    const res = await runGuard(["capture"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("ROLLBACK PLAN");
    expect(res.out).toContain(`npx wrangler rollback ${PREV}`);
    expect(res.out).toContain("CI=1");
    expect(res.out).toContain("never deleted");
    expect(res.outputs).toContain(`previous_version_id=${PREV}`);
    expect(res.outputs).toContain("rollback_available=true");
  });

  it("upload parses the version id without grep -oP", async () => {
    const res = await runGuard(["upload"]);
    expect(res.code).toBe(0);
    expect(res.outputs).toContain(`version_id=${NEW}`);
  });

  it("passes cleanly and performs NO rollback when the checks are green", async () => {
    setToolCount(24);
    writeFileSync(rollbackLog, "");
    const res = await runGuard(["verify", "--deployed", NEW, "--previous", PREV]);
    expect(res.code).toBe(0);
    expect(rollbackCalls()).toHaveLength(0);
    expect(res.outputs).toContain("outcome=success");
    expect(res.out).toContain("gate counts: total=3 passed=2 failed=0 skipped=1");
  });

  it("rolls back exactly once, with the pinned argv, when tools/list drops below 24", async () => {
    setToolCount(12);
    writeFileSync(rollbackLog, "");
    const res = await runGuard(["verify", "--deployed", NEW, "--previous", PREV], { FAKE_ROLLBACK_HEALS: "1" });

    const calls = rollbackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "rollback",
      PREV,
      "--name",
      "ko-mcp-server",
      "--message",
      "auto-rollback: tools_list failed after deploy",
      "--yes",
    ]);
    expect(calls[0]).not.toContain("versions");

    // rolled back AND re-verified healthy
    expect(res.code).toBe(20);
    expect(res.outputs).toContain("outcome=rolled_back");
    expect(res.outputs).toContain(`rolled_back_to=${PREV}`);
    expect(res.outputs).toContain("failed_check=tools_list");
    expect(res.out).toContain("[verify-rollback] PASS tools_list: 24 tools");
    expect(res.out).toContain("MCP DEPLOY ROLLED BACK");
    expect(res.out).toContain(NEW); // failed version named, kept for forensics
    expect(toolCount()).toBe(24);
  });

  it("fails the job with a distinct code when the rollback does NOT restore health", async () => {
    setToolCount(3);
    writeFileSync(rollbackLog, "");
    const res = await runGuard(["verify", "--deployed", NEW, "--previous", PREV]); // no heal

    expect(rollbackCalls()).toHaveLength(1);
    expect(res.code).toBe(21);
    expect(res.outputs).toContain("outcome=rollback_failed");
    expect(res.out).toContain("ROLLBACK DID NOT RESTORE A HEALTHY SERVICE");
  });

  it("refuses to invent a rollback target when none was captured", async () => {
    setToolCount(1);
    writeFileSync(rollbackLog, "");
    const res = await runGuard(["verify", "--deployed", NEW, "--previous"]);
    expect(rollbackCalls()).toHaveLength(0);
    expect(res.code).toBe(22);
    expect(res.outputs).toContain("outcome=no_rollback_target");
  });
});
