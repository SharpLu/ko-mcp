# Windsurf

Cascade → MCP → add server, or edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "serverUrl": "https://mcp.ko.io/mcp"
    }
  }
}
```

With your API key (free at <https://ko.io/console>):

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "serverUrl": "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
    }
  }
}
```

## Local stdio alternative

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "command": "npx",
      "args": ["-y", "@ko-io/mcp-sec-data"],
      "env": { "KO_API_KEY": "ko_live_your_key_here" }
    }
  }
}
```

## Verify

Refresh the MCP panel; `ko-sec-data` should list its tools. Ask Cascade:
*"Show insider buys at NVDA in the last 90 days."*

## Government contracts

Ask: "Show Boeing's federal contract obligations and recent actions."
The client can use `get_gov_contracts` with `ticker: "BA", include: "actions"`.
For the Army in a fiscal year, add `fiscal_year: 2026, agency: "097", sub_agency: "2100"` (history requires Pro).
`search_gov_contracts` supports `view: "actions"` or `view: "companies"`.
Choose one window form. Free access covers the trailing 92 days.
Amounts are exact decimal strings. Links cover companies listed today plus reviewed links.
See [methodology](https://ko.io/datasets/gov-contracts/).
