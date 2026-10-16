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

## Government contracts

Ask: "Show Boeing's federal contract obligations and recent actions."
The client can use `get_gov_contracts` with `ticker: "BA", include: "actions"`.
For the Army in a fiscal year, add `fiscal_year: 2026, agency: "097", sub_agency: "2100"` (history requires Pro).
`search_gov_contracts` supports `view: "actions"` or `view: "companies"`.
Choose one window form. Free access covers the trailing 92 days.
Amounts are exact decimal strings. Links cover companies listed today plus reviewed links.
See [methodology](https://ko.io/datasets/gov-contracts/).
