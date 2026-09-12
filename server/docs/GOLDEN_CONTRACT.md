# The golden contract gate

> Counterpart of ko-api's 488-case gate, for the 24 MCP tools.
> Code: `src/contract/` (harness + manifest + fixtures), `scripts/golden-gate.mjs` (blocking),
> `scripts/golden-capture.mjs` (re-pin), `src/__tests__/contract/golden.test.ts` (offline half).

## 1. What it does, and what it refuses to do

Before this gate, the deploy workflow verified exactly two things after shipping:
`/health` answers, and `tools/list` returns at least 24 names. Both are satisfied
by a Worker that has forgotten how to render a single row. ko-api owns the JSON
these 24 tools read; a renamed field upstream turns every table into a header
with no body, and nothing in this repo would have noticed. That is the shape of
two mart freezes this org has already paid for (2026-06, 2026-07).

The gate replays 71 recorded tool calls against the Worker **built from the
commit under test** and compares the **contract**:

| pinned | not pinned |
|---|---|
| JSON-RPC envelope shape (`result`, `content[]`, `isError`: names and types) | any price, total, share count, rank, weight or CIK |
| the literal `content[].type` values | any date |
| `isError`, exactly | how many rows came back |
| heading words, bold label text, section order | which rows came back |
| every table's column list, character for character | the order of rows |
| table-vs-prose (a table degenerating into a sentence is a failure) | |
| the *class* of an error: `ko.io API error (403): Access forbidden ...` | the variable part of a leaked upstream URL (normalised to `<URL>`) |
| a zod `-32602` validation body, verbatim | |

Values are erased by `normalizeLine`: money, percents, ISO dates, accession
numbers, URLs, and then a backstop that turns **any remaining whitespace-delimited
token containing a digit** into `<VAL>`. Exactly two digit-bearing forms survive,
because both are classes rather than values: `ko.io API error (NNN)` and
`(excerpt unavailable: NNN)`. A 403 becoming a 404 must fail the gate. A price
becoming a different price must not.

A zod `-32602` body is pinned **verbatim**, uniquely. zod generates it from the
tool's own input schema -- the required fields, the enum options, the clamp
bounds -- so it contains no data at all, and pinning it byte-for-byte pins the
tool's *input* contract for free.

## 2. The two anti-staleness properties

Both failure modes are ko-api's, both written up in `ko-api/docs/SLO.md` §6d,
and both apply to a Worker sitting behind the same edge.

### The gate cannot grade a stale artefact (ko-api#231)

ko-api's golden gate probed a public URL. Cloudflare answered
`cf-cache-status: HIT, age: 15290`, so the gate graded the **previous** deploy
while reporting on the new one; wave A8's first deploy went red on a change that
was already live and correct. The fix there was `purge_everything` before
probing -- a mitigation that works only as long as someone remembers it.

Here staleness is not mitigated, it is **unreachable**:

1. **There is no published artefact in the loop.** `scripts/golden-gate.mjs`
   starts `wrangler dev` on an ephemeral loopback port, against the working
   tree, and kills it on the way out. The thing under test has no URL anyone
   else can reach and did not exist before this job.
2. **A remote base is refused, not merely discouraged.** `assertLoopback()` in
   `src/contract/skeleton.mjs` throws on any host that is not
   `127.0.0.1` / `localhost` / `[::1]`, and `runGoldenGate` calls it before its
   first fetch. Pointing this gate at `mcp.ko.io` is not a configuration option.
   Two offline tests assert the refusal.
3. **It runs before the upload.** Red means nothing shipped, so there is never a
   deployed build for the gate to confuse with this one -- which also makes it a
   real gate rather than a post-mortem.

The Worker under test does still call `api.ko.io`, and Cloudflare's edge may
well serve that from cache. That cannot make this gate stale: a cached ko-api
response is a response **from the same contract**, and the gate compares
contract and never values. A stale ko-api body has the same field names as a
fresh one.

### A conditional or time-varying field can never enter the assertions (ko-api#236)

ko-api's `/v1/dashboard/metrics` emitted `meta.cached` **only on a cache hit**.
The capture happened to be cold, the gate at 03:41Z happened to be warm, and the
build was byte-identical in between: the gate had become a coin flip, and the
fixture itself was the bug. Three mechanisms stop that here, in the order they
would catch it:

1. **At capture.** `golden-capture.mjs` probes every case **twice** and writes
   the fixture only if the two contracts agree. Disagreement is the cold-vs-warm
   comparison #236 never made; the script refuses the write and names the
   differing line, and the answer is to normalise the varying part or exclude
   the case with a reason -- never to pick a winner.
2. **At capture, again, structurally.** A skeleton cannot contain a value in the
   first place: `normalizeLine`'s backstop erases every digit-bearing token, and
   `buildCase` aborts the capture if `rawValuesIn` finds one anyway.
3. **Offline, on the committed bytes.** `npm test` scans every skeleton line of
   every case for a surviving raw value and fails the suite. Nothing looked at
   ko-api's committed fixture; something looks at this one, on every push, with
   no network involved.

`meta.cached`'s MCP analogue -- a section or line rendered only under some
runtime condition -- is caught by exactly the same machinery, because the
skeleton records which lines exist and in what order.

## 3. Counts

| | |
|---|---|
| tools covered | 24 / 24 (`tools/list` returns 24; the deploy check asserts `>= 24`) |
| fixture files | 24, one per tool, in `src/contract/golden/` |
| replayed cases | 71 |
| excluded cases | 2, each with a written reason (below) |
| annotated known defects | 3 cases across 2 defects (was 7 across 3; ko-bastion#126 retired 4 of them by being fixed -- §4) |
| offline tests added | 37 (suite total 77 -> 114) |
| plan-gated tools pinning a 403 rather than data | 4 |

## 4. Known defects: annotated, never pinned

The M0 audit (`KO_MCP_TOOL_MATRIX_20260912.md`) found four live defects, so the
recordings this gate was seeded from contain **wrong output**. Pinning it would
freeze the bug into the contract and the gate would then block its own repair.

**One of the four is now fixed, and the mechanism is what fixed it honestly.**
ko-bastion#126 (a `limit` no upstream route read, plus three tools that sent no
row-count param at all) held four of the seven annotations. The fix made all four
probes stop holding, and the gate went red naming each one -- `rendered 5 data
rows; the defect renders exactly 50`, and `rendered 100` for `get_ftd_data` --
which is precisely the forced, deliberate re-pin this section was built for. The
four annotations and the `DEFECT_126_LIMIT` factory are gone, the five affected
fixtures were re-captured in that same PR, and `npm test` now asserts that **no
fixture cites #126 any more**: the absence is enforced the same way the presence
used to be.

The mechanism: the skeleton is defect-neutral by construction (row counts
collapse, values are erased), and the defect lives in a `knownDefect.probe` that
asserts **the bug is still there**. Fix the bug and the gate goes red naming the
issue, forcing a deliberate re-pin. A silent re-pin is unreachable.

| case | issue | probe | what a red means |
|---|---|---|---|
| `list_insider_traders.normal` | ko-bastion#125 | `identicalToCase: empty` -- `search=Musk` and `search=zzzqqq` still come back byte-identical | `search` now reaches ko-api; re-pin both cases and close #125 |
| `list_institutions.empty` | audit §3 warning 5 (no issue filed) | `headerWithoutRows` | the empty result became a soft sentence; re-pin |
| `get_congress_member.empty` | audit §3 warning 5 (no issue filed) | `headerWithoutRows` | same |

**ko-bastion#127 (no timeout) was never annotated, and is now FIXED.** It had no
signature in a response body, only in latency: the same input produced a 60.2 s
502 once and a 404 the next time, so its case was excluded rather than pinned.
`koFetch` is now bounded at `KO_FETCH_TIMEOUT_MS` = 20 s -- under the 30 s the
upstream ko-api route declares, ~19x the slowest healthy call ever measured
(1,050 ms) -- and a stall raises `KoTimeoutError`, which reads as OUR limit and
never as a `ko.io API error (5xx)`. `sec_get_filing_index.empty` is pinned again
as a result. Retry and circuit breaking remain out of scope and belong to the SLO
wave.

`npm test` enforces the annotations: every one must name an issue or an audit
section, carry a summary of real length, and carry a probe -- an annotation
without a probe would let the fix pass silently, which is the whole failure this
section exists to prevent.

## 5. Excluded cases

| case | why it is not pinned |
|---|---|
| `get_crypto_exposure.empty` | **Cannot be constructed.** The tool's input schema is `{}` and it always returns the whole spot-ETF complex, so no input yields an empty result. A structural absence, not a coverage gap -- the same reason the M0 set has 75 files and not 76. |
| `get_ftd_data.normal` | The recorded "normal" call (`{ticker: GME}`, default 90-day window) returned `No FTD data found for GME.` -- an **empty result**, because SEC had published no GME fails-to-deliver inside 90 days that day. Pinning it would pin a data state that flips the moment SEC publishes one, and the gate would go red on a change in the world. This tool's populated-table contract is carried by its `truncation` case instead. |

`npm test` requires every exclusion to name a real tool, give a reason of real
length, and *not* also appear as a pinned case. It also pins the exclusion list
itself, so an exclusion cannot be added or dropped without saying why here.

**Retired 2026-09-12: `sec_get_filing_index.empty`.** It was excluded because the
error CLASS the input produced was nondeterministic -- a 404 in one M0 recording,
a 502-after-60.2 s in another, and a 404 -> 502 move between a local run and CI
that blocked a main deploy (run 34711440107). That was an unbounded wait, not a
property of the input. With `koFetch` bounded (ko-bastion#127) the call either
answers 404 or raises this proxy's own named timeout, so the case is pinned
again.

## 6. The 4 plan-gated tools pin a GATE, not data

`get_treasury_yields`, `get_fed_rates`, `get_economic_indicators` and
`get_financial_stress` are blocked for free/demo callers by ko-api's
`blockedPrefixes`. Their `normal` and `empty` fixtures therefore pin a **403 plan
gate** and contain no data whatsoever.

That is a real contract and worth pinning -- the day an unauthenticated caller
stops getting a 403 there, a paid dataset is being given away and this gate says
so -- but **it is not data coverage**, and their rendering path is completely
untested here. The fixtures carry `planGated: true`, their `why` strings say
`PLAN GATE, NOT DATA`, the gate prints the four names on every run, and
`npm test` asserts all four are flagged and all four actually pin a 403. Nobody
should be able to read these fixtures later and count them as tool coverage.

Closing the gap needs a paid-tier ko.io key. At capture time `.secrets/` was
empty, `CLOUDFLARE_API_TOKEN` was unset and `wrangler whoami` reported not
logged in, so the QA Pro key (`qa_mcp_test_f7a2b3e7`, in prod D1) could not be
read.

## 7. Refreshing the fixtures

```bash
cd server
npm run golden:gate       # blocking gate: boots the local Worker and replays
npm run golden:capture    # re-pin every fixture from the local Worker
```

`golden:capture` boots the Worker built from the working tree, replays every
case in `src/contract/cases.mjs`, probes each one twice, and writes
`src/contract/golden/<tool>.json` only when the two probes agree.

### When re-recording is legitimate

Only when the **contract** actually changed and the change was intended:

- a tool's rendering was deliberately edited -- a column added, a heading
  reworded, an empty result turned from a headed table into a sentence;
- a tool's input schema changed, so its zod `-32602` body changed with it;
- a known defect was **fixed**, which the gate reports by name and issue number.

### When a diff is a regression

Everything else. In particular:

- a column that vanished or was renamed;
- a section that stopped rendering;
- a table that became a sentence, or a populated answer that became an empty one;
- `isError` flipping in either direction;
- an error class changing (403 -> 404, or a soft answer becoming `isError`).

Those are ko-api changing its JSON underneath this Worker -- the exact failure
this gate exists to catch. Re-recording them makes the bug the contract. The
gate's own failure message says this; read it before reaching for
`golden:capture`.

### Who re-pins

**Whoever is shipping the change that moved the contract, in the same PR**, with
the diff of `src/contract/golden/*.json` visible in review. Never a follow-up
commit, never a separate PR, and never someone clearing a red build they did not
cause. If a red gate surprises you, you are not the person who should re-pin it.

## 8. Provenance of the arguments

The M0 audit saved 75 verbatim JSON-RPC **response bodies** but not the
arguments that produced them, so a recording could be read and never re-run.
`src/contract/cases.mjs` is the missing half: every argument was reconstructed
from the recorded output -- the echoed ticker, CIK, member slug, accession and
zod error body pin it almost completely -- and then **confirmed** by replaying it
against a locally built Worker and comparing against the recording.

70 of 71 reproduced their recording on the first attempt. The one that did not
was `get_crypto_holder.normal`: the recorded body names *Brevan Howard Capital
Management LP* with no `*Interpreted ... as ...*` preamble, which proves a CIK
was used -- the name `"Brevan Howard"` resolves to *Brevan Howard Investment
Management Ltd* (CIK 2080817), which holds no crypto ETF and 404s. Corrected to
CIK `1512857`, it reproduced exactly. After that correction all 71 cases matched.

Two consequences worth writing down:

- **The `resolveInstitution` name path is not covered.** Both institution tools
  are pinned with CIKs, because that is what the recordings show was used.
- Fixtures record which mode produced them (`provenance.mode`:
  `recordings` for this seeding, `build` for every later refresh), and the
  offline suite requires the field.

## 8b. The one data-conditional line left, named on purpose

`meta.cached` was dangerous because it was a field nobody had noticed was
conditional. The honest thing is to enumerate this surface's equivalent rather
than claim there is none.

Eight pinned cases contain a pagination hint that eight tools emit **only when
there is a next page** (`rows.length === limit`, or a computed page count > 1):

| case | line | why the condition cannot flip |
|---|---|---|
| `get_institution_holdings.normal` | `*Page N -- use page=N+1 for more.*` | asks for 5 of Berkshire's ~40 13F positions |
| `get_stock_holders.normal` | same | asks for 5 of AAPL's 6,127 institutional holders |
| `get_crypto_holders.normal` | same | asks for 5 of IBIT's 1,481 holders |
| `get_congress_trades.normal` | same | asks for 5 of the whole STOCK Act feed |
| `list_institutions.normal` | `*More results available -- use page=N+1*` | asks for 5 of ~6,000 tracked institutions |
| `get_insider_trades.normal` | `*Full page of N rows -- more may exist; use page=N+1.*` | asks for 5 of AAPL's Form 4 history |
| `get_congress_member.normal` | `*Showing N trades -- use page=N+1 for more.*` | asks for 5 of Pelosi's multi-year disclosure history |
| `get_ftd_data.truncation` | `*Full page of N rows -- more may exist; use page=N+1.*` | takes the default 100 of a 1,825-day window with `total_count` 1,025 |

The bottom four arrived with the ko-bastion#126 fix: before it, the page size
never reached ko-api, so `rows.length === limit` was false by accident and the
hint could not fire -- these tools rendered a full 50-row page and said nothing.
The hint firing is the fix.

`list_insider_traders` is the one tool where the #126 fix does NOT add a line,
and the reason is worth recording because it moved twice in one afternoon. Its
two cases differ only in `search`, and while `search` was inert (ko-bastion#125)
both returned the same full 20-row page, so the hint fired on both. ko-api #260
shipped the #125 filter mid-session; `search=Musk` and `search=zzzqqq` now match
nobody, both cases render an empty table, and the hint correctly does not fire.
Its fixture is therefore UNCHANGED by the #126 PR -- the page size now reaches
ko-api, but there is no page to speak of. Note the side effect: #125's
`identicalToCase` probe still passes, because two empty answers are also
byte-identical. The row count is what actually signals that #125 shipped.

Every row asks for far fewer rows than the set holds. For a line to disappear the
underlying set would have to fall below the requested page size, which is itself
an incident worth a red build. `get_ftd_data.truncation` is the tightest margin
(100 of 1,025) and the only one where the set is finite and historical rather
than growing; SEC never unpublishes fails-to-deliver, so it only grows. The
double-probe at capture cannot catch a conditional this slow-moving -- it catches
cold-vs-warm, not month-over-month -- so this table, and the arithmetic in it, is
the control.

If a ninth such line ever appears, it belongs here before the fixture is
committed.

## 9. What this gate does not prove

- **The data path of the 4 plan-gated tools** (§6). Needs a paid key.
- **`resolveInstitution` by name** (§8).
- **Latency, retries and circuit breaking.** `koFetch` is bounded at 20 s since
  ko-bastion#127, and the gate has a 90 s per-call ceiling so a hang cannot wedge
  CI, but neither asserts how long a call SHOULD take. Per-tool p95, retry policy
  and a breaker belong to the SLO wave.
- **Anything beyond the free/demo tier.** The Worker under test carries no key,
  so every case goes to ko-api as `?demo=true`.
- **That the pinned rendering is *correct*.** It pins what the tools render
  today; §4 is the explicit list of places where today's rendering is known to
  be wrong. Note what §4 does NOT claim: `get_ftd_data.truncation` now pins a
  disclosure line that says a page is full, not a total. koFetch discards
  ko-api's `meta` when it unwraps `{ data, meta }`, so `total_count` never
  reaches this Worker and an honest "showing 100 of 1,025" is not available here
  yet. That is ko-bastion#127's file.
- **ko-api's own behaviour.** ko-api has its own 488-case gate for that. This
  one watches the seam between the two.
