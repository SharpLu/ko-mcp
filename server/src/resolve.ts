import { koFetch, type KoConfig } from "./ko-fetch.js";

interface InstMatch {
  cik: string;
  name: string;
  slug: string;
}

/** A CIK (all digits) or a slug (lowercase, hyphenated) is already a usable identifier. */
function isIdentifier(s: string): boolean {
  return /^\d+$/.test(s) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s);
}

/**
 * Resolve an institution CIK / slug / free-text name into a usable identifier.
 * - numeric input  -> used as a CIK directly (no extra call)
 * - slug input     -> used directly (no extra call)
 * - a name         -> looked up via /institutions?search= and mapped to the best match's CIK
 *
 * Returns { target, note } where `note` is a one-line markdown prefix when a name was
 * fuzzy-resolved (empty for direct identifiers), or null when a name matches nothing.
 */
export async function resolveInstitution(
  config: KoConfig,
  input: string
): Promise<{ target: string; note: string } | null> {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (isIdentifier(raw)) return { target: raw, note: "" };

  const matches = await koFetch<InstMatch[]>(config, "/api/v1/institutions", {
    search: raw,
    limit: 5,
  }).catch(() => [] as InstMatch[]);
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
