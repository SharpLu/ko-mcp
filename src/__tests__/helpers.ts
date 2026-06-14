import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CapturedTool {
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/** A minimal stand-in for McpServer that records server.tool(...) registrations. */
export function makeFakeServer() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: CapturedTool["handler"]) => {
      tools.set(name, { description, schema, handler });
    },
  };
  return { server: server as unknown as McpServer, tools };
}

export function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}
