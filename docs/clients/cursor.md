# Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "url": "https://mcp.ko.io/mcp"
    }
  }
}
```

With your API key (free at <https://ko.io/console>):

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "url": "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
    }
  }
}
```

## Verify

Settings → MCP → `ko-sec-data` should show a green dot and the tool list.
In chat (Agent mode), ask: *"Pull Berkshire Hathaway's latest 13F holdings."*

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
