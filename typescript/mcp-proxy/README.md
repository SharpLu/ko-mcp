# @ko-io/mcp-sec-data

Local **stdio** MCP server that transparently proxies to the hosted [ko.io](https://ko.io) MCP server at `https://mcp.ko.io/mcp` — SEC 13F institutional holdings, insider trades, congress trading, crypto ETF exposure and macro data as MCP tools.

## When to use this

**Prefer the remote HTTP server when your client supports it** — it needs no local process:

```bash
claude mcp add ko-sec-data --transport http https://mcp.ko.io/mcp
```

Use this package only when your MCP client speaks **stdio only** (no remote/Streamable HTTP support). It runs locally, forwards every `tools/list` and `tools/call` to the hosted server, and streams results back verbatim.

## Usage

```bash
npx -y @ko-io/mcp-sec-data
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "command": "npx",
      "args": ["-y", "@ko-io/mcp-sec-data"],
      "env": { "KO_API_KEY": "ko_live_..." }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ko-sec-data": {
      "command": "npx",
      "args": ["-y", "@ko-io/mcp-sec-data"],
      "env": { "KO_API_KEY": "ko_live_..." }
    }
  }
}
```

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `KO_API_KEY` | no | — | ko.io API key (`ko_live_...`). Without it the remote serves keyless **demo mode** with capped rows. Get a key at [ko.io](https://ko.io). |
| `KO_MCP_URL` | no | `https://mcp.ko.io/mcp` | Remote MCP endpoint override. |

## Notes

- Diagnostics go to stderr; stdout is reserved for the MCP protocol.
- Remote tool failures are returned as `isError` tool results — the local process never crashes on upstream errors.
- `--version` / `--help` are supported.

Looking for a plain REST client instead? See [`@ko-io/sdk`](https://www.npmjs.com/package/@ko-io/sdk).

MIT License.
