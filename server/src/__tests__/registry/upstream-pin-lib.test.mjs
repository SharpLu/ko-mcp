/**
 * Unit tests for the upstream-pin scanner (scripts/upstream-pin-lib.mjs).
 *
 * .mjs on purpose (like deploy-guard.test.mjs): the module under test is the
 * plain-ESM file `registry:refresh-pin` executes, imported as-is. Fixtures are
 * synthetic handler sources -- ko-api is private and never vendored here.
 */
import { describe, it, expect } from "vitest";
import {
  PARAM_HELPERS, readParams, unscannableReads, functionBody, resolveHelperReads, splitHandlers, handlerFactory,
} from "../../../scripts/upstream-pin-lib.mjs";

const PAGINATION_TS = `
/** doc */
export function pageSizeParam(sp: URLSearchParams): string | null {
  const perPage = sp.get('per_page');
  if (perPage !== null && perPage !== '') return perPage;
  return sp.get('limit');
}

export function paginationMeta(page: number) { return { page }; }
`;

const ROUTE = `
app.get('/api/v1/institutions', async (c) => {
  const sp = new URL(c.req.url).searchParams;
  const page = clampInt(sp.get('page'), 1, 1, 1000000);
  const perPage = clampInt(pageSizeParam(sp), 50, 1, 500);
  const search = sp.get('search') || null;
  const params = { limit: perPage };
  Object.assign(params, other);
  return c.json({});
});
app.get('/api/v1/institutions/summary', async (c) => {
  const q = c.req.query('q');
  return c.json({ q });
});
`;

const helperReads = resolveHelperReads(() => PAGINATION_TS);

describe("PARAM_HELPERS resolution", () => {
  it("pageSizeParam is a known helper pinned from src/lib/pagination.ts", () => {
    expect(PARAM_HELPERS.pageSizeParam).toBe("src/lib/pagination.ts");
  });

  it("resolves a helper's reads from its own body (per_page AND its alias limit)", () => {
    expect(helperReads).toEqual({ pageSizeParam: ["limit", "per_page"] });
  });

  it("functionBody stops at the helper's closing brace (a sibling's reads do not leak in)", () => {
    const body = functionBody(PAGINATION_TS, "pageSizeParam");
    expect(body).toContain("sp.get('limit')");
    expect(body).not.toContain("paginationMeta");
  });

  it("a helper that moved/renamed is an error, not 'reads nothing'", () => {
    expect(() => resolveHelperReads(() => "export const x = 1;")).toThrow(/pageSizeParam\(\) not found/);
  });

  it("a helper whose body reads nothing visible is an error", () => {
    const src = "export function pageSizeParam(sp) { return null; }";
    expect(() => resolveHelperReads(() => src)).toThrow(/no param reads found/);
  });
});

describe("readParams", () => {
  const [list, summary] = splitHandlers(ROUTE);

  it("a handler calling pageSizeParam(sp) reads per_page and limit", () => {
    expect(readParams(list.body, helperReads)).toEqual(["limit", "page", "per_page", "search"]);
  });

  it("without helper resolution the row-count params vanish (the bug this fixes)", () => {
    expect(readParams(list.body)).toEqual(["page", "search"]);
  });

  it("stays handler-granular: a sibling handler gets only its own reads", () => {
    expect(readParams(summary.body, helperReads)).toEqual(["q"]);
  });
});

describe("unscannableReads", () => {
  it("accepts the shapes the scanner resolves (and a ClickHouse bind map named params)", () => {
    expect(unscannableReads(ROUTE)).toEqual([]);
    expect(unscannableReads("const n = f(pageSizeParam(new URL(c.req.url).searchParams));")).toEqual([]);
  });

  it("refuses URLSearchParams handed to an unresolved function", () => {
    expect(unscannableReads("const sp = new URL(c.req.url).searchParams; const x = readFilters(sp);"))
      .toEqual(["URLSearchParams passed to readFilters()"]);
    expect(unscannableReads("const x = parseWindow(new URL(c.req.url).searchParams, 30);"))
      .toEqual(["URLSearchParams passed to parseWindow()"]);
    expect(unscannableReads("const x = parseWindow(url.searchParams);"))
      .toEqual(["URLSearchParams passed to parseWindow()"]);
  });

  it("refuses URLSearchParams bound to a name readParams() does not scan", () => {
    expect(unscannableReads("const u = new URL(c.req.url).searchParams;\nconst a = u.get('a');"))
      .toEqual(['URLSearchParams bound to "u"']);
  });

  it("keeps the existing refusals", () => {
    expect(unscannableReads("const { a } = c.req.query();")).toEqual(["bare c.req.query() destructuring"]);
    expect(unscannableReads("sp.get(name)")).toEqual(["searchParams.get(<variable>)"]);
  });
});

describe("same-file handler factories (ko-api eu.ts listHandler)", () => {
  const SRC = `
function listHandler(dataset: string) {
  return async (c: Context) => {
    const sp = new URL(c.req.url).searchParams;
    const issuer = sp.get('issuer');
    const page = validatePage(sp.get('page') ?? undefined);
    const size = pageSizeParam(sp);
    return c.json({ dataset, issuer, page, size, t: \`\${dataset}\` });
  };
}
app.get('/api/v1/eu/:country/insider-dealings', listHandler('pdmr_dealings'));
app.get('/api/v1/eu/markets', async () => apiSuccess([]));
app.get('/api/v1/x', cacheFor(60), async (c) => c.json({ q: c.req.query('q') }));
`;
  const handlers = splitHandlers(SRC);

  it("recognises only the `app.get(path, factory(args))` shape", () => {
    expect(handlers.map((h) => handlerFactory(h.body))).toEqual(["listHandler", null, null]);
  });

  it("resolves the factory's reads (incl. helpers) from its non-exported declaration", () => {
    const h = handlers[0];
    const reads = readParams(`${h.body}\n${functionBody(SRC, handlerFactory(h.body), { exported: false })}`, helperReads);
    expect(reads).toEqual(["issuer", "limit", "page", "per_page"]);
  });

  it("an exported-only lookup still refuses a non-exported function", () => {
    expect(() => functionBody(SRC, "listHandler")).toThrow(/not found/);
  });

  // Review of #35, nit h: the first declaration is not necessarily the implementation.
  it("refuses an overloaded function instead of reading the first signature", () => {
    const OVER = [
      "export function pick(kind: 'a'): Handler;",
      "export function pick(kind: 'b'): Handler;",
      "export function pick(kind: string): Handler {",
      "  return async (c) => c.json({ q: c.req.query('q') });",
      "}",
    ].join("\n");
    expect(() => functionBody(OVER, "pick")).toThrow(/declared 3 times/);
    expect(() => functionBody(OVER, "pick", { exported: false })).toThrow(/declared 3 times/);
  });

  it("refuses a bodiless signature rather than matching the next block", () => {
    const SIG = "function sig(a: string): Handler;\nconst other = () => { c.req.query('leak'); };\n";
    expect(() => functionBody(SIG, "sig", { exported: false })).toThrow(/no body/);
  });

  it("balances the parameter list (a callback default does not end it early)", () => {
    // The old first-`)` / first-`{` scan returned `function withCb(n = 1, cb = () => {}` here.
    const CB = "function withCb(n = 1, cb = () => {}) {\n  return c.req.query('page');\n}\nfunction after() { c.req.query('leak'); }\n";
    const body = functionBody(CB, "withCb", { exported: false });
    expect(body).toContain("c.req.query('page')");
    expect(body).not.toContain("leak");
  });

  // Review of #36, nit 2: `function f(a): { x: number } {` used to return the
  // return-type literal `{ x: number }` as the body, so a handler factory with
  // an object return type would have been pinned as reading [].
  it("skips an object-literal return type to the real body", () => {
    const OBJ = "function f(a: string): { x: number; y: string } {\n  return { x: Number(c.req.query('page')), y: '' };\n}\nfunction after() { c.req.query('leak'); }\n";
    const body = functionBody(OBJ, "f", { exported: false });
    expect(body).toContain("c.req.query('page')");
    expect(body).not.toContain("leak");
    expect(readParams(body)).toEqual(["page"]);
  });

  it.each([
    ["generic object", "Promise<{ a: string }>"],
    ["union with object", "Handler | { b: 1 }"],
    ["array of objects", "{ a: 1 }[]"],
    ["function type", "(() => { a: 1 })"],
    ["type predicate", "x is Foo"],
    ["string literal with a brace", "'{' | '}'"],
    ["commented", "/* { not a body } */ Handler"],
  ])("finds the body behind a %s return type", (_label, type) => {
    const SRC = `function g(x: unknown): ${type} {\n  return c.req.query('q');\n}\nconst other = () => { c.req.query('leak'); };\n`;
    const body = functionBody(SRC, "g", { exported: false });
    expect(readParams(body)).toEqual(["q"]);
  });

  it("still refuses a bodiless signature that has an object return type", () => {
    const SIG = "function sig(a: string): { x: number };\nconst other = () => { c.req.query('leak'); };\n";
    expect(() => functionBody(SIG, "sig", { exported: false })).toThrow(/no body/);
  });
});
