import { describe, it, expect, vi, beforeEach } from "vitest";
import { koFetch } from "../ko-fetch.js";

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function calledUrl(): URL {
  return new URL(fetchMock.mock.calls[0][0] as string);
}
function calledHeaders(): Record<string, string> {
  return (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
}

describe("koFetch demo fallback", () => {
  it("uses ?demo=true and sends NO Authorization when apiKey is empty", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [] }));
    await koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/api/v1/institutions", {});
    expect(calledUrl().searchParams.get("demo")).toBe("true");
    expect(calledHeaders().Authorization).toBeUndefined();
  });

  it("sends Authorization Bearer and NO demo when apiKey is present", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [] }));
    await koFetch({ baseUrl: "https://api.ko.io", apiKey: "ko_live_x" }, "/api/v1/institutions", {});
    expect(calledUrl().searchParams.get("demo")).toBeNull();
    expect(calledHeaders().Authorization).toBe("Bearer ko_live_x");
  });

  it("forwards params and skips undefined/empty", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [] }));
    await koFetch({ baseUrl: "https://api.ko.io", apiKey: "ko_x" }, "/api/v1/stocks", { page: 2, search: undefined, q: "" });
    const u = calledUrl();
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.has("search")).toBe(false);
    expect(u.searchParams.has("q")).toBe(false);
  });

  it("unwraps { data } automatically", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ a: 1 }], meta: {} }));
    const r = await koFetch({ baseUrl: "https://api.ko.io", apiKey: "ko_x" }, "/x");
    expect(r).toEqual([{ a: 1 }]);
  });

  it("returns the whole body when there is no data field", async () => {
    fetchMock.mockResolvedValue(okJson({ status: "ok" }));
    const r = await koFetch({ baseUrl: "https://api.ko.io", apiKey: "ko_x" }, "/x");
    expect(r).toEqual({ status: "ok" });
  });
});

describe("koFetch error pass-through (no raw upstream body leaked)", () => {
  it.each([
    [401, "Authentication required"],
    [403, "Access forbidden (check your plan)"],
    [404, "Not found"],
    [429, "Rate limit exceeded"],
    [500, "Upstream error"],
  ])("maps %i to a clean message", async (status, expected) => {
    fetchMock.mockResolvedValue(errJson(status, { error: { message: "" } }));
    await expect(koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x")).rejects.toThrow(
      new RegExp(`${status}.*${expected.replace(/[()]/g, "\\$&")}`)
    );
  });

  it("appends ko-api's structured error.message when provided", async () => {
    fetchMock.mockResolvedValue(errJson(400, { error: { message: "ticker is required" } }));
    await expect(koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x")).rejects.toThrow(/ticker is required/);
  });
});
