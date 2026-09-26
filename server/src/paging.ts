/**
 * Paging + plan-limit disclosure shared by every tool that pages, and the
 * exact-value helpers behind `structuredContent`.
 *
 * WHY THIS EXISTS (final-eval 2026-09-26, EVAL_CODEX_TECH #6)
 * ----------------------------------------------------------
 * The tools used to decide "is there a next page?" from one fact: whether the
 * page came back full. For a keyless caller that is wrong twice over:
 *   - ko-api's soft wall caps a keyless page at 25 rows. A tool asking for 50
 *     got 25, the page did not look full, and the rows it lost were never
 *     mentioned.
 *   - When a page DID look full the tool said "use page=2" -- and page=2 is a
 *     403 SIGNIN_REQUIRED for exactly that caller. The hint named a page the
 *     caller could not open.
 * ko-api says all of this in `meta.softwall` (row_cap / truncated /
 * continuation) and `meta.total_count`; koFetch used to throw `meta` away. The
 * tools now read the envelope and this module turns it into one disclosure.
 */
import type { KoMeta } from "./ko-fetch.js";

export interface PageState {
  page: number;
  /** Rows per page the caller asked for. */
  limit: number;
  /** Rows actually returned on this page. */
  returned: number;
}

export interface Paging {
  page: number;
  per_page: number;
  returned: number;
  /** ko-api's `meta.total_count`, when it sent one. */
  total_count: number | null;
  /** true / false when known; null = "a full page came back, more MAY exist". */
  has_more: boolean | null;
  /** The page to ask for next, or null when there is none THIS CALLER can open. */
  next_page: number | null;
  /** "SIGNIN_REQUIRED" when ko-api refuses page>1 without an API key. */
  continuation: string | null;
  /** The keyless row cap ko-api applied, when it applied one. */
  plan_row_cap: number | null;
  /** True when the plan's row cap cut rows out of THIS page. */
  truncated_by_plan: boolean;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** What the envelope says about paging, reconciled with what the tool asked for. */
export function pagingOf(meta: KoMeta, s: PageState): Paging {
  const sw = meta.softwall;
  const total = intOrNull(meta.total_count);
  const cap = intOrNull(sw?.row_cap);
  // ko-api may have rewritten per_page down to the keyless cap; meta.per_page
  // is what it actually served.
  const perPage = intOrNull(meta.per_page) ?? s.limit;
  const truncated = sw?.truncated === true;
  const signin = sw?.continuation === "SIGNIN_REQUIRED" ? "SIGNIN_REQUIRED" : null;

  let hasMore: boolean | null;
  if (total !== null) hasMore = (s.page - 1) * perPage + s.returned < total;
  else if (truncated) hasMore = true;
  else if (s.returned >= s.limit) hasMore = null;
  else hasMore = false;

  return {
    page: s.page,
    per_page: perPage,
    returned: s.returned,
    total_count: total,
    has_more: hasMore,
    next_page: hasMore !== false && !signin ? s.page + 1 : null,
    continuation: signin,
    plan_row_cap: cap,
    truncated_by_plan: truncated || (cap !== null && s.limit > cap && s.returned >= cap && hasMore !== false),
  };
}

/**
 * The paging footer. Never names a page the caller cannot open, and says in
 * words when rows were withheld by the plan rather than absent.
 */
export function pagingLines(p: Paging): string[] {
  const out: string[] = [];
  const first = (p.page - 1) * p.per_page + 1;
  const last = (p.page - 1) * p.per_page + p.returned;
  const range = p.total_count !== null && p.returned > 0
    ? `rows ${first}-${last} of ${p.total_count.toLocaleString("en-US")}`
    : null;

  if (p.continuation === "SIGNIN_REQUIRED" && p.has_more !== false) {
    const cap = p.plan_row_cap !== null ? ` (keyless page cap: ${p.plan_row_cap} rows)` : "";
    out.push(
      `\n*Showing ${range ?? `${p.returned} rows`}${cap}. More rows exist, but keyless access ends at page 1: ` +
      `page=${p.page + 1} returns SIGNIN_REQUIRED without an API key. Send a free ko.io API key ` +
      `(Authorization: Bearer ko_...) to page further.*`,
    );
    return out;
  }
  if (p.truncated_by_plan) {
    out.push(`\n*This page was capped at ${p.plan_row_cap} rows by the caller's ko.io plan.*`);
  }
  if (p.has_more === true && p.next_page !== null) {
    out.push(`\n*Showing ${range ?? `${p.returned} rows`} -- use page=${p.next_page} for more.*`);
  } else if (p.has_more === null && p.next_page !== null) {
    out.push(`\n*Full page of ${p.returned} rows — more may exist; use page=${p.next_page}.*`);
  }
  return out;
}

/**
 * One line naming the plan's time window, when ko-api applied one. Without it a
 * Free caller's 92-day Form 4 feed reads as the insider's whole history.
 */
export function windowLine(meta: KoMeta): string | null {
  const sw = meta.softwall;
  if (!sw?.window_start) return null;
  const basis = sw.date_basis ? `${sw.date_basis} ` : "";
  const period = sw.effective_period ? ` (period ${sw.effective_period})` : "";
  return (
    `*ko.io Free-plan window: ${basis}${sw.window_start} to ${sw.window_end ?? "today"}${period}. ` +
    `Earlier data exists and requires Pro -- it is not absent.*`
  );
}

/** The plan-limit block for structuredContent (null for a paid caller). */
export function planLimitOf(meta: KoMeta): Record<string, string | number | boolean | null> | null {
  const sw = meta.softwall;
  if (!sw) return null;
  return {
    policy_version: sw.policy_version ?? null,
    window_start: sw.window_start ?? null,
    window_end: sw.window_end ?? null,
    effective_period: sw.effective_period ?? null,
    date_basis: sw.date_basis ?? null,
    row_cap: sw.row_cap ?? null,
    truncated: sw.truncated ?? null,
    continuation: sw.continuation ?? null,
  };
}

// ---------------------------------------------------------------------------
// Exact values for structuredContent.
//
// The Markdown is for reading: 57,727 renders as "58K" and 227,917,808 as
// "227.92M". structuredContent is for computing, so it carries the value ko-api
// sent, unrounded: Int64 columns arrive as strings and stay strings, JS numbers
// become their shortest round-trip decimal string. Nothing is re-derived.
// ---------------------------------------------------------------------------

/** Exact decimal string, or null for null/absent/non-numeric. */
export function dec(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return Number.isFinite(Number(v)) ? v.trim() : null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/** Small count as a JSON integer (safe range only), or null. */
export function int(v: unknown): number | null {
  const n = intOrNull(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}

/** Exact integer with thousands separators, for the Markdown where precision matters. */
export function fmtIntExact(v: unknown): string {
  const d = dec(v);
  if (d === null) return "—";
  const n = Number(d);
  return Number.isSafeInteger(n) ? n.toLocaleString("en-US") : d;
}

/** Exact dollar amount with cents, for the Markdown where precision matters. */
export function fmtUsdExact(v: unknown): string {
  const d = dec(v);
  if (d === null) return "—";
  const n = Number(d);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
