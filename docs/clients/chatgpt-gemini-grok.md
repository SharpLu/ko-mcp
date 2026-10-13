# ChatGPT, Gemini, Grok (REST)

Clients without MCP support can use the REST API directly — same data, same
quota.

## ChatGPT — Custom GPT Actions

1. Create a GPT → Configure → Actions → Import from URL:
   `https://ko.io/openapi.yaml`
2. Authentication: **API Key**, header `Authorization`, value
   `Bearer ko_live_your_key_here`.
3. Ask: *"Who are the top institutional holders of MSFT?"*

## Function calling (OpenAI / Gemini / Grok APIs)

Point your tool implementation at the REST API:

```python
import requests

def ko(path: str, **params) -> dict:
    return requests.get(
        f"https://api.ko.io/api/v1/{path}",
        params=params,
        headers={"Authorization": "Bearer ko_live_your_key_here"},
        timeout=30,
    ).json()

ko("institutions", search="berkshire")
```

Or use the official SDKs: [`ko-edgar` (Python)](../../python) ·
[`@ko-io/sdk` (TypeScript)](../../typescript/sdk).

## Demo mode

Append `?demo=true` to any endpoint for keyless evaluation (rate-limited per IP):

```bash
curl "https://api.ko.io/api/v1/institutions?search=berkshire&demo=true"
```

Full REST reference: <https://ko.io/docs>

## Government contracts

Ask: "Show Boeing's federal contract obligations and recent actions."
The client can use `get_gov_contracts` with `ticker: "BA", include: "actions"`.
For the Army in a fiscal year, add `fiscal_year: 2026, agency: "097", sub_agency: "2100"` (history requires Pro).
`search_gov_contracts` supports `view: "actions"` or `view: "companies"`.
Choose one window form. Free access covers the trailing 92 days.
Amounts are exact decimal strings. Links cover companies listed today plus reviewed links.
See [methodology](https://ko.io/datasets/gov-contracts/).
