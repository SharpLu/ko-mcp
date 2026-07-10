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
