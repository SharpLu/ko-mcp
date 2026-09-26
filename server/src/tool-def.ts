import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";

/**
 * Every ko.io tool only READS public SEC / market data from api.ko.io: it never
 * writes, deletes or changes anything, and its answer depends on an external
 * data source that changes as filings arrive (open world). Declared once so
 * all 24 tools advertise the same hints in tools/list.
 */
export const KO_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** What a handler returns: Markdown text, optional structured twin, optional error flag. */
export interface ToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolExtras {
  /** Declared only by tools whose every success path returns structuredContent. */
  outputSchema?: ZodRawShape;
  title?: string;
}

/**
 * `server.tool(name, description, inputSchema, handler)` with the annotations
 * (and, where the tool has one, the outputSchema) that `server.tool` cannot
 * carry. Same positional shape on purpose: the call sites read as before.
 *
 * Contract when `outputSchema` is set: the SDK REJECTS a success result without
 * structuredContent, or with structuredContent that does not validate -- so a
 * tool may only declare one if every non-error return path builds it.
 */
export function defineTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: (args: z.infer<z.ZodObject<Args>>) => Promise<ToolResultLike>,
  extras: ToolExtras = {},
): void {
  server.registerTool(
    name,
    {
      title: extras.title,
      description,
      inputSchema,
      outputSchema: extras.outputSchema,
      annotations: KO_TOOL_ANNOTATIONS,
    },
    // The SDK types the callback against the exact zod shapes; the 24 handlers
    // are typed at their own call sites, so this one boundary is erased.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler as any,
  );
}
