import { describe, it, expect } from "vitest";
import { extractUserKey, resolveApiKey } from "../auth.js";

const req = (opts: { auth?: string; xkey?: string; qs?: string }) =>
  new Request(`https://mcp.ko.io/mcp${opts.qs ? `?${opts.qs}` : ""}`, {
    headers: {
      ...(opts.auth ? { Authorization: opts.auth } : {}),
      ...(opts.xkey ? { "x-ko-api-key": opts.xkey } : {}),
    },
  });

describe("extractUserKey", () => {
  it("reads Authorization: Bearer ko_...", () => {
    expect(extractUserKey(req({ auth: "Bearer ko_live_abc123" }))).toBe("ko_live_abc123");
  });
  it("reads x-ko-api-key header", () => {
    expect(extractUserKey(req({ xkey: "ko_live_xyz" }))).toBe("ko_live_xyz");
  });
  it("reads ?api_key= query param", () => {
    expect(extractUserKey(req({ qs: "api_key=ko_live_q" }))).toBe("ko_live_q");
  });
  it("reads ?key= query param", () => {
    expect(extractUserKey(req({ qs: "key=ko_live_k" }))).toBe("ko_live_k");
  });
  it("ignores a non-ko Bearer token (e.g. a JWT)", () => {
    expect(extractUserKey(req({ auth: "Bearer eyJhbGciOi.jwt.token" }))).toBeUndefined();
  });
  it("ignores a non-ko x-ko-api-key", () => {
    expect(extractUserKey(req({ xkey: "sk_test_nope" }))).toBeUndefined();
  });
  it("returns undefined when no key is present", () => {
    expect(extractUserKey(req({}))).toBeUndefined();
  });
  it("prefers Authorization over header and query", () => {
    expect(extractUserKey(req({ auth: "Bearer ko_A", xkey: "ko_B", qs: "api_key=ko_C" }))).toBe("ko_A");
  });
});

describe("resolveApiKey (fallback-key vulnerability fix)", () => {
  it("returns the user key when present", () => {
    expect(resolveApiKey("ko_live_user")).toBe("ko_live_user");
  });
  it("returns empty string when no user key (-> demo mode, NOT a deployment key)", () => {
    expect(resolveApiKey(undefined)).toBe("");
    expect(resolveApiKey("")).toBe("");
  });
});
