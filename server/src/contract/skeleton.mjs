/**
 * Golden contract harness for the MCP tool surface.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The deploy gate before this one asked exactly two questions: does /health
 * answer, and is tools/list >= 24. Both are satisfied by a Worker that has
 * forgotten how to render a single row. ko-api's upstream JSON can rename a
 * field and every tool here will quietly emit a table with a header and no
 * body -- 24 tools, /health green, deploy green. That is the shape of the two
 * mart freezes this org has already paid for.
 *
 * This harness pins the CONTRACT of a tools/call response and nothing else:
 *
 *   - the JSON-RPC envelope shape (result/content/isError: names and types)
 *   - the literal content-block `type` values
 *   - isError, exactly
 *   - the STRUCTURE of the rendered markdown: heading words, bold label text,
 *     table column names, section order, table-vs-prose
 *   - the CLASS of an error: `ko.io API error (403): Access forbidden ...`,
 *     and zod's `-32602` validation body verbatim (it is schema-derived, so it
 *     contains no data at all)
 *
 * and never:
 *
 *   - a price, a share count, a total, a rank, a date, a row count, a CIK
 *   - how many rows came back (row count is data; an upstream returning 4 rows
 *     today and 5 tomorrow has not changed its contract)
 *
 * THE TWO FAILURE MODES THIS HARNESS IS BUILT AGAINST
 * ---------------------------------------------------
 * Both are ko-api's, both written up in ko-api/docs/SLO.md section 6d, and both
 * apply verbatim to a Worker sitting behind the same edge.
 *
 * 1. "The golden gate was grading the previous build" (ko-api#231). ko-api's
 *    gate probed a public URL, Cloudflare answered from cache
 *    (cf-cache-status: HIT, age: 15290), and the gate graded the PREVIOUS
 *    deploy while reporting on the new one. Here the gate never has a public
 *    URL to probe: assertLoopback() below REFUSES any base that is not
 *    loopback, and the process under test is a Worker built from the working
 *    tree in this job and thrown away after. There is no edge, no age header,
 *    and no previously-deployed version reachable from the gate at all. It also
 *    runs BEFORE the upload, so a red gate means nothing was deployed.
 *
 * 2. "The meta.cached case" (ko-api#236). A field emitted only on a cache hit
 *    turned the gate into a coin flip -- 03:22Z cold passed, 03:41Z warm
 *    failed, code byte-identical. The defence here is structural rather than
 *    hopeful: normalizeLine erases every digit-bearing token, so no captured
 *    skeleton can contain a value that varies at all; rawValuesIn (run by
 *    `npm test`, offline) scans the committed fixtures for one and fails if a
 *    capture ever leaks one; and the capture script refuses to write a fixture
 *    unless two independent probes of the same case agree -- which is exactly
 *    the cold-vs-warm comparison that would have caught #236 at capture time
 *    instead of at 03:41Z.
 *
 * Plain ESM, zero dependencies, so the scripts run with no build step -- same
 * contract as ko-api's src/contract/golden.mjs.
 */

// ---------------------------------------------------------------------------
// Envelope shape (values never compared -- ko-api's shapeOf, same semantics)
// ---------------------------------------------------------------------------

/** Wildcard leaf: a field that happened to be null when captured. */
export const NULLABLE = 'null';

/** Reduce a JSON value to a type skeleton: names, nesting and types only. */
export function shapeOf(value) {
  if (value === null) return NULLABLE;
  if (Array.isArray(value)) return { _array: value.length ? shapeOf(value[0]) : null };
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k]);
    return out;
  }
  return typeof value;
}

/** Human-readable differences between two shapes (empty array = unchanged). */
export function diffShape(expected, actual, path = '') {
  const at = path || '(root)';
  if (expected === NULLABLE || actual === NULLABLE) return [];

  const eArr = expected && typeof expected === 'object' && '_array' in expected;
  const aArr = actual && typeof actual === 'object' && '_array' in actual;
  if (eArr || aArr) {
    if (!eArr || !aArr) {
      return [`${at}: expected ${eArr ? 'array' : describe(expected)}, got ${aArr ? 'array' : describe(actual)}`];
    }
    if (expected._array === null || actual._array === null) return []; // one side empty
    return diffShape(expected._array, actual._array, `${at}[]`);
  }

  const eObj = expected && typeof expected === 'object';
  const aObj = actual && typeof actual === 'object';
  if (eObj !== aObj) return [`${at}: expected ${describe(expected)}, got ${describe(actual)}`];
  if (!eObj) return expected === actual ? [] : [`${at}: expected ${expected}, got ${actual}`];

  const out = [];
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) { out.push(`${at}.${k}: field REMOVED`); continue; }
    out.push(...diffShape(expected[k], actual[k], `${at}.${k}`));
  }
  for (const k of Object.keys(actual)) {
    if (!(k in expected)) out.push(`${at}.${k}: field ADDED (re-pin the fixture if intended)`);
  }
  return out;
}

function describe(shape) {
  if (shape === null) return 'empty';
  if (shape && typeof shape === 'object') return '_array' in shape ? 'array' : 'object';
  return String(shape);
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * The ONLY two places a digit survives normalisation.
 *
 * Both are error CLASSES, not data: the HTTP status ko-fetch.ts stamps into its
 * message, and the status filings.ts reports when the free tier cannot fetch an
 * excerpt. A 403 becoming a 404 is a contract change and must fail the gate; a
 * price becoming a different price must not. Everything else digit-bearing is
 * erased, deliberately and without exception -- see rawValuesIn.
 */
const STATUS_CONTEXTS = [
  /ko\.io API error \(\d{3}\)/g,
  /\(excerpt unavailable: \d{3}\)/g,
];

/** Skeleton line prefixes, stripped before the raw-value scan. */
const MARKER = /^(?:H[1-6]|TEXT|THEAD|TBODY|BLANK|NONTEXT) ?/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Digit-free placeholder, so the backstop rule cannot eat a saved status. */
function hold(i) {
  return '<<STATUS' + ALPHABET[i % 26] + '>>';
}

/**
 * Erase every value from one line of rendered markdown, keeping its words.
 *
 * Ordered, because the broader patterns would otherwise eat the narrower ones.
 * The last rule is the backstop and the reason this is safe: ANY remaining
 * whitespace-delimited token containing a digit becomes <VAL>. A value that is
 * none of the named forms still cannot reach a fixture.
 */
export function normalizeLine(line) {
  let s = String(line);

  // Protect the two status contexts before anything can touch their digits.
  const saved = [];
  for (const re of STATUS_CONTEXTS) {
    s = s.replace(re, (m) => {
      saved.push(m);
      return hold(saved.length - 1);
    });
  }

  s = s.replace(/\b\d{10}-\d{2}-\d{6}\b/g, '<ACCESSION>');
  s = s.replace(/https?:\/\/[^\s)*]+/g, '<URL>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>');
  s = s.replace(/[+-]?\$\s?[\d.,]+\s?[KMBT]?/g, '<MONEY>');
  s = s.replace(/[+-]?[\d.,]+\s?%/g, '<PCT>');
  // Backstop: any leftover token carrying a digit is a value slot.
  s = s.replace(/\S*\d\S*/g, '<VAL>');

  for (let i = 0; i < saved.length; i += 1) s = s.split(hold(i)).join(saved[i]);
  return s;
}

/**
 * Does this skeleton line still carry a raw value?
 *
 * The mechanical half of defence #2. `npm test` runs it over every committed
 * skeleton line: a capture that leaks `1481` or `2026-06-30` into a fixture
 * fails offline, before it can ever become a 03:41Z coin flip.
 *
 * Two line kinds are exempt, both because they are rendered from string
 * literals in the tool source and can never carry a value:
 *
 *   ZOD   -- zod generates it from the tool's own schema (required fields, enum
 *            options, clamp bounds). Pinned verbatim on purpose.
 *   THEAD -- a table's column list. Column names are the contract, and one of
 *            them is literally `10b5-1` (get_form144_notices). Comparing them
 *            character for character is the point of the whole exercise.
 */
export function rawValuesIn(line) {
  const l = String(line);
  if (l.startsWith('ZOD ') || l.startsWith('THEAD ')) return [];
  let s = l.replace(MARKER, '');
  for (const re of STATUS_CONTEXTS) s = s.replace(re, '');
  // <VAL>/<DATE>/... placeholders contain no digits, so anything left is real.
  return s.match(/\S*\d\S*/g) || [];
}

// ---------------------------------------------------------------------------
// Markdown -> structural skeleton
// ---------------------------------------------------------------------------

const TABLE_DELIM = /^\s*\|?\s*:?-{2,}/;

/**
 * Reduce one rendered text block to its structure.
 *
 * Returns { lines, tables } where `lines` is the comparable skeleton and
 * `tables` is per-table metadata that is deliberately NOT part of the contract
 * -- it exists only so a knownDefect probe can look at a row count without the
 * row count becoming something the gate pins.
 *
 * Table bodies collapse to a single TBODY marker. Row COUNT is data: a page
 * returning 49 rows today and 50 tomorrow has the same contract, and a gate
 * that disagrees is a gate people learn to ignore.
 *
 * An `MCP error -32602` body is kept VERBATIM. zod generates it from the tool's
 * own schema -- required fields, enum options, clamp bounds -- so there is no
 * data in it at all, and pinning it byte-for-byte pins the tool's INPUT
 * contract without any risk of flake.
 */
export function textSkeleton(text) {
  if (typeof text !== 'string') return { lines: ['NONTEXT ' + typeof text], tables: [] };

  if (text.startsWith('MCP error -')) {
    return { lines: text.split('\n').map((l) => 'ZOD ' + l), tables: [], verbatim: true };
  }

  const src = text.split('\n');
  const lines = [];
  const tables = [];
  let i = 0;
  let lastBlank = false;

  while (i < src.length) {
    const line = src[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      if (!lastBlank) lines.push('BLANK');
      lastBlank = true;
      i += 1;
      continue;
    }
    lastBlank = false;

    // Table: a pipe row immediately followed by a delimiter row.
    if (trimmed.startsWith('|') && i + 1 < src.length && TABLE_DELIM.test(src[i + 1].replace(/^\s*\|/, ''))) {
      const cols = splitRow(trimmed);
      lines.push('THEAD ' + cols.join(' | '));
      i += 2;
      let dataRows = 0;
      while (i < src.length && src[i].trim() !== '') {
        if (src[i].trimStart().startsWith('|')) dataRows += 1;
        i += 1;
      }
      lines.push('TBODY');
      tables.push({ columns: cols, dataRows });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) lines.push('H' + h[1].length + ' ' + normalizeLine(h[2]));
    else lines.push('TEXT ' + normalizeLine(trimmed));
    i += 1;
  }

  while (lines.length && lines[lines.length - 1] === 'BLANK') lines.pop();
  return { lines, tables };
}

function splitRow(row) {
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/**
 * Reduce a whole JSON-RPC tools/call response to its comparable contract.
 *
 * `envelope` is the shape of the response with every rendered text replaced by
 * a marker, so the envelope check sees field names and types and never a
 * character of content.
 */
export function contractOf(rpc) {
  const masked = JSON.parse(JSON.stringify(rpc === undefined ? null : rpc));
  const maskedContent = masked && masked.result ? masked.result.content : null;
  if (Array.isArray(maskedContent)) {
    for (const b of maskedContent) if (b && typeof b.text === 'string') b.text = '<TEXT>';
  }

  const blocks = Array.isArray(rpc && rpc.result && rpc.result.content) ? rpc.result.content : [];
  return {
    envelope: shapeOf(masked),
    isError: Boolean(rpc && rpc.result && rpc.result.isError === true),
    contentTypes: blocks.map((b) => String(b && b.type)),
    blocks: blocks.map((b) => textSkeleton(b && b.text)),
  };
}

/** Differences between a pinned contract and a live one (empty = intact). */
export function diffContract(pinned, live) {
  const out = [];
  out.push(...diffShape(pinned.envelope, live.envelope, 'envelope'));

  if (Boolean(pinned.isError) !== Boolean(live.isError)) {
    out.push('isError ' + pinned.isError + ' -> ' + live.isError);
  }

  if (pinned.contentTypes.join(',') !== live.contentTypes.join(',')) {
    out.push('content types [' + pinned.contentTypes + '] -> [' + live.contentTypes + ']');
  }

  const n = Math.max(pinned.blocks.length, live.blocks.length);
  for (let b = 0; b < n; b += 1) {
    const p = pinned.blocks[b];
    const l = live.blocks[b];
    if (!p) { out.push('content[' + b + ']: block ADDED'); continue; }
    if (!l) { out.push('content[' + b + ']: block REMOVED'); continue; }
    out.push(...diffLines(p.lines, l.lines, 'content[' + b + ']'));
  }
  return out;
}

/** Line-level diff, capped so one rendering change cannot bury the report. */
function diffLines(expected, actual, at) {
  const out = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    if (expected[i] === actual[i]) continue;
    if (expected[i] === undefined) out.push(at + ' line ' + i + ': ADDED   ' + actual[i]);
    else if (actual[i] === undefined) out.push(at + ' line ' + i + ': REMOVED ' + expected[i]);
    else out.push(at + ' line ' + i + ': ' + JSON.stringify(expected[i]) + ' -> ' + JSON.stringify(actual[i]));
    if (out.length >= 6) { out.push(at + ': ...and more'); break; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Known defects: annotated so the FIX breaks the gate, not the bug
// ---------------------------------------------------------------------------

/**
 * Evaluate a knownDefect probe against the LIVE response.
 *
 * The premise, which is the whole point of the annotation: a gate that pins
 * today's wrong answer as the contract is worse than no gate, because it blocks
 * the fix. So the skeleton never carries the defect (row counts collapse,
 * values are erased) and the defect lives in a probe that asserts the bug is
 * STILL THERE. When someone fixes ko-bastion#125 the probe stops holding, the
 * gate goes red naming the issue, and the fixture has to be re-pinned by a
 * human who then deletes the annotation. A silent re-pin is unreachable.
 *
 * `live` is the contract of this case; `texts` maps case name -> rendered text
 * for the whole tool, so a probe can compare two cases of the same tool.
 *
 * Returns null while the defect is still present, or a message when it is gone.
 */
export function checkDefect(probe, caseName, live, texts) {
  switch (probe.kind) {
    // A page size that is not honoured: the probe pins the row count the DEFECT
    // produces, so the fix fails the gate. Used by ko-bastion#126 (a `limit` no
    // upstream route read, so every page was the 50-row default) until that was
    // fixed; kept because it is the general shape of "the caller asked for N and
    // got M", which is invisible in a skeleton that deliberately drops counts.
    case 'dataRowCount': {
      const rows = live.blocks.flatMap((b) => b.tables.map((t) => t.dataRows));
      if (rows.length === 0) return 'expected a table to count rows in, got none (the rendering changed)';
      if (!rows.includes(probe.equals)) {
        return 'rendered ' + rows.join('/') + ' data rows; the defect renders exactly ' + probe.equals;
      }
      return null;
    }
    // #125: the argument never reaches ko-api, so two calls that differ ONLY in
    // that argument come back byte-identical.
    case 'identicalToCase': {
      const mine = texts[caseName];
      const other = texts[probe.case];
      if (other === undefined) return "sibling case '" + probe.case + "' was not replayed, cannot compare";
      if (mine !== other) {
        return "no longer byte-identical to case '" + probe.case + "' -- the argument is being honoured now";
      }
      return null;
    }
    // Audit section 3 (warning 5): an empty result rendered as a headed empty
    // table instead of the soft sentence the other 22 tools use.
    case 'headerWithoutRows': {
      const tables = live.blocks.flatMap((b) => b.tables);
      if (tables.length === 0) return 'no table rendered -- the empty result is no longer a headed empty table';
      if (tables.some((t) => t.dataRows === 0)) return null;
      return 'every table has rows -- this was supposed to be the empty case';
    }
    default:
      return "unknown probe kind '" + probe.kind + "'";
  }
}

// ---------------------------------------------------------------------------
// Fixture IO
// ---------------------------------------------------------------------------

/**
 * Absolute path of the committed fixture directory.
 *
 * Resolved here rather than in the caller so the vitest suite never has to
 * import node:path or reach for import.meta -- tsconfig types this package
 * against @cloudflare/workers-types only, deliberately, and a Worker has
 * neither.
 */
export function goldenDir() {
  return new URL('./golden/', import.meta.url).pathname;
}

/** Load every committed fixture, sorted by filename. */
export async function loadFixtures(dir) {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Hard guard behind anti-staleness property #1.
 *
 * The gate may only ever talk to a Worker this job just built and is running on
 * loopback. Pointing it at mcp.ko.io -- which is what made ko-api#231 possible,
 * an edge cache answering with a 15,290-second-old body from the PREVIOUS
 * build -- is not a configuration mistake here. It is refused.
 */
export function assertLoopback(base) {
  const u = new URL(base);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') {
    throw new Error(
      'golden gate base must be loopback, got ' + base + '.\n' +
      'This gate grades the Worker built from THIS working tree, running in this job.\n' +
      'A remote base would let a CDN answer from a previous build (ko-api#231).',
    );
  }
}

/** One tools/call against the local Worker. */
export async function callTool(base, tool, args, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const timeoutMs = o.timeoutMs || 90000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, err: 'non-JSON body (' + text.slice(0, 80) + ')' };
    }
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The rendered text of the first content block, or '' -- for identicalToCase. */
export function firstText(rpc) {
  const t = rpc && rpc.result && rpc.result.content && rpc.result.content[0]
    ? rpc.result.content[0].text
    : undefined;
  return typeof t === 'string' ? t : '';
}

/**
 * Replay every pinned case against `base` and report what moved.
 *
 * `unreachable` is reported separately and is a HARD failure for the caller --
 * unlike ko-api's remote gate, "the host was unreachable" here means the build
 * under test did not come up, which is not an excuse for anything.
 */
export async function runGoldenGate(fixtures, opts) {
  const o = opts || {};
  const base = o.base;
  assertLoopback(base);
  const fetchImpl = o.fetchImpl || globalThis.fetch;

  const failures = [];
  const unreachable = [];
  const defectsFixed = [];
  const defectsPresent = [];
  let checked = 0;
  let tools = 0;

  for (const fx of fixtures) {
    tools += 1;
    const texts = {};
    const lives = {};

    for (const c of fx.cases) {
      const r = await callTool(base, fx.tool, c.arguments, { fetchImpl });
      if (!r.ok) { unreachable.push({ tool: fx.tool, case: c.name, err: r.err }); continue; }
      texts[c.name] = firstText(r.body);
      lives[c.name] = contractOf(r.body);
      checked += 1;
    }

    for (const c of fx.cases) {
      const live = lives[c.name];
      if (!live) continue;

      const problems = diffContract(c.contract, live);
      if (problems.length) failures.push({ tool: fx.tool, case: c.name, problems });

      if (c.knownDefect) {
        const gone = checkDefect(c.knownDefect.probe, c.name, live, texts);
        if (gone) defectsFixed.push({ tool: fx.tool, case: c.name, issue: c.knownDefect.issue, why: gone });
        else defectsPresent.push({ tool: fx.tool, case: c.name, issue: c.knownDefect.issue });
      }
    }
  }

  return { tools, checked, failures, unreachable, defectsFixed, defectsPresent };
}
