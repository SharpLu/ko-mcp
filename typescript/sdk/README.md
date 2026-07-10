# @ko-io/sdk

Typed TypeScript client for the [ko.io](https://ko.io) financial data API — SEC 13F institutional holdings, insider trades (Form 4), congress trading, crypto ETF exposure, short-side data and macro series.

- Zero runtime dependencies — works on Node 18+, browsers and edge workers (global `fetch`).
- Typed errors, automatic retries (502/503/504 + network errors), request timeout.
- Keyless demo mode out of the box; add an API key for full access.

```bash
npm install @ko-io/sdk
```

## Quick start (demo mode, no key)

```ts
import { KoClient } from "@ko-io/sdk";

const ko = new KoClient(); // no key -> demo mode (capped rows)

const { rows } = await ko.institutions.list({ search: "berkshire" });
console.log(rows);

const price = await ko.stocks.price("NVDA", { days: 30 });
console.log(price.rows.length, "days of prices");
```

## With an API key

Set `KO_API_KEY` in the environment (picked up automatically), or pass it explicitly. Get a key at [ko.io](https://ko.io).

```ts
const ko = new KoClient({ apiKey: "ko_live_..." });

const holdings = await ko.institutions.holdings("1067983", { perPage: 100 });
console.log(holdings.meta.total_count, "positions");
if (holdings.truncated) console.log(holdings.meta.upgrade_hint);

// Every method returns { data, meta, rows, truncated }.
// `rows` is always an array regardless of the endpoint's envelope shape.
```

## Error handling

```ts
import { KoClient, RateLimitError, PlanRequiredError, NotFoundError } from "@ko-io/sdk";

const ko = new KoClient();
try {
  await ko.macro.treasuryYields({ days: 90 }); // Pro plan or higher
} catch (err) {
  if (err instanceof PlanRequiredError) console.log("Upgrade needed:", err.message);
  else if (err instanceof RateLimitError) console.log(`Retry in ${err.retryAfter}s`);
  else if (err instanceof NotFoundError) console.log("Not found");
  else throw err;
}
```

## API surface

| Namespace | Methods |
|---|---|
| `ko.search(q, opts)` | full-text search |
| `ko.institutions` | `list`, `get`, `holdings`, `quarters`, `activity`, `similar` |
| `ko.stocks` | `list`, `get`, `price`, `holders`, `activity`, `financials`, `financialsHistory` |
| `ko.insiders` | `trades`, `byCompany`, `get`, `transactions`, `executiveTrades` |
| `ko.congress` | `trades`, `member`, `stock` |
| `ko.crypto` | `exposureSummary`, `holders`, `holder` |
| `ko.form144` | `list` |
| `ko.short` | `ftd`, `regSho` |
| `ko.macro` | `treasuryYields`, `fedRates`, `economicIndicators`, `financialStress` (Pro+) |
| `ko.filings` | `list`, `index`, `share` (EDGAR gateway) |
| `ko.get(path, params)` | raw escape hatch for any endpoint |

## Configuration

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `KO_API_KEY` | none (demo mode) |
| `baseUrl` | `KO_API_URL` | `https://api.ko.io` |
| `timeoutMs` | — | `30000` |
| `maxRetries` | — | `2` |
| `fetch` | — | global `fetch` |

Prefer MCP? ko.io also ships a hosted MCP server at `https://mcp.ko.io/mcp` and a stdio bridge: [`@ko-io/mcp-sec-data`](https://www.npmjs.com/package/@ko-io/mcp-sec-data).

MIT License.
