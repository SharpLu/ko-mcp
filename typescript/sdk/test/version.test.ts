import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

// AGENTS.md iron rule 8: the three SDK packages ship in version lockstep, and each
// package's runtime constant (the User-Agent / --version string) must match its
// manifest. A GitHub Release publishes both npm packages, so a package left behind
// on an already-published version fails the release.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const npmVersion = (rel: string) => (JSON.parse(read(rel)) as { version: string }).version;

describe("SDK version lockstep", () => {
  it("VERSION matches package.json and package-lock.json", () => {
    expect(VERSION).toBe(npmVersion("../package.json"));
    const lock = JSON.parse(read("../package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[""]?.version).toBe(VERSION);
  });

  it("@ko-io/mcp-sec-data and ko-edgar carry the same version", () => {
    expect(npmVersion("../../mcp-proxy/package.json")).toBe(VERSION);
    expect(read("../../mcp-proxy/src/version.ts")).toContain(`export const VERSION = "${VERSION}";`);
    expect(read("../../../python/pyproject.toml")).toMatch(new RegExp(`^version = "${VERSION.replace(/\./g, "\\.")}"$`, "m"));
    expect(read("../../../python/src/ko_edgar/_version.py")).toContain(`__version__ = "${VERSION}"`);
  });
});
