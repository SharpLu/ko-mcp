# Claude Code

Connect [ko.io](https://ko.io) to Claude Code in one command.

## Demo mode (no key)

```bash
claude mcp add ko-sec-data --transport http https://mcp.ko.io/mcp
```

Demo mode is limited to 100 requests/day and core SEC tools. Grab a free key
(200/day, no credit card) at <https://ko.io/console>.

## With your API key (recommended)

```bash
claude mcp add ko-sec-data --transport http https://mcp.ko.io/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

Or via query parameter (equivalent):

```bash
claude mcp add ko-sec-data --transport http "https://mcp.ko.io/mcp?api_key=YOUR_KEY"
```

## Verify

```
> claude
> /mcp                      # ko-sec-data should show "connected"
> who are the biggest institutional holders of NVDA?
```

Claude will call `get_stock_holders` and cite the underlying 13F filings.

## Local stdio alternative

If your environment blocks outbound streaming HTTP, use the stdio proxy:

```bash
claude mcp add ko-sec-data -- npx -y @ko-io/mcp-sec-data
```

Set `KO_API_KEY=ko_live_...` in the environment to use your quota.

## Troubleshooting

- `disconnected` → check corporate proxy allows `https://mcp.ko.io`.
- `403 ... requires a paid plan` → macro/short-interest tools are Pro+; core
  SEC tools (13F, insiders, Congress, stocks, crypto) work on Free.
- Quota resets at 00:00 UTC. Check usage at <https://ko.io/console>.
