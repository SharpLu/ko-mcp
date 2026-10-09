import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseCik, resolveInstitution } from "../resolve.js";
import { KoApiError, KoTimeoutError } from "../ko-fetch.js";

// Real koFetch, mocked global fetch: the error classes come from the true
// status mapping, not from a hand-built rejection.
const config = { baseUrl: "https://api.ko.io", apiKey: "" };
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) });
const err = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: "x" } }) });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("parseCik", () => {
  it.each([
    ["1512857", "1512857"],
    [" 0001512857 ", "0001512857"],
    ["CIK 1512857", "1512857"],
    ["cik:1512857", "1512857"],
    ["CIK#1512857", "1512857"],
  ])("%s is a CIK", (input, cik) => expect(parseCik(input)).toBe(cik));

  it.each(["Point72 Asset Management", "Two Sigma 2", "point72-asset-management", "CIK", "", "12345678901", "1512857x"])(
    "%s is not a CIK",
    (input) => expect(parseCik(input)).toBeNull(),
  );
});

describe("resolveInstitution", () => {
  it("a CIK never triggers a lookup", async () => {
    expect(await resolveInstitution(config, "CIK 1067983")).toEqual({ target: "1067983", note: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a slug passes through unless the caller needs a CIK", async () => {
    expect(await resolveInstitution(config, "berkshire-hathaway")).toEqual({ target: "berkshire-hathaway", note: "" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(ok([{ cik: "1067983", name: "Berkshire Hathaway Inc", slug: "berkshire-hathaway" }]));
    expect((await resolveInstitution(config, "berkshire-hathaway", { cikOnly: true }))?.target).toBe("1067983");
  });

  it("a name with digits is searched by name", async () => {
    fetchMock.mockResolvedValue(ok([{ cik: "1603466", name: "Point72 Asset Management, L.P.", slug: "p" }]));
    const r = await resolveInstitution(config, "Point72 Asset Management");
    expect(r?.target).toBe("1603466");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/institutions?");
  });

  it("returns null only for a successful lookup with zero matches", async () => {
    fetchMock.mockResolvedValue(ok([]));
    expect(await resolveInstitution(config, "zzzqqq no such fund")).toBeNull();
  });

  it("a 429 propagates as KoApiError(429), not as 'not found'", async () => {
    fetchMock.mockResolvedValue(err(429));
    const e = await resolveInstitution(config, "Point72 Asset Management").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(KoApiError);
    expect((e as KoApiError).status).toBe(429);
  });

  it.each([401, 403, 500, 502, 503])("a %i propagates", async (status) => {
    fetchMock.mockResolvedValue(err(status));
    await expect(resolveInstitution(config, "Point72 Asset Management")).rejects.toBeInstanceOf(KoApiError);
  });

  it("a timeout propagates as KoTimeoutError", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(resolveInstitution(config, "Point72 Asset Management")).rejects.toBeInstanceOf(KoTimeoutError);
  });
});
