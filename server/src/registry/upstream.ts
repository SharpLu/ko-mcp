/**
 * The pinned ko-api contract, as seen from ko-mcp.
 *
 * WHY A PIN AND NOT A LIVE LOOKUP
 * -------------------------------
 * ko-api is a different repository. CI here has no CLOUDFLARE_API_TOKEN, no
 * guaranteed authenticated `gh`, and no promise of network at all, so a gate
 * that fetches ko-api at test time is a gate that silently checks nothing the
 * first time the network hiccups. The contract is therefore committed.
 *
 * WHY DERIVED AND NOT VERBATIM
 * ----------------------------
 * The tidy version of this -- vendor ko-api's routes.ts byte-for-byte and check
 * its git blob SHA offline -- is not available: **ko-mcp is a public repo and
 * ko-api is private**, so vendoring would publish private source. What is
 * committed in src/registry/upstream/contract.json is only what the MCP server
 * already exposes to the internet on every call: the 24 public /api/v1 paths it
 * proxies to, their query-param names, the auth mode and the free-plan gate a
 * caller observes as a 403. The private bytes stay private; pin.json records
 * their git blob SHAs, which disclose nothing and are what makes the pin
 * checkable by anyone who does have ko-api.
 *
 * That trade costs one guarantee -- the contract's bytes cannot be proven to be
 * ko-api's bytes offline -- so staleness is defended three other ways:
 *   1. SELF-CONSISTENCY (offline, every `npm test`): contract.json must hash to
 *      pin.json.contractSha256. Hand-editing the contract to make a gate green
 *      fails; the generator is the only sanctioned way to change it.
 *   2. AGE (offline, every `npm test`): a pin older than MAX_PIN_AGE_DAYS is a
 *      red gate naming the refresh command. Staleness becomes visible with no
 *      network and no ko-api access at all.
 *   3. DRIFT (needs a ko-api checkout): `npm run registry:check-upstream`
 *      compares every pinned blob SHA with ko-api origin/main and fails naming
 *      each file's NEW SHA. It refuses to exit 0 when it cannot find ko-api --
 *      "checked nothing" must never read like "found nothing".
 *
 * Refresh with: KO_API_REPO=/path/to/ko-api npm run registry:refresh-pin
 */
import contractJson from './upstream/contract.json?raw';
import pin from './upstream/pin.json';

/** A pin this old is treated as unverified. One quarter -- ko.io's data cadence. */
export const MAX_PIN_AGE_DAYS = 90;

export const UPSTREAM_PIN = pin as {
  koApiRepo: string;
  rev: string;
  commit: string;
  pinnedAt: string;
  contractSha256: string;
  files: Record<string, string>;
};

export interface UpstreamRouteContract {
  /** ko-api AuthMode, verbatim from its route registry. */
  auth: string;
  cache: string;
  pagination: { style: string; params: string[] } | null;
  /** ClickHouse-call ceiling ko-api declares. ko-mcp honours none of it today. */
  timeoutMs: number;
  /** Query params THIS handler reads (handler granularity, not file). */
  readParams: string[];
}

export interface UpstreamContract {
  koApiRepo: string;
  koApiCommit: string;
  sourceRouteCount: number;
  freeBlockedPrefixes: string[];
  routes: Record<string, UpstreamRouteContract>;
}

/**
 * Parsed from the RAW text rather than imported as JSON so the object the gates
 * read is provably the same bytes the integrity check hashes.
 */
export const UPSTREAM_CONTRACT = JSON.parse(contractJson) as UpstreamContract;

/** The exact bytes of contract.json, for the integrity gate. */
export const UPSTREAM_CONTRACT_RAW = contractJson;

/** ko-api auth modes that require a NON-FREE plan. */
export const PAID_AUTH_MODES: readonly string[] = [
  'apiKeyPaid', 'signedTokenOrApiKeyPaid', 'paid', 'signedTokenOrPaid',
];

/** The pinned spec for `METHOD path`, or null when the route is not pinned. */
export function upstreamRoute(method: string, path: string): UpstreamRouteContract | null {
  return UPSTREAM_CONTRACT.routes[`${method} ${path}`] ?? null;
}

/**
 * Query params the handler for `METHOD path` actually reads. Returns null when
 * the route is not pinned -- callers must treat that as a failure, not as
 * "reads nothing".
 */
export function upstreamReadParams(method: string, path: string): string[] | null {
  return upstreamRoute(method, path)?.readParams ?? null;
}

export function freeBlockedPrefixes(): string[] {
  return UPSTREAM_CONTRACT.freeBlockedPrefixes;
}

/** SHA-256 of a string, via Web Crypto (no node:crypto -- this package has no node types). */
export async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whole days since the pin was taken. */
export function pinAgeDays(now = new Date()): number {
  const pinned = new Date(`${UPSTREAM_PIN.pinnedAt}T00:00:00Z`).getTime();
  return Math.floor((now.getTime() - pinned) / 86_400_000);
}
