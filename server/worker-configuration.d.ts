interface Env {
  KO_API_URL: string;
  // NOTE: deliberately no KO_API_KEY. This worker must never hold a server-side
  // API key — a shared key would let anonymous callers spend a paid quota.
  // Each request carries the caller's own key (see auth.ts / index.ts).
}
