import { describe, it, expect } from "vitest";
import worker from "../index.js";

// GET /mcp is the Streamable HTTP "standalone SSE stream". This server is
// stateless and never pushes server-initiated messages, so it must answer 405
// (spec-sanctioned) instead of opening a stream nobody writes to. The old
// behaviour made the Workers runtime cancel the request as hung, and every MCP
// client reconnected immediately: 7.29M wasted, errored invocations / 30 days.
const env = { KO_API_URL: "https://api.ko.io" } as unknown as Env;
const ctx = {} as ExecutionContext;

const sseGet = () =>
  new Request("https://mcp.ko.io/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-11-25", "user-agent": "claude-code/2.1.280 (cli)" },
  });

describe("GET /mcp (standalone SSE stream)", () => {
  it("answers 405 with a finite body instead of an open stream", async () => {
    const res = await worker.fetch(sseGet(), env, ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-type")).not.toMatch(/event-stream/);
    expect(res.headers.get("allow")).toBe("POST, DELETE, OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // An open SSE stream would never resolve here; a 2s test timeout catches a regression.
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  }, 2000);

  it("405s regardless of Accept (no path back into the SDK's GET handler)", async () => {
    for (const accept of ["*/*", "application/json, text/event-stream"]) {
      const res = await worker.fetch(new Request("https://mcp.ko.io/mcp", { headers: { accept } }), env, ctx);
      expect(res.status).toBe(405);
    }
  });

  it("negative control: POST /mcp initialize still works", async () => {
    const res = await worker.fetch(
      new Request("https://mcp.ko.io/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("ko-sec-data");
  });

  it("negative control: /health and OPTIONS are untouched", async () => {
    expect((await worker.fetch(new Request("https://mcp.ko.io/health"), env, ctx)).status).toBe(200);
    expect((await worker.fetch(new Request("https://mcp.ko.io/mcp", { method: "OPTIONS" }), env, ctx)).status).toBe(204);
  });
});
