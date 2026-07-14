// ---------------------------------------------------------------------------
// Int64-as-string coercion (root enabler of the net_value class of bugs).
//
// ko-api's ClickHouse HTTP client returns Int64/UInt64 columns as STRINGS
// (net_value, net_shares, holding_value, ...). Passing those raw into a numeric
// formatter used to silently mis-render. crypto.ts is the reference; num() is
// its idiom, now shared. fmtMoney/fmtShares/fmtPct coerce at the top so a string
// input is handled identically to the equivalent number.
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-string value (Int64-as-string from ko-api) into a finite
 * number; non-finite / non-coercible inputs become 0. Use for counts and
 * arithmetic where a numeric result is always wanted. (Reference: crypto.ts.)
 */
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce for FORMATTING: preserves the null/absent distinction (-> "N/A") that
 * num() collapses to 0. Returns null for null/undefined/""/non-finite so the
 * formatters can render "N/A" instead of "$0.00".
 */
function coerce(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtMoney(value: number | string | null | undefined): string {
  const v = coerce(value);
  if (v == null) return "N/A";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmtShares(value: number | string | null | undefined): string {
  const v = coerce(value);
  if (v == null) return "N/A";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs}`;
}

export function fmtPct(value: number | string | null | undefined): string {
  const v = coerce(value);
  if (v == null) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function truncate(arr: unknown[], max: number): unknown[] {
  return arr.slice(0, max);
}
