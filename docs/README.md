# ko-mcp documentation

Start with the [project README](../README.md) for the hosted connector and
[AGENTS.md](../AGENTS.md) for repository rules and verification requirements.

## Connect a client

- [Claude Code](clients/claude-code.md)
- [Claude Desktop](clients/claude-desktop.md)
- [Codex](clients/codex.md)
- [Cursor](clients/cursor.md)
- [Windsurf](clients/windsurf.md)
- [Zed](clients/zed.md)
- [ChatGPT, Gemini, and Grok via REST](clients/chatgpt-gemini-grok.md)

## Packages and examples

| Document | Purpose |
| --- | --- |
| [MCP server](../server/README.md) | Hosted tools and connection examples |
| [Python SDK](../python/README.md) | Sync/async client and pagination; published with the PyPI package |
| [TypeScript SDK](../typescript/sdk/README.md) | REST client; published with the npm package |
| [stdio MCP proxy](../typescript/mcp-proxy/README.md) | Local proxy; published with the npm package |
| [Cookbook](../cookbook/README.md) | Runnable SDK examples |

## Development and operations

- [Contributing](CONTRIBUTING.md): package setup and local checks
- [Golden contract](../server/docs/GOLDEN_CONTRACT.md): fixture policy, provenance, and refresh procedure
- [Deploy and rollback](deploy-rollback.md): hosted server recovery
- [Security policy](../SECURITY.md)
- [Agent entry point](../CLAUDE.md), [tool workflow](../.claude/skills/new-tool/SKILL.md), and [PR template](../.github/pull_request_template.md)

## Where new documents belong

Keep maintained guides in `docs/` and client setup in `docs/clients/`. Keep package
READMEs with their packages and the golden-contract guide with the server.
Put dated investigations and reviews in `docs/reports/`; put superseded plans in
`docs/archive/`, with their status and replacement recorded. Create those directories
when needed and link new documents from this index. Root Markdown is limited to
README, AGENTS, CLAUDE, and any changelog, license, or security policy.
