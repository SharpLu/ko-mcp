/**
 * Pure decision logic for the mcp.ko.io deploy guard (auto-rollback).
 *
 * Everything here is side-effect free and unit-tested by
 * `server/src/__tests__/deploy-guard.test.mjs`. The I/O shell (spawning
 * wrangler, fetching mcp.ko.io, posting to Discord, writing $GITHUB_OUTPUT)
 * lives in `server/scripts/deploy-guard.mjs` and is deliberately thin, because
 * workflow YAML can never be executed locally and neither can a runner-only
 * side effect -- so as little behaviour as possible is allowed to live there.
 *
 * Verified facts this module encodes (wrangler 4.100.0, pinned in
 * server/package-lock.json):
 *
 *   1. There is NO `wrangler versions rollback` subcommand. `wrangler versions`
 *      exposes view/list/upload/deploy/secret only; `wrangler versions rollback
 *      <id>` exits 1 with "Unknown arguments: rollback, <id>". The real command
 *      is the TOP-LEVEL `wrangler rollback [version-id]`.
 *   2. `wrangler rollback` declares `-y/--yes` but its handler NEVER reads it.
 *      Non-interactivity comes exclusively from wrangler's
 *      `isNonInteractiveOrCI()` (ci-info): in CI, `confirm()` returns its
 *      fallback (yes) and `prompt()` returns its default. So the thing that
 *      actually stops the job hanging is CI=1 in the environment, not `--yes`.
 *      We pass both, plus a hard timeout in the runner.
 *   3. `wrangler versions list --json` is sorted ASCENDING by created_on and
 *      sliced to the last 10 -- the NEWEST version is LAST, not first. It also
 *      lists *uploaded* versions, which is not the same question as "what is
 *      serving traffic right now". The rollback target must come from
 *      `wrangler deployments status --json`, which reports the live traffic
 *      split. Both readings are implemented here so the assumption is testable.
 */

export const WORKER_NAME = "ko-mcp-server";
export const MIN_TOOLS = 24;

/** Discord's hard cap for a message `content` field. */
export const DISCORD_CONTENT_LIMIT = 2000;

/**
 * Environment that makes `wrangler rollback` non-interactive.
 * CI=1 is load-bearing (see note 2 above); WRANGLER_SEND_METRICS keeps the
 * metrics prompt out of a rollback path that must never block.
 */
export const NON_INTERACTIVE_ENV = Object.freeze({
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
});

/** Milliseconds before the runner kills a wrangler invocation. */
export const ROLLBACK_TIMEOUT_MS = 300_000;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class DeployGuardError extends Error {}

// ---------------------------------------------------------------------------
// Capturing the rollback target
// ---------------------------------------------------------------------------

/**
 * Pick the version that is serving traffic right now, from the JSON of
 * `wrangler deployments status --json`.
 *
 * Shape (wrangler 4.100.0):
 *   { id, created_on, author_email, source, annotations,
 *     versions: [{ version_id, percentage }, ...] }
 *
 * A gradual deploy can have several versions live at once. There is no single
 * "previous" in that case, so we take the largest share and flag `split` -- the
 * caller reports it, because rolling a split deployment back to one version is
 * a real change of state and must not look like a no-op.
 *
 * @param {unknown} status parsed JSON
 * @returns {{versionId: string, percentage: number, split: boolean, deploymentId: string|null, createdOn: string|null}}
 */
export function pickServingVersion(status) {
  if (!status || typeof status !== "object") {
    throw new DeployGuardError(
      "deployments status --json produced no object; cannot determine a rollback target",
    );
  }
  const versions = /** @type {any} */ (status).versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new DeployGuardError(
      "deployments status --json has no versions[]; the Worker has never been deployed, so there is nothing to roll back to",
    );
  }
  const ranked = versions
    .filter((v) => v && typeof v.version_id === "string" && v.version_id.length > 0)
    .map((v) => ({
      versionId: v.version_id,
      percentage: typeof v.percentage === "number" ? v.percentage : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  if (ranked.length === 0) {
    throw new DeployGuardError(
      "deployments status --json versions[] contained no usable version_id",
    );
  }
  return {
    versionId: ranked[0].versionId,
    percentage: ranked[0].percentage,
    split: ranked.length > 1,
    deploymentId: typeof (/** @type {any} */ (status).id) === "string" ? /** @type {any} */ (status).id : null,
    createdOn:
      typeof (/** @type {any} */ (status).created_on) === "string"
        ? /** @type {any} */ (status).created_on
        : null,
  };
}

/**
 * Read `wrangler versions list --json` WITHOUT trusting array position.
 *
 * wrangler sorts ascending by metadata.created_on, so "newest" is the LAST
 * element -- the opposite of the usual assumption, and an assumption that would
 * silently invert if wrangler ever changed the sort. We therefore re-derive the
 * newest by timestamp and report whether the positional assumption still holds,
 * so a future wrangler bump shows up as a loud mismatch instead of a rollback
 * to the wrong version.
 *
 * This is diagnostic only: the rollback target comes from pickServingVersion().
 *
 * @param {unknown} list parsed JSON from `wrangler versions list --json`
 */
export function readVersionsList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { newestId: null, count: 0, ascendingByCreatedOn: true, positionalLastIsNewest: true };
  }
  const rows = list
    .filter((v) => v && typeof v.id === "string")
    .map((v) => ({ id: v.id, createdOn: String(v?.metadata?.created_on ?? "") }));

  let ascending = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].createdOn.localeCompare(rows[i].createdOn) > 0) ascending = false;
  }
  const byTime = [...rows].sort((a, b) => a.createdOn.localeCompare(b.createdOn));
  const newest = byTime[byTime.length - 1];
  return {
    newestId: newest ? newest.id : null,
    count: rows.length,
    ascendingByCreatedOn: ascending,
    positionalLastIsNewest: rows.length > 0 && newest.id === rows[rows.length - 1].id,
  };
}

/**
 * Extract the uploaded version id from `wrangler versions upload` output.
 *
 * Parsed in JS rather than `grep -oP`, because -P is a GNU extension: on a
 * self-hosted macOS/BSD runner `grep -oP` fails, and a failed parse in the
 * middle of a deploy pipeline is exactly the hazard this whole change exists
 * to remove.
 *
 * @param {string} logText combined stdout+stderr of the upload
 * @returns {string} version id
 */
export function parseUploadedVersionId(logText) {
  const text = String(logText ?? "");
  const labelled = text.match(new RegExp(String.raw`Worker Version ID:\s*(${UUID_RE.source})`, "i"));
  if (labelled) return labelled[1];
  throw new DeployGuardError(
    `could not find "Worker Version ID: <uuid>" in wrangler upload output (${text.length} chars captured)`,
  );
}

// ---------------------------------------------------------------------------
// The rollback invocation itself
// ---------------------------------------------------------------------------

/**
 * The pinned, non-interactive rollback invocation.
 *
 * `wrangler rollback <id>` (top level) -- NOT `wrangler versions rollback`,
 * which does not exist in wrangler 4.100.0.
 *
 * @param {string} versionId version to restore
 * @param {{reason?: string}} [opts]
 * @returns {string[]} argv for `npx`
 */
export function buildRollbackArgv(versionId, opts = {}) {
  if (!UUID_RE.test(String(versionId ?? ""))) {
    throw new DeployGuardError(`refusing to roll back to a non-version-id value: ${JSON.stringify(versionId)}`);
  }
  const reason = truncate(opts.reason || "post-deploy check failed", 100).text;
  return [
    "wrangler",
    "rollback",
    versionId,
    "--name",
    WORKER_NAME,
    "--message",
    `auto-rollback: ${reason}`,
    "--yes",
  ];
}

/** Render an argv as the copy-pasteable command a human would run. */
export function formatCommand(argv) {
  const env = Object.entries(NON_INTERACTIVE_ENV)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const parts = argv.map((a) => (/^[A-Za-z0-9._@%+=:,/-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`));
  return `${env} npx ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Post-deploy checks
// ---------------------------------------------------------------------------

/** @param {number} status @param {string} body */
export function evaluateHealth(status, body) {
  const text = String(body ?? "");
  let ok = status >= 200 && status < 300;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body -> handled below */
  }
  if (ok && (!parsed || parsed.status !== "ok")) ok = false;
  return {
    name: "health",
    ok,
    examined: 1,
    detail: ok
      ? `HTTP ${status} status=ok service=${parsed?.service ?? "?"}`
      : `HTTP ${status} body=${truncate(text, 200).text}`,
  };
}

/**
 * Count tools in a `tools/list` response body. The Worker speaks Streamable
 * HTTP, so the body may be raw JSON or SSE-framed (`data: {...}`).
 * @param {string} body
 * @returns {number}
 */
export function countToolsFromBody(body) {
  const text = String(body ?? "").trim();
  const jsonStr = text.startsWith("{") ? text : (text.match(/data: (\{[\s\S]*\})/)?.[1] ?? text);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DeployGuardError(`tools/list response was not JSON (${text.length} chars)`);
  }
  if (parsed?.error) {
    throw new DeployGuardError(`tools/list returned a JSON-RPC error: ${JSON.stringify(parsed.error).slice(0, 200)}`);
  }
  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new DeployGuardError("tools/list response had no result.tools array");
  }
  return tools.length;
}

/** @param {number} status @param {string} body */
export function evaluateTools(status, body) {
  if (status < 200 || status >= 300) {
    return { name: "tools_list", ok: false, examined: 0, count: 0, detail: `HTTP ${status}` };
  }
  try {
    const count = countToolsFromBody(body);
    return {
      name: "tools_list",
      ok: count >= MIN_TOOLS,
      examined: count,
      count,
      detail: `${count} tools (need >= ${MIN_TOOLS})`,
    };
  } catch (err) {
    return { name: "tools_list", ok: false, examined: 0, count: 0, detail: String(err?.message ?? err) };
  }
}

/**
 * Golden contract check (wave M1). Degrades gracefully: if no runner is
 * present yet the check is SKIPPED, never silently "passed" -- a gate that
 * examined nothing is not a pass, and the summary reports it as skipped so the
 * absence is visible in the log rather than inferred from a green tick.
 *
 * @param {{envCmd?: string|undefined, candidates?: string[], exists?: (p: string) => boolean}} opts
 */
export function resolveGoldenContract(opts = {}) {
  const envCmd = (opts.envCmd || "").trim();
  if (envCmd) return { available: true, kind: "command", command: envCmd };
  const exists = opts.exists || (() => false);
  for (const candidate of opts.candidates || []) {
    if (exists(candidate)) return { available: true, kind: "script", command: candidate };
  }
  return {
    available: false,
    kind: "none",
    command: null,
    reason: "no golden-contract runner found (wave M1 has not landed); check skipped",
  };
}

/** @param {{available: boolean, reason?: string}} resolved @param {{code: number, examined?: number, detail?: string}|null} run */
export function evaluateGolden(resolved, run) {
  if (!resolved.available) {
    return { name: "golden_contract", ok: true, skipped: true, examined: 0, detail: resolved.reason ?? "not available" };
  }
  if (!run) {
    return { name: "golden_contract", ok: false, skipped: false, examined: 0, detail: "runner produced no result" };
  }
  return {
    name: "golden_contract",
    ok: run.code === 0,
    skipped: false,
    examined: typeof run.examined === "number" ? run.examined : 0,
    detail: run.detail ?? `exit ${run.code}`,
  };
}

/**
 * Fold check results into a verdict plus the counts each gate produced.
 * @param {Array<{name: string, ok: boolean, examined?: number, skipped?: boolean, detail?: string}>} checks
 */
export function summarizeChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = list.filter((c) => !c.ok);
  const skipped = list.filter((c) => c.skipped);
  return {
    ok: failed.length === 0,
    firstFailure: failed.length > 0 ? failed[0].name : null,
    failedNames: failed.map((c) => c.name),
    skippedNames: skipped.map((c) => c.name),
    counts: {
      total: list.length,
      passed: list.filter((c) => c.ok && !c.skipped).length,
      failed: failed.length,
      skipped: skipped.length,
    },
    lines: list.map(
      (c) => `${c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail ?? ""} (examined=${c.examined ?? 0})`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/**
 * Truncate to `limit` characters, saying so explicitly in the text itself.
 * Silent truncation is how a 2000-character Discord cap turns into a message
 * that reads as a complete log and is not.
 *
 * @param {string} text
 * @param {number} limit
 */
export function truncate(text, limit) {
  const s = String(text ?? "");
  if (limit <= 0) return { text: "", truncated: s.length > 0, original: s.length };
  if (s.length <= limit) return { text: s, truncated: false, original: s.length };
  const marker = (kept) => `\n... [truncated: showing ${kept} of ${s.length} chars]`;
  // Solve for the kept length such that kept + marker(kept).length <= limit.
  let kept = Math.max(0, limit - marker(limit).length);
  while (kept > 0 && kept + marker(kept).length > limit) kept--;
  return { text: s.slice(0, kept) + marker(kept), truncated: true, original: s.length };
}

/**
 * Build the #deploys payload for an automatic rollback.
 *
 * Guarantees the serialized `content` is <= DISCORD_CONTENT_LIMIT characters
 * and that any dropped log is announced in the message body.
 *
 * @param {{
 *   outcome: "rolled_back" | "rollback_failed",
 *   rolledBackTo: string|null,
 *   failedCheck: string|null,
 *   checkDetail?: string,
 *   logExcerpt?: string,
 *   runUrl?: string,
 *   sha?: string,
 *   repo?: string,
 *   failedVersionId?: string|null,
 * }} input
 */
export function buildDiscordMessage(input) {
  const header =
    input.outcome === "rolled_back"
      ? "MCP DEPLOY ROLLED BACK -- mcp.ko.io"
      : "MCP ROLLBACK FAILED -- mcp.ko.io IS NOT VERIFIED HEALTHY";
  const head = [
    header,
    `repo: ${input.repo ?? "SharpLu/ko-mcp"}  commit: ${(input.sha ?? "").slice(0, 7)}`,
    `failed check: ${input.failedCheck ?? "unknown"}${input.checkDetail ? ` -- ${input.checkDetail}` : ""}`,
    `rolled back to version: ${input.rolledBackTo ?? "(none -- no rollback target captured)"}`,
    `failed version kept for forensics: ${input.failedVersionId ?? "(unknown)"} (never deleted)`,
    input.runUrl ? `run: ${input.runUrl}` : "",
    "--- log excerpt ---",
  ]
    .filter(Boolean)
    .join("\n");

  const tail = "\n--- end excerpt ---";
  const budget = DISCORD_CONTENT_LIMIT - head.length - tail.length - 1;
  const excerpt = truncate(input.logExcerpt ?? "(no log captured)", Math.max(0, budget));
  let content = `${head}\n${excerpt.text}${tail}`;
  if (content.length > DISCORD_CONTENT_LIMIT) {
    // Head alone overflowed (pathological inputs) -- clamp, still announcing it.
    content = truncate(content, DISCORD_CONTENT_LIMIT).text;
  }
  return { content, truncated: excerpt.truncated, originalLogLength: excerpt.original };
}

// ---------------------------------------------------------------------------
// GitHub Actions plumbing
// ---------------------------------------------------------------------------

/**
 * Render a $GITHUB_OUTPUT entry. Multi-line values need a heredoc, and a value
 * that contains the delimiter can forge extra outputs -- so the delimiter is
 * randomised by the caller and validated here rather than trusted.
 *
 * @param {string} key
 * @param {string} value
 * @param {string} delimiter
 */
export function githubOutputEntry(key, value, delimiter) {
  const v = String(value ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new DeployGuardError(`invalid GITHUB_OUTPUT key: ${JSON.stringify(key)}`);
  }
  if (!v.includes("\n")) return `${key}=${v}\n`;
  if (!delimiter || v.includes(delimiter)) {
    throw new DeployGuardError(`GITHUB_OUTPUT value for ${key} collides with its heredoc delimiter`);
  }
  return `${key}<<${delimiter}\n${v}\n${delimiter}\n`;
}
