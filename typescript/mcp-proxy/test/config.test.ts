import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_URL, loadConfig, requestHeaders } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the hosted ko.io MCP URL with no API key", () => {
    const config = loadConfig({});
    expect(config.url).toBe(DEFAULT_MCP_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("picks up KO_API_KEY", () => {
    const config = loadConfig({ KO_API_KEY: "ko_live_abc" });
    expect(config.apiKey).toBe("ko_live_abc");
  });

  it("treats empty/whitespace KO_API_KEY as unset", () => {
    expect(loadConfig({ KO_API_KEY: "  " }).apiKey).toBeUndefined();
    expect(loadConfig({ KO_API_KEY: "" }).apiKey).toBeUndefined();
  });

  it("honors KO_MCP_URL override", () => {
    const config = loadConfig({ KO_MCP_URL: "http://localhost:8788/mcp" });
    expect(config.url).toBe("http://localhost:8788/mcp");
  });

  it("rejects an invalid URL", () => {
    expect(() => loadConfig({ KO_MCP_URL: "not a url" })).toThrow(/not a valid URL/);
  });

  it("rejects a non-http(s) URL", () => {
    expect(() => loadConfig({ KO_MCP_URL: "ftp://mcp.ko.io/mcp" })).toThrow(/http\(s\)/);
  });
});

describe("requestHeaders", () => {
  it("sends Authorization Bearer when an API key is configured", () => {
    expect(requestHeaders({ url: DEFAULT_MCP_URL, apiKey: "ko_live_abc" })).toEqual({
      Authorization: "Bearer ko_live_abc",
    });
  });

  it("sends no headers in demo mode", () => {
    expect(requestHeaders({ url: DEFAULT_MCP_URL })).toEqual({});
  });
});
