# OpenAI Codex CLI

```bash
codex mcp add ko-sec-data --url https://mcp.ko.io/mcp
```

With your API key (free at <https://ko.io/console>), append it to the URL:

```bash
codex mcp add ko-sec-data --url "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
```

Or configure in `~/.codex/config.toml`:

```toml
[mcp_servers.ko-sec-data]
url = "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
```

## Local stdio alternative

```toml
[mcp_servers.ko-sec-data]
command = "npx"
args = ["-y", "@ko-io/mcp-sec-data"]

[mcp_servers.ko-sec-data.env]
KO_API_KEY = "ko_live_your_key_here"
```

## Verify

```
codex
> /mcp                # ko-sec-data listed with its tools
> what are the latest Form 144 notices for TSLA?
```
