import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { createProxy, forwardCallTool, forwardListTools, type RemoteClient } from "../src/proxy.js";

const TOOLS: ListToolsResult = {
  tools: [
    {
      name: "search",
      description: "Search ko.io entities",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    {
      name: "get_stock_price",
      description: "Daily prices",
      inputSchema: { type: "object", properties: { ticker: { type: "string" } } },
    },
  ],
};

function fakeRemote(overrides: Partial<RemoteClient> = {}): RemoteClient {
  return {
    listTools: vi.fn(async () => TOOLS),
    callTool: vi.fn(async (params) => ({
      content: [{ type: "text", text: `called ${params.name}` }],
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("forwarding logic", () => {
  it("passes ListTools through verbatim, including cursor", async () => {
    const remote = fakeRemote();
    const result = await forwardListTools(remote, { cursor: "page2" });
    expect(result).toBe(TOOLS);
    expect(remote.listTools).toHaveBeenCalledWith({ cursor: "page2" });
  });

  it("passes CallTool through verbatim", async () => {
    const remote = fakeRemote();
    const result = await forwardCallTool(remote, { name: "search", arguments: { q: "nvda" } });
    expect(remote.callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "nvda" } });
    expect(result.content).toEqual([{ type: "text", text: "called search" }]);
    expect(result.isError).toBeUndefined();
  });

  it("converts remote errors into isError results instead of throwing", async () => {
    const remote = fakeRemote({
      callTool: vi.fn(async () => {
        throw new Error("remote exploded");
      }),
    });
    const result = await forwardCallTool(remote, { name: "search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: 'Remote tool call "search" failed: remote exploded' },
    ]);
  });

  it("stringifies non-Error throwables", async () => {
    const remote = fakeRemote({
      callTool: vi.fn(async () => {
        throw "plain string failure";
      }),
    });
    const result = await forwardCallTool(remote, { name: "search" });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("plain string failure");
  });
});

describe("createProxy", () => {
  const config = { url: "https://mcp.ko.io/mcp", apiKey: "ko_live_test" };

  it("uses the injected factory and closes the remote on close()", async () => {
    const remote = fakeRemote();
    const factory = vi.fn(async () => remote);
    const proxy = await createProxy(config, factory);
    expect(factory).toHaveBeenCalledWith(config);
    await proxy.close();
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("fails startup with a clear error when the remote connect exceeds the timeout", async () => {
    const neverConnects = () => new Promise<RemoteClient>(() => undefined);
    await expect(
      createProxy({ ...config, connectTimeoutMs: 25 }, neverConnects),
    ).rejects.toThrow(/Timed out connecting to https:\/\/mcp\.ko\.io\/mcp after 25ms/);
  });

  it("does not advertise tools.listChanged (stateless remote cannot push it)", async () => {
    const proxy = await createProxy(config, async () => fakeRemote());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.tools?.listChanged).toBeUndefined();

    await client.close();
    await proxy.close();
  });

  it("serves remote tools to a real MCP client over an in-memory transport", async () => {
    const remote = fakeRemote();
    const proxy = await createProxy(config, async () => remote);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["search", "get_stock_price"]);

    const called = await client.callTool({ name: "search", arguments: { q: "berkshire" } });
    expect(called.content).toEqual([{ type: "text", text: "called search" }]);

    await client.close();
    await proxy.close();
  });

  it("returns isError results end-to-end when the remote call fails", async () => {
    const remote = fakeRemote({
      callTool: vi.fn(async () => {
        throw new Error("upstream 503");
      }),
    });
    const proxy = await createProxy(config, async () => remote);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "search", arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
    await proxy.close();
  });
});
