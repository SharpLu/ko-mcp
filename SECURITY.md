# Security Policy

## Reporting a vulnerability

Please email **security@ko.io** with a description and reproduction steps.
Do not open a public issue for security reports. We aim to acknowledge within
48 hours.

## Scope

- This repository: SDKs, MCP stdio proxy, cookbook.
- The hosted service (api.ko.io, mcp.ko.io): also reportable via the same
  address.

## Notes for users

- Treat your API key like a password. Prefer the `Authorization: Bearer`
  header or the `KO_API_KEY` environment variable; avoid committing keys or
  embedding them in shared configs.
- Keys can be revoked instantly from the console at <https://ko.io/console>.
