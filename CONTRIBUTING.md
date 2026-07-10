# Contributing

Thanks for your interest in improving the ko.io connector kit!

## What lives here

This repository contains the **client-side** tooling for [ko.io](https://ko.io):
the Python SDK (`ko-sec`), the TypeScript SDK (`@ko-io/sdk`), the stdio MCP
proxy (`@ko-io/mcp`), per-client setup guides, and the cookbook. The hosted MCP
server and data pipelines are not part of this repo.

## Development setup

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

- SDK / proxy bugs → GitHub issues here.
- Data questions or API bugs → feedback console at <https://ko.io/console/feedback>.
- Security issues → see [SECURITY.md](SECURITY.md).
