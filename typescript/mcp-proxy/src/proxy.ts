import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { requestHeaders, type ProxyConfig } from "./config.js";
import { VERSION } from "./version.js";

/** Minimal surface of the remote MCP client the proxy depends on (injectable for tests). */
export interface RemoteClient {
  listTools(params?: { cursor?: string }): Promise<ListToolsResult>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type RemoteClientFactory = (config: ProxyConfig) => Promise<RemoteClient>;

/** Connect a real Streamable HTTP client to the hosted ko.io MCP server. */
export const connectRemote: RemoteClientFactory = async (config) => {
  const client = new Client(
    { name: "ko-mcp-sec-data-proxy", version: VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: requestHeaders(config) },
  });
  await client.connect(transport);
  return {
    listTools: (params) => client.listTools(params),
    callTool: (params) => client.callTool(params),
    close: () => client.close(),
  };
};

export function forwardListTools(
  remote: RemoteClient,
  params?: { cursor?: string },
): Promise<ListToolsResult> {
  return remote.listTools(params);
}

/** Forward a tool call; remote failures become isError results so the process never crashes. */
export async function forwardCallTool(
  remote: RemoteClient,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<CallToolResult> {
  try {
    return (await remote.callTool(params)) as CallToolResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Remote tool call "${params.name}" failed: ${message}` }],
    };
  }
}

export interface Proxy {
  server: Server;
  remote: RemoteClient;
  close(): Promise<void>;
}

/**
 * Build the local stdio-facing MCP server wired to a remote client.
 * The caller connects `proxy.server` to a transport (stdio in production,
 * in-memory in tests).
 */
export async function createProxy(
  config: ProxyConfig,
  factory: RemoteClientFactory = connectRemote,
): Promise<Proxy> {
  const remote = await factory(config);

  const server = new Server(
    { name: "ko-sec-data", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    forwardListTools(remote, request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    forwardCallTool(remote, request.params),
  );

  return {
    server,
    remote,
    close: async () => {
      await server.close().catch(() => undefined);
      await remote.close().catch(() => undefined);
    },
  };
}
