# ko-edgar

Official Python SDK for [ko.io](https://ko.io) — source-traced SEC & market
data for AI agents and quants. 13F institutional holdings (88M+ rows,
2013→today), insider trades, Congress trading, crypto ETF exposure, macro
indicators, and a white-labeled EDGAR filings gateway.

```bash
pip install ko-edgar
```

## Quickstart

Works out of the box in keyless demo mode — no signup required:

```python
from ko_edgar import KoClient

ko = KoClient()  # demo mode; or KoClient(api_key="ko_live_...")

# Who is Berkshire Hathaway holding right now?
for holding in ko.institutions.holdings("1067983", per_page=10):
    print(holding["ticker"], holding["holding_value"])

# Which institutions hold NVDA?
for holder in ko.stocks.holders("NVDA"):
    print(holder["name"], holder["shares_held"])

# What did Congress trade recently?
for trade in ko.congress.trades(sort="recent", per_page=10):
    print(trade["member_name"], trade["ticker"], trade["transaction_type"])
```

Get a free API key (200 calls/day, no credit card) at
[ko.io/console](https://ko.io/console), then:

```python
ko = KoClient(api_key="ko_live_...")   # or set KO_API_KEY env var
```

## Async

```python
from ko_edgar import AsyncKoClient

async with AsyncKoClient() as ko:
    result = await ko.stocks.activity("NVDA", quarters=8)
```

## Pagination

```python
from ko_edgar import KoClient, paginate

ko = KoClient()
for trade in paginate(ko.congress.trades, ticker="NVDA", per_page=100):
    ...
```

## Results and errors

Every method returns an `ApiResult`: iterate it for rows, or use
`result.data` / `result.meta` for the raw envelope. `result.truncated` tells
you when the plan's row cap trimmed the response.

```python
from ko_edgar import KoClient, PlanRequiredError, RateLimitError

ko = KoClient()
try:
    yields = ko.macro.treasury_yields(days=90)   # requires Pro
except PlanRequiredError:
    print("macro data needs a Pro plan → https://ko.io/pricing")
except RateLimitError as e:
    print(f"quota resets in {e.retry_after}s")
```

## Escape hatch

Any `/api/v1` endpoint not covered by a typed method:

```python
ko.get("/api/v1/exec-compensation", ticker="AAPL", ceo_only=True)
```

## Changes (unreleased)

- Added U.S. federal prime-contract obligations (FY2015+): five SDK methods, including coverage.

- **Removed** the `party` argument from `congress.trades()` (sync and async).
  The API has no party filter; the argument was sent and silently ignored,
  returning trades from every party. Filter by `chamber`, `ticker` or member
  name (`search`) instead.
- `macro.financial_stress()` (sync and async) accepts `page` / `per_page`, so it
  works with `paginate()`.

## Releases

Publishing to PyPI from CI is not set up yet (the PyPI Trusted Publisher is not
configured), so a GitHub Release does not publish this package. The current
PyPI release, 0.1.0, was uploaded manually.

## Links

- Docs: <https://ko.io/docs>
- MCP server (same data inside Claude/Cursor/any agent): <https://ko.io/mcp>
- Repository: <https://github.com/SharpLu/ko-mcp>

MIT licensed.

## Government contracts (0.2.0)

Added: U.S. federal prime-contract obligations (FY2015+) by public company.
Five methods cover company summaries, attributed transactions, action search, company rankings, and coverage.

```python
with KoClient() as ko:
    result = ko.gov_contracts.company("BA")
    actions = ko.gov_contracts.transactions("BA", per_page=50)
    feed = ko.gov_contracts.search(agency="097", sub_agency="2100")
    ranking = ko.gov_contracts.companies(agency="097", sort="gross")
    coverage = ko.gov_contracts.coverage()

async with AsyncKoClient() as ko:
    result = await ko.gov_contracts.company("BA")
```

The async namespace has the same five methods and arguments. Use `from_` for the REST `from` parameter.

Use one window form: period, fiscal year, or from/to. Omitting it uses the API default.
Free access covers the trailing 92 days. History requires Pro.
Amounts stay exact two-decimal strings, including negative obligations and large values.
For arithmetic, use a decimal library. Do not cast amounts to binary floating point.
Award queries retain `meta.identity`, `meta.scope`, `meta.refreshed_at`, and `meta.caveats` even when `data` is empty.
Award context is issuer-scoped: metadata from this company's latest attributed action; attributed totals are plan-gated.
Automatic links cover companies listed today, plus reviewed links. No link is not proof of no contracts.
[Methodology](https://ko.io/datasets/gov-contracts/).
