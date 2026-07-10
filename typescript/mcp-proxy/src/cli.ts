#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createProxy } from "./proxy.js";
import { VERSION } from "./version.js";

const HELP = `ko-mcp-sec-data v${VERSION}
Local stdio MCP server bridging to the hosted ko.io MCP server.

Usage:
  npx -y @ko-io/mcp-sec-data

Environment:
  KO_API_KEY   ko.io API key (optional; without it the remote serves demo mode)
  KO_MCP_URL   remote MCP endpoint (default: https://mcp.ko.io/mcp)

Options:
  --version, -v   print version
  --help, -h      show this help
`;

// stdout is the MCP protocol channel — all diagnostics go to stderr.
function log(message: string): void {
  process.stderr.write(`[ko-mcp-sec-data] ${message}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  log(`v${VERSION} connecting to ${config.url} (${config.apiKey ? "API key auth" : "demo mode, set KO_API_KEY for full access"})`);

  const proxy = await createProxy(config);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await proxy.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await proxy.server.connect(new StdioServerTransport());
  log("ready — proxying MCP over stdio");
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
