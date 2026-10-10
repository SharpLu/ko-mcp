# Claude Desktop

Two ways to connect: remote HTTP (zero install) or local stdio via `npx`.

## Option A — Remote HTTP (recommended)

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "type": "http",
      "url": "https://mcp.ko.io/mcp"
    }
  }
}
```

To use your own plan and quota, append the key to the URL:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "type": "http",
      "url": "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
    }
  }
}
```

## Option B — Local stdio proxy

If your Claude Desktop version doesn't support remote HTTP servers:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "command": "npx",
      "args": ["-y", "@ko-io/mcp-sec-data"],
      "env": {
        "KO_API_KEY": "ko_live_your_key_here"
      }
    }
  }
}
```

Requires Node.js 18+. Omit `env` to run in demo mode (rate-limited per IP).

## Verify

Restart Claude Desktop, open a new chat, and look for the tools icon
(🔨). Ask: *"What did Congress members trade last month?"*

## Notes

- Free keys: 200 calls/day at <https://ko.io/console>, no credit card.
- Config file locations: macOS
  `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows
  `%APPDATA%\Claude\claude_desktop_config.json`.

## Government contracts

Ask: "Show Boeing's federal contract obligations and recent actions."
The client can use `get_gov_contracts` with `ticker: "BA", include: "actions"`.
For the Army in a fiscal year, add `fiscal_year: 2026, agency: "097", sub_agency: "2100"` (history requires Pro).
`search_gov_contracts` supports `view: "actions"` or `view: "companies"`.
Choose one window form. Free access covers the trailing 92 days.
Amounts are exact decimal strings. Links cover companies listed today plus reviewed links.
See [methodology](https://ko.io/datasets/gov-contracts/).
