import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch, KoApiError } from "../ko-fetch.js";
import { registerCongressTools } from "../tools/congress.js";

const mock = vi.mocked(koFetch);
const config = { baseUrl: "https://api.ko.io", apiKey: "" };
// Public ko-api mccaul response, 2026-10-09. No live fetch in this suite.
const note = "139 disclosure filings were filed on paper; those are published as scans, are not machine-readable, and any trades they contain are absent from this response.";
const coverage = { paper_filings: 139, note };
const softwall = { row_cap: 25, returned: 0, truncated: false, continuation: "SIGNIN_REQUIRED" };
const trade = {
  member_name: "Example Member", chamber: "house", ticker: "AAPL", asset_description: "Apple",
  transaction_type: "purchase", transaction_date: "2026-09-01", disclosure_date: "2026-09-15",
  amount_range: "$1,001 - $15,000", owner: "self",
};

async function call(page = 1) {
  const server = new McpServer({ name: "test", version: "0" });
  registerCongressTools(server, config);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await client.listTools(); // Enforce the real output schema on both sides.
    const result = await client.callTool({ name: "get_congress_member", arguments: { member: "mccaul", page, limit: 5 } });
    return { result, text: (result.content as Array<{ text: string }>).map(c => c.text).join("\n") };
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => { mock.mockReset(); });

describe("congress member coverage", () => {
  it("explains paper-only filings without claiming zero trades or rendering an empty table", async () => {
    mock.mockResolvedValue({ data: [], meta: { total_count: 0, coverage, softwall } });
    const { result, text } = await call();
    expect(result.isError).not.toBe(true);
    expect(text).toContain("No machine-readable trades returned for this member.");
    expect(text).toContain(`**Coverage:** ${note}`);
    expect(text).not.toContain("0 trades");
    expect(text).not.toContain("| Date |");
    expect(text).not.toContain("page=2");
    expect(result.structuredContent).toMatchObject({
      member: "mccaul", coverage, rows: [],
      paging: { returned: 0, total_count: 0, next_page: null },
      plan_limit: { continuation: "SIGNIN_REQUIRED" },
    });
    expect(mock).toHaveBeenCalledWith(config, "/api/v1/congress-trades/mccaul",
      { type: "trades", page: 1, per_page: 5 }, { envelope: true });
  });

  it.each([[], { data: [], meta: {} }])("handles legacy empty payloads without inventing coverage", async payload => {
    mock.mockResolvedValue(payload);
    const { result, text } = await call();
    expect(result.isError).not.toBe(true);
    expect(text).toContain("No machine-readable trades returned");
    expect(text).not.toContain("0 trades");
    expect(text).not.toContain("| Date |");
    expect(text).not.toContain("**Coverage:**");
    expect(result.structuredContent).toMatchObject({ coverage: null, rows: [] });
  });

  it("preserves unknown paper coverage as null", async () => {
    const unknown = { paper_filings: null, note: "No machine-readable disclosures for this member." };
    mock.mockResolvedValue({ data: [], meta: { coverage: unknown } });
    const { result, text } = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ coverage: unknown });
    expect(text).toContain(unknown.note);
  });

  it("keeps populated rows, paper caveats, and keyless paging together", async () => {
    mock.mockResolvedValue({ data: [trade], meta: {
      total_count: 73, per_page: 1, coverage: { ...coverage, paper_filings: "139" }, softwall,
    } });
    const { result, text } = await call();
    expect(result.isError).not.toBe(true);
    expect(text).toContain("*1 trades returned*");
    expect(text).toContain("| Date | Ticker |");
    expect(text).toContain(`**Coverage:** ${note}`);
    expect(text).not.toContain("No machine-readable trades");
    expect(text).toContain("SIGNIN_REQUIRED");
    expect(text).not.toContain("use page=2");
    expect(result.structuredContent).toMatchObject({ coverage, rows: [trade], paging: { next_page: null } });
  });

  it("does not print a coverage label when the upstream note is null", async () => {
    mock.mockResolvedValue({ data: [trade], meta: { coverage: { paper_filings: 0, note: null } } });
    const { result, text } = await call();
    expect(result.isError).not.toBe(true);
    expect(text).not.toContain("**Coverage:**");
    expect(result.structuredContent).toMatchObject({ coverage: { paper_filings: 0, note: null } });
  });

  it("preserves plan refusals as errors instead of reporting missing trades", async () => {
    mock.mockRejectedValue(new KoApiError("SIGNIN_REQUIRED: sign in to page further", 403, "SIGNIN_REQUIRED", null));
    const { result, text } = await call(2);
    expect(result.isError).toBe(true);
    expect(text).toContain("SIGNIN_REQUIRED");
    expect(text).not.toContain("No machine-readable trades");
  });
});
