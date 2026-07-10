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
