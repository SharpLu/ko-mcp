/**
 * Unit tests for the deploy auto-rollback guard.
 *
 * Written as .mjs (not .ts) on purpose: the module under test is plain ESM so
 * that the SAME file the deploy workflow executes is the file these tests
 * import -- no build step, no second copy of the logic that could drift from
 * the one that actually runs in CI. tsconfig only includes src/**\/*.ts, so
 * this file is exercised by vitest and ignored by tsc.
 *
 * The last describe() block lints the workflow YAML itself, because YAML can
 * never be executed locally: the shell shapes that have bitten this org are
 * asserted as text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DISCORD_CONTENT_LIMIT,
  DeployGuardError,
  MIN_TOOLS,
  NON_INTERACTIVE_ENV,
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
} from "../../scripts/lib/deploy-guard.mjs";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const WORKFLOW = read("../../../.github/workflows/deploy-server.yml");
const RUNNER = read("../../scripts/deploy-guard.mjs");
const LIB = read("../../scripts/lib/deploy-guard.mjs");

/** Strip comments so the "forbidden command" guards lint code, not prose. */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join("\n");
const EXECUTABLE = [codeOnly(WORKFLOW), codeOnly(RUNNER), codeOnly(LIB)];

// ---------------------------------------------------------------------------

describe("pickServingVersion (the rollback target, captured pre-upload)", () => {
  it("returns the version serving 100% of traffic", () => {
    const got = pickServingVersion({
      id: "dep-1",
      created_on: "2026-09-12T00:00:00Z",
      versions: [{ version_id: V1, percentage: 100 }],
    });
    expect(got.versionId).toBe(V1);
    expect(got.percentage).toBe(100);
    expect(got.split).toBe(false);
    expect(got.deploymentId).toBe("dep-1");
  });

  it("picks the largest share and flags a gradual (split) deployment", () => {
    const got = pickServingVersion({
      versions: [
        { version_id: V1, percentage: 10 },
        { version_id: V2, percentage: 90 },
      ],
    });
    expect(got.versionId).toBe(V2);
    expect(got.split).toBe(true);
  });

  it("throws rather than guessing when there is no deployment to roll back to", () => {
    expect(() => pickServingVersion(null)).toThrow(DeployGuardError);
    expect(() => pickServingVersion({})).toThrow(/no versions/);
    expect(() => pickServingVersion({ versions: [] })).toThrow(/no versions/);
    expect(() => pickServingVersion({ versions: [{ percentage: 100 }] })).toThrow(/no usable version_id/);
  });
});

describe("readVersionsList (ordering assumption is asserted, not assumed)", () => {
  const row = (id, createdOn) => ({ id, metadata: { created_on: createdOn } });

  it("treats the LAST element as newest, matching wrangler 4.100.0's ascending sort", () => {
    const got = readVersionsList([
      row(V1, "2026-09-10T00:00:00Z"),
      row(V2, "2026-09-11T00:00:00Z"),
      row(V3, "2026-09-12T00:00:00Z"),
    ]);
    expect(got.newestId).toBe(V3);
    expect(got.count).toBe(3);
    expect(got.ascendingByCreatedOn).toBe(true);
    expect(got.positionalLastIsNewest).toBe(true);
  });

  it("detects an inverted order instead of silently rolling back to the wrong version", () => {
    const got = readVersionsList([
      row(V3, "2026-09-12T00:00:00Z"),
      row(V2, "2026-09-11T00:00:00Z"),
      row(V1, "2026-09-10T00:00:00Z"),
    ]);
    expect(got.ascendingByCreatedOn).toBe(false);
    expect(got.positionalLastIsNewest).toBe(false);
    expect(got.newestId).toBe(V3); // derived from timestamps, not position
  });

  it("survives an empty list", () => {
    expect(readVersionsList([]).newestId).toBeNull();
    expect(readVersionsList(null).count).toBe(0);
  });
});

describe("parseUploadedVersionId", () => {
  it("extracts the id from real wrangler upload output", () => {
    const log = [
      "Total Upload: 412.55 KiB / gzip: 78.12 KiB",
      `Worker Version ID: ${V2}`,
      "To deploy this version to production traffic use the command wrangler versions deploy",
    ].join("\n");
    expect(parseUploadedVersionId(log)).toBe(V2);
  });

  it("throws loudly (with a size) when the id is absent, instead of returning empty", () => {
    expect(() => parseUploadedVersionId("no id here")).toThrow(/could not find/i);
    expect(() => parseUploadedVersionId("")).toThrow(DeployGuardError);
  });
});

// ---------------------------------------------------------------------------

describe("buildRollbackArgv (the pinned, non-interactive invocation)", () => {
  it("is `wrangler rollback <id>` -- NOT `wrangler versions rollback`, which does not exist", () => {
    const argv = buildRollbackArgv(V1, { reason: "tools_list failed" });
    expect(argv[0]).toBe("wrangler");
    expect(argv[1]).toBe("rollback");
    expect(argv[2]).toBe(V1);
    expect(argv.join(" ")).not.toContain("versions rollback");
    expect(argv).toContain("--yes");
    expect(argv).toContain("--name");
    expect(argv[argv.indexOf("--name") + 1]).toBe(WORKER_NAME);
    expect(argv[argv.indexOf("--message") + 1]).toMatch(/^auto-rollback: tools_list failed$/);
  });

  it("caps the --message at wrangler's 120-char prompt limit", () => {
    const argv = buildRollbackArgv(V1, { reason: "x".repeat(500) });
    expect(argv[argv.indexOf("--message") + 1].length).toBeLessThanOrEqual(120);
  });

  it("refuses anything that is not a version id (an empty capture must not become a rollback)", () => {
    expect(() => buildRollbackArgv("")).toThrow(DeployGuardError);
    expect(() => buildRollbackArgv("latest")).toThrow(/non-version-id/);
    expect(() => buildRollbackArgv(undefined)).toThrow(DeployGuardError);
  });

  it("prints as a command a human can paste, carrying the CI=1 that makes it non-interactive", () => {
    const cmd = formatCommand(buildRollbackArgv(V1, { reason: "health failed" }));
    expect(cmd).toContain("CI=1");
    expect(cmd).toContain("npx wrangler rollback");
    expect(cmd).toContain(V1);
    expect(cmd).toContain("'auto-rollback: health failed'");
  });

  it("pins CI=1, because `wrangler rollback`'s handler never reads --yes", () => {
    expect(NON_INTERACTIVE_ENV.CI).toBe("1");
  });
});

// ---------------------------------------------------------------------------

describe("post-deploy checks", () => {
  it("health passes only on 2xx + status:ok", () => {
    expect(evaluateHealth(200, '{"status":"ok","service":"ko-mcp-server"}').ok).toBe(true);
    expect(evaluateHealth(200, '{"status":"degraded"}').ok).toBe(false);
    expect(evaluateHealth(500, '{"status":"ok"}').ok).toBe(false);
    expect(evaluateHealth(200, "<html>523</html>").ok).toBe(false);
  });

  const toolsBody = (n) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}` })) } });

  it("tools/list needs at least 24 and reports the count it examined", () => {
    const pass = evaluateTools(200, toolsBody(24));
    expect(pass.ok).toBe(true);
    expect(pass.count).toBe(MIN_TOOLS);
    expect(pass.examined).toBe(24);

    const fail = evaluateTools(200, toolsBody(23));
    expect(fail.ok).toBe(false);
    expect(fail.detail).toContain("23 tools");
  });

  it("an empty tool list is a FAIL, not a pass -- a gate that examined nothing is not a pass", () => {
    const got = evaluateTools(200, toolsBody(0));
    expect(got.ok).toBe(false);
    expect(got.examined).toBe(0);
  });

  it("reads SSE-framed Streamable HTTP responses", () => {
    const sse = `event: message\ndata: ${toolsBody(24)}\n\n`;
    expect(evaluateTools(200, sse).count).toBe(24);
  });

  it("fails on a JSON-RPC error body or garbage instead of throwing out of the job", () => {
    const err = evaluateTools(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }));
    expect(err.ok).toBe(false);
    expect(err.detail).toContain("JSON-RPC error");
    expect(evaluateTools(200, "not json").ok).toBe(false);
    expect(evaluateTools(502, "").ok).toBe(false);
  });
});

describe("golden contract (wave M1) degrades gracefully", () => {
  it("is SKIPPED, not failed, when no runner exists yet", () => {
    const resolved = resolveGoldenContract({ candidates: ["/nope.mjs"], exists: () => false });
    expect(resolved.available).toBe(false);
    const check = evaluateGolden(resolved, null);
    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(true);
    expect(check.examined).toBe(0);
  });

  it("uses an explicit command override when one is provided", () => {
    const resolved = resolveGoldenContract({ envCmd: "npm run golden", exists: () => true, candidates: ["/x.mjs"] });
    expect(resolved).toMatchObject({ available: true, kind: "command", command: "npm run golden" });
  });

  it("prefers the first existing candidate script and fails on a non-zero exit", () => {
    const resolved = resolveGoldenContract({ candidates: ["/a.mjs", "/b.mjs"], exists: (p) => p === "/b.mjs" });
    expect(resolved).toMatchObject({ available: true, kind: "script", command: "/b.mjs" });
    expect(evaluateGolden(resolved, { code: 1, examined: 488, detail: "exit 1" })).toMatchObject({
      ok: false,
      skipped: false,
      examined: 488,
    });
    expect(evaluateGolden(resolved, { code: 0, examined: 488 }).ok).toBe(true);
  });
});

describe("summarizeChecks", () => {
  const mk = (name, ok, extra = {}) => ({ name, ok, examined: 1, detail: "d", ...extra });

  it("reports the first failure and the counts each gate produced", () => {
    const s = summarizeChecks([mk("health", true), mk("tools_list", false), mk("golden_contract", true, { skipped: true })]);
    expect(s.ok).toBe(false);
    expect(s.firstFailure).toBe("tools_list");
    expect(s.counts).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(s.lines[0]).toMatch(/^PASS health/);
    expect(s.lines[1]).toMatch(/^FAIL tools_list/);
    expect(s.lines[2]).toMatch(/^SKIP golden_contract/);
  });

  it("is green only when nothing failed", () => {
    expect(summarizeChecks([mk("health", true), mk("tools_list", true)]).ok).toBe(true);
    expect(summarizeChecks([]).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Discord message is bounded at 2000 chars and says so", () => {
  it("truncate() announces how much it dropped", () => {
    const got = truncate("y".repeat(5000), 200);
    expect(got.text.length).toBeLessThanOrEqual(200);
    expect(got.truncated).toBe(true);
    expect(got.original).toBe(5000);
    expect(got.text).toContain("truncated");
    expect(got.text).toContain("of 5000 chars");
  });

  it("truncate() leaves short text alone", () => {
    expect(truncate("short", 200)).toEqual({ text: "short", truncated: false, original: 5 });
    expect(truncate("abc", 0).text).toBe("");
  });

  it("never exceeds Discord's content limit, even with a 100KB log", () => {
    const msg = buildDiscordMessage({
      outcome: "rolled_back",
      rolledBackTo: V1,
      failedCheck: "tools_list",
      checkDetail: "FAIL tools_list: 12 tools (need >= 24)",
      logExcerpt: "L".repeat(100_000),
      runUrl: "https://github.com/SharpLu/ko-mcp/actions/runs/1",
      sha: "abcdef1234567890",
      repo: "SharpLu/ko-mcp",
      failedVersionId: V2,
    });
    expect(msg.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(msg.truncated).toBe(true);
    expect(msg.content).toContain("truncated");
    expect(msg.originalLogLength).toBe(100_000);
  });

  it("carries the three facts a responder needs: version rolled back to, failed check, excerpt", () => {
    const msg = buildDiscordMessage({
      outcome: "rolled_back",
      rolledBackTo: V1,
      failedCheck: "health",
      logExcerpt: "FAIL health: HTTP 523",
      failedVersionId: V2,
    });
    expect(msg.content).toContain(V1);
    expect(msg.content).toContain("health");
    expect(msg.content).toContain("FAIL health: HTTP 523");
    expect(msg.content).toContain(V2);
    expect(msg.content).toContain("never deleted");
    expect(msg.truncated).toBe(false);
  });

  it("says plainly when the rollback itself failed", () => {
    const msg = buildDiscordMessage({ outcome: "rollback_failed", rolledBackTo: null, failedCheck: "health" });
    expect(msg.content).toContain("ROLLBACK FAILED");
    expect(msg.content).toContain("no rollback target captured");
  });
});

describe("githubOutputEntry", () => {
  it("writes single-line values plainly", () => {
    expect(githubOutputEntry("version_id", V1, "d")).toBe(`version_id=${V1}\n`);
  });

  it("uses a heredoc for multi-line values", () => {
    expect(githubOutputEntry("log", "a\nb", "DELIM")).toBe("log<<DELIM\na\nb\nDELIM\n");
  });

  it("refuses a value that could forge another output by embedding the delimiter", () => {
    expect(() => githubOutputEntry("log", "a\nDELIM\noutcome=success", "DELIM")).toThrow(/collides/);
    expect(() => githubOutputEntry("bad key", "v", "D")).toThrow(/invalid GITHUB_OUTPUT key/);
  });
});

// ---------------------------------------------------------------------------
// The workflow YAML can never be executed locally. These assertions are the
// only thing standing between it and the three shell shapes that have bitten
// this org, so they are asserted as text.
// ---------------------------------------------------------------------------

const runBlocks = (yaml) => {
  const blocks = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- name:.*\n)?\s*run:\s*\|\s*$/);
    if (!m) continue;
    const indent = lines[i].indexOf("run:");
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "" && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
};

describe("deploy-server.yml shell shape", () => {
  it("parses into at least one run: block (a scan that examined nothing is not a pass)", () => {
    expect(runBlocks(WORKFLOW).length).toBeGreaterThan(0);
  });

  it("never uses `x=$(cmd); rc=$?` -- unreachable under set -e", () => {
    expect(WORKFLOW).not.toMatch(/=\$\([^\n]*\)\s*;\s*[A-Za-z_][A-Za-z0-9_]*=\$\?/);
    expect(WORKFLOW).not.toMatch(/\n\s*[A-Za-z_][A-Za-z0-9_]*=\$\?/);
  });

  it("never reads PIPESTATUS -- `cmd | tee || rc=$?` resets it", () => {
    expect(WORKFLOW).not.toContain("PIPESTATUS");
  });

  it("captures every exit code in the `rc=0; x=$(...) || rc=$?` shape", () => {
    for (const block of runBlocks(WORKFLOW)) {
      const captures = block.match(/[A-Za-z_][A-Za-z0-9_]*=\$\?/g) ?? [];
      for (const cap of captures) {
        const varName = cap.split("=")[0];
        // every `rc=$?` must be preceded by `||` on the same line ...
        const lineWithCapture = block.split("\n").find((l) => l.includes(cap));
        expect(lineWithCapture).toMatch(new RegExp(String.raw`\|\|\s*${varName}=\$\?`));
        // ... and the variable must be pre-initialised to 0 in the same block.
        expect(block).toMatch(new RegExp(String.raw`^\s*${varName}=0\s*$`, "m"));
      }
    }
  });

  it("does not use `grep -oP` (GNU-only; breaks on a BSD/macOS self-hosted runner)", () => {
    expect(WORKFLOW).not.toMatch(/grep\s+[^\n|]*-[a-zA-Z]*P/);
  });
});

describe("deploy-server.yml rollback wiring", () => {
  it("never invokes `wrangler versions rollback`, which does not exist in wrangler 4.100.0", () => {
    for (const text of EXECUTABLE) {
      expect(text).not.toMatch(/wrangler["\s,]+versions["\s,]+rollback/);
    }
  });

  it("never deletes a version -- the failed version stays in history for forensics", () => {
    for (const text of EXECUTABLE) {
      expect(text).not.toMatch(/versions\s+delete/);
      expect(text).not.toMatch(/wrangler\s+delete/);
    }
  });

  it("captures the rollback target BEFORE the upload step", () => {
    const capture = WORKFLOW.indexOf("deploy-guard.mjs capture");
    const upload = WORKFLOW.indexOf("deploy-guard.mjs upload");
    expect(capture).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(upload);
  });

  it("passes the captured previous version into verify, and runs verify after deploy", () => {
    const deploy = WORKFLOW.indexOf("deploy-guard.mjs deploy");
    const verify = WORKFLOW.indexOf("deploy-guard.mjs verify");
    expect(deploy).toBeLessThan(verify);
    expect(WORKFLOW).toMatch(/deploy-guard\.mjs verify[\s\S]{0,300}--previous \$\{\{ steps\.capture\.outputs\.previous_version_id \}\}/);
  });

  it("gives the verify step the Discord webhook, so the rollback notice is sent from where it happens", () => {
    expect(WORKFLOW).toMatch(/DISCORD_WEBHOOK_DEPLOYS:\s*\$\{\{ secrets\.DISCORD_WEBHOOK_DEPLOYS \}\}/);
  });
});
