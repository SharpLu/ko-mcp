import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerInstitutionTools } from "./tools/institutions.js";
import { registerStockTools } from "./tools/stocks.js";
import { registerInsiderTools } from "./tools/insiders.js";
import { registerCongressTools } from "./tools/congress.js";
import { registerSearchTool } from "./tools/search.js";
import { registerForm144Tools } from "./tools/form144.js";
import { registerFilingTools } from "./tools/filings.js";
import { registerFinancialTools } from "./tools/financials.js";
import { registerMacroTools } from "./tools/macro.js";
import { registerCryptoTools } from "./tools/crypto.js";
import { extractUserKey, resolveApiKey } from "./auth.js";
import type { KoConfig } from "./ko-fetch.js";

function createServer(env: Env, userApiKey?: string): McpServer {
  const server = new McpServer({
    name: "ko-sec-data",
    version: "1.1.0",
  });

  const config: KoConfig = {
    baseUrl: env.KO_API_URL || "https://api.ko.io",
    // No env.KO_API_KEY fallback by design: a missing user key -> "" -> koFetch
    // uses ?demo=true (free tier, rate-limited at ko-api). Falling back to a
    // deployment key would let anonymous callers spend a shared paid quota.
    apiKey: resolveApiKey(userApiKey),
  };

  registerInstitutionTools(server, config);
  registerStockTools(server, config);
  registerInsiderTools(server, config);
  registerCongressTools(server, config);
  registerSearchTool(server, config);
  registerForm144Tools(server, config);
  registerFilingTools(server, config);
  registerFinancialTools(server, config);
  registerMacroTools(server, config);
  registerCryptoTools(server, config);

  return server;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ko-api-key, mcp-session-id, mcp-protocol-version",
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
      const server = createServer(env, extractUserKey(req));
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
