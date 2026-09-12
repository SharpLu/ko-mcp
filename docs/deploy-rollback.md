# mcp.ko.io deploy rollback — runbook

The deploy pipeline (`.github/workflows/deploy-server.yml`) rolls itself back.
This page is what you do when the automation is the thing that broke.

## What the pipeline does

| Step | Command | Why |
|------|---------|-----|
| capture | `node scripts/deploy-guard.mjs capture` | Reads `wrangler deployments status --json` **before the upload** and prints the full rollback command to the log. `versions list` answers "what was uploaded", not "what is serving" — and after the upload the new version is in the list, so any positional "previous" assumption inverts. |
| upload | `... upload` | `wrangler versions upload`, version id parsed in JS (not `grep -oP`, which is GNU-only and dies on a BSD/macOS self-hosted runner). |
| deploy | `... deploy --version-id <id>` | `wrangler versions deploy <id>@100% -y`. |
| verify | `... verify --deployed <id> --previous <id>` | `/health`, `tools/list >= 24`, golden contract (wave M1 — SKIPPED, never silently passed, until its runner exists). On failure: roll back, **re-verify the rolled-back Worker**, post to Discord `#deploys`, exit non-zero. |

Exit codes from `verify`: `0` green · `20` rolled back and verified healthy ·
`21` rolled back but still unhealthy · `22` no rollback target was captured.
Anything other than 0 fails the job — a deploy that had to be rolled back is
not a successful deploy.

The failed version is **never deleted**. It stays in `npx wrangler versions
list` for forensics; a test asserts nothing in the pipeline deletes a version.

## Manual rollback (automation failed, or you want it now)

```bash
cd server
npm ci                                   # wrangler is a devDependency, pinned 4.100.0
export CLOUDFLARE_API_TOKEN=...          # or `npx wrangler login`
export CLOUDFLARE_ACCOUNT_ID=...

# 1. what is serving right now
CI=1 npx wrangler deployments status --json --name ko-mcp-server

# 2. candidate versions (ASCENDING by created_on -- newest is LAST)
CI=1 npx wrangler versions list --json --name ko-mcp-server

# 3. roll back
CI=1 WRANGLER_SEND_METRICS=false npx wrangler rollback <VERSION_ID> \
  --name ko-mcp-server --message 'manual rollback: <why>' --yes

# 4. verify -- a rollback that is not verified is not a rollback
curl -sS https://mcp.ko.io/health
curl -sS -X POST https://mcp.ko.io/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))'   # must be >= 24
```

### Two traps, both verified against wrangler 4.100.0

1. **There is no `wrangler versions rollback`.** `wrangler versions` exposes
   view / list / upload / deploy / secret only. `wrangler versions rollback <id>`
   exits 1 with `Unknown arguments: rollback, <id>` — it prints help and changes
   nothing. The real command is the **top-level** `wrangler rollback [version-id]`.
2. **`--yes` does nothing on `wrangler rollback`.** The flag is declared but the
   handler never reads it; the command still calls `prompt()` and `confirm()`.
   What actually stops it blocking is wrangler's `isNonInteractiveOrCI()`
   (`ci-info`), so **`CI=1` is the load-bearing part**. We pass both, and the
   runner additionally kills the process after 5 minutes so a hang becomes a
   failure instead of a stuck job.

If `wrangler rollback` refuses because secrets changed since that version was
deployed, it asks for confirmation; under `CI=1` that confirmation auto-answers
yes. If it still refuses, deploy the old version explicitly:

```bash
CI=1 npx wrangler versions deploy <VERSION_ID>@100% -y --name ko-mcp-server
```

## Where the behaviour is tested

`server/src/__tests__/deploy-guard.test.mjs` (unit) and
`deploy-guard.rehearsal.test.mjs` (runs `deploy-guard.mjs verify` against a fake
wrangler and a loopback Worker, and asserts the exact rollback argv). The YAML
itself is linted as text by the same suite: no `x=$(cmd); rc=$?`, no
`PIPESTATUS`, no `grep -oP`, no `versions rollback`, no version deletion,
capture-before-upload ordering.
