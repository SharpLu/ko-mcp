# Contributing

Thanks for your interest in improving the ko.io connector kit!

## What lives here

This repository contains everything that faces an MCP client or SDK user:
`server/` — the Cloudflare Worker behind the hosted MCP endpoint
`https://mcp.ko.io/mcp` (24 tools, deployed from this repo) — plus the Python
SDK (`ko-edgar`), the TypeScript SDK (`@ko-io/sdk`), the stdio MCP proxy
(`@ko-io/mcp-sec-data`), per-client setup guides, and the cookbook. Only the
data pipelines behind `api.ko.io` live elsewhere.

## Development setup

### MCP server (Cloudflare Worker)

```bash
cd server
npm ci
npm run type-check
npm test          # vitest; unit tests never touch the network
```

Adding, renaming or removing a tool means updating `EXPECTED_TOOLS` in
`server/src/__tests__/tools-proxy.test.ts` — the tool-count gate fails otherwise.

### Python SDK

```bash
cd python
pip install -e ".[dev]"
pytest          # run tests
ruff check src tests
mypy src
```

### TypeScript packages

```bash
cd typescript/sdk        # or typescript/mcp-proxy
npm install
npm run build
npm test
```

## Guidelines

- Keep the SDKs **thin**: typed access to the REST API, no analytics logic.
- Every new SDK method needs a test and a docstring with a runnable example.
- Cookbook examples must run end-to-end with a free API key
  (`python cookbook/<example>.py`).
- No secrets in code or fixtures. Use `KO_API_KEY` from the environment.

## Reporting issues

- MCP server / SDK / proxy bugs → GitHub issues here.
- Data questions or API bugs → feedback console at <https://ko.io/console/feedback>.
- Security issues → see [SECURITY.md](SECURITY.md).
