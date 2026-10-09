import { koFetch, type KoConfig } from "./ko-fetch.js";

interface InstMatch {
  cik: string;
  name: string;
  slug: string;
}

/**
 * The CIK an input names, or null when the input is not a CIK.
 *
 * Only two forms are a CIK: the whole input is digits ("1512857"), or the
 * explicit "CIK 1512857" / "CIK:1512857" / "CIK#1512857" form. Digits embedded
 * in a name are NOT a CIK -- "Point72 Asset Management" stripped to its digits
 * is "72", which is some other filer (or nobody).
 */
export function parseCik(input: string): string | null {
  const m = /^\s*(?:cik\s*[:#]?\s*)?(\d{1,10})\s*$/i.exec(input ?? "");
  return m ? m[1] : null;
}

/** A slug (lowercase, hyphenated) is already a usable identifier. */
function isSlug(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s);
}

export interface ResolveOptions {
  /**
   * The caller needs a CIK (its upstream route takes no slug), so a
   * slug-shaped input is looked up by name like any other non-CIK input
   * instead of being passed through.
   */
  cikOnly?: boolean;
}

/**
 * Resolve an institution CIK / slug / free-text name into a usable identifier.
 * - CIK input      -> used as a CIK directly (no extra call); see parseCik
 * - slug input     -> used directly (no extra call), unless opts.cikOnly
 * - a name         -> looked up via /institutions?search= and mapped to the best match's CIK
 *
 * Returns { target, note } where `note` is a one-line markdown prefix when a name was
 * fuzzy-resolved (empty for direct identifiers), or null ONLY when the lookup
 * succeeded and matched nothing.
 *
 * A failed lookup (401/403/429/5xx/timeout) is NOT "no match": it throws, so the
 * tool surfaces it through the MCP isError path with the upstream error intact.
 * Swallowing it here turned quota exhaustion and outages into the factual claim
 * that the institution does not exist.
 */
export async function resolveInstitution(
  config: KoConfig,
  input: string,
  opts: ResolveOptions = {}
): Promise<{ target: string; note: string } | null> {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const cik = parseCik(raw);
  if (cik) return { target: cik, note: "" };
  if (!opts.cikOnly && isSlug(raw)) return { target: raw, note: "" };

  const matches = await koFetch<InstMatch[]>(config, "/api/v1/institutions", {
    search: raw,
    limit: 5,
  });
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const lower = raw.toLowerCase();
  const best =
    matches.find(
      (m) => m.name?.toLowerCase() === lower || m.slug?.toLowerCase() === lower
    ) || matches[0];

  return {
    target: best.cik,
    note: `*Interpreted "${input}" as ${best.name} (CIK ${best.cik}).*\n`,
  };
}
