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

Or use the official SDKs: [`ko-sec` (Python)](../../python) ·
[`@ko-io/sdk` (TypeScript)](../../typescript/sdk).

## Demo mode

Append `?demo=true` to any endpoint for keyless evaluation (rate-limited per IP):

```bash
curl "https://api.ko.io/api/v1/institutions?search=berkshire&demo=true"
```

Full REST reference: <https://ko.io/docs>
