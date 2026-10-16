# Zed

Add to `settings.json` (`cmd-,` / `ctrl-,`):

```json
{
  "context_servers": {
    "ko-sec-data": {
      "source": "custom",
      "url": "https://mcp.ko.io/mcp"
    }
  }
}
```

With your API key (free at <https://ko.io/console>):

```json
{
  "context_servers": {
    "ko-sec-data": {
      "source": "custom",
      "url": "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
    }
  }
}
```

## Local stdio alternative

```json
{
  "context_servers": {
    "ko-sec-data": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@ko-io/mcp-sec-data"],
      "env": { "KO_API_KEY": "ko_live_your_key_here" }
    }
  }
}
```

## Verify

Open the Agent Panel; `ko-sec-data` appears under context servers. Ask:
*"Which institutions added AAPL last quarter?"*

## Government contracts

Ask: "Show Boeing's federal contract obligations and recent actions."
The client can use `get_gov_contracts` with `ticker: "BA", include: "actions"`.
For the Army in a fiscal year, add `fiscal_year: 2026, agency: "097", sub_agency: "2100"` (history requires Pro).
`search_gov_contracts` supports `view: "actions"` or `view: "companies"`.
Choose one window form. Free access covers the trailing 92 days.
Amounts are exact decimal strings. Links cover companies listed today plus reviewed links.
See [methodology](https://ko.io/datasets/gov-contracts/).
