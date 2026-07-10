# ko-sec

Official Python SDK for [ko.io](https://ko.io) — source-traced SEC & market
data for AI agents and quants. 13F institutional holdings (85M+ rows,
2013→today), insider trades, Congress trading, crypto ETF exposure, macro
indicators, and a white-labeled EDGAR filings gateway.

```bash
pip install ko-sec
```

## Quickstart

Works out of the box in keyless demo mode — no signup required:

```python
from ko_sec import KoClient

ko = KoClient()  # demo mode; or KoClient(api_key="ko_live_...")

# Who is Berkshire Hathaway holding right now?
for holding in ko.institutions.holdings("1067983", per_page=10):
    print(holding["ticker"], holding["value"])

# Which institutions hold NVDA?
for holder in ko.stocks.holders("NVDA"):
    print(holder["institution_name"], holder["shares"])

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
from ko_sec import AsyncKoClient

async with AsyncKoClient() as ko:
    result = await ko.stocks.activity("NVDA", quarters=8)
```

## Pagination

```python
from ko_sec import KoClient, paginate

ko = KoClient()
for trade in paginate(ko.congress.trades, ticker="NVDA", per_page=100):
    ...
```

## Results and errors

Every method returns an `ApiResult`: iterate it for rows, or use
`result.data` / `result.meta` for the raw envelope. `result.truncated` tells
you when the plan's row cap trimmed the response.

```python
from ko_sec import KoClient, PlanRequiredError, RateLimitError

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

## Links

- Docs: <https://ko.io/docs>
- MCP server (same data inside Claude/Cursor/any agent): <https://ko.io/mcp>
- Repository: <https://github.com/SharpLu/ko-mcp>

MIT licensed.
