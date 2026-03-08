import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerInstitutionTools } from "./tools/institutions.js";
import { registerStockTools } from "./tools/stocks.js";
import { registerInsiderTools } from "./tools/insiders.js";
import { registerCongressTools } from "./tools/congress.js";
import { registerSearchTool } from "./tools/search.js";
import type { KoConfig } from "./ko-fetch.js";

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "ko-sec-data",
    version: "1.0.0",
  });

  const config: KoConfig = {
    baseUrl: env.KO_API_URL || "https://api.ko.io",
    apiKey: env.KO_API_KEY || "",
  };

  registerInstitutionTools(server, config);
  registerStockTools(server, config);
  registerInsiderTools(server, config);
  registerCongressTools(server, config);
  registerSearchTool(server, config);

  return server;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "ko-mcp-server" });
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });

      await server.connect(transport);
      const response = await transport.handleRequest(req);

      // Add CORS headers
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        headers.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
