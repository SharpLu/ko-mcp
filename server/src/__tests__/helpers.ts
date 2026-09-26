import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface CapturedTool {
  description: string;
  schema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * A minimal stand-in for McpServer that records tool registrations -- both the
 * legacy `server.tool(name, description, schema, handler)` and the
 * `server.registerTool(name, config, handler)` every tool now uses (it is the
 * only form that carries annotations and outputSchema).
 */
export function makeFakeServer() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: CapturedTool["handler"]) => {
      tools.set(name, { description, schema, handler });
    },
    registerTool: (
      name: string,
      config: { description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> },
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, {
        description: config.description ?? "",
        schema: config.inputSchema ?? {},
        outputSchema: config.outputSchema,
        annotations: config.annotations,
        handler,
      });
    },
  };
  return { server: server as unknown as McpServer, tools };
}

export function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}
