import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mock ONLY the transport (iron rule 6): real KoApiError / constants stay in place.
vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch, KoApiError } from "../ko-fetch.js";
import { registerEuTools, EU_FETCH_TIMEOUT_MS } from "../tools/eu.js";
import { UPSTREAM_CONTRACT } from "../registry/upstream.js";
import { makeFakeServer, textOf } from "./helpers.js";

const mock = vi.mocked(koFetch);

function tools() {
  const { server, tools } = makeFakeServer();
  registerEuTools(server, { baseUrl: "https://api.ko.io", apiKey: "" });
  return tools;
}
const call = (name: string, args: Record<string, unknown>) => tools().get(name)!.handler(args);

const err = (status: number, code: string, details: Record<string, unknown> | null = null) =>
  new KoApiError(`ko.io API error (${status}): x`, status, code, details);

const SRC = { attribution: "Källa: Finansinspektionen (FI), 2026-10-11", source_date: "2026-10-10", retrieved_at: "2026-10-11T21:31:22Z", url: "https://marknadssok.fi.se/r/1", link_policy: "record", copyright_note: null };
const PDMR = (over: Record<string, unknown> = {}) => ({
  record_id: "A1-1:1", country: "SE", notice_id: "A1", notice_version: 1, latest_version: 1, notice_status_label: "Aktuell",
  published_at: "2026-10-10T11:43:38Z", publication_date: "2026-10-10",
  issuer: { id: "lei:984500F33AB40805EE63", name: "Proport invest ab", lei: "984500F33AB40805EE63", isin: "SE0027767724" },
  person: { name: "Ing-Marie Thunvik", reporting_person: "Ing-Marie Thunvik", role: "Styrelseordförande", closely_associated: false },
  transaction: { date: "2026-10-09", nature_label: "Förvärv", instrument_name: "Proport invest AB", instrument_type_label: "Aktie",
    quantity: 11600, quantity_unit: "Antal", price: 2.01, currency: "SEK", price_unit: "SEK", venue: "SPOTLIGHT" },
  source: SRC,
  ...over,
});
const META = (total: number, perPage = 25) => ({
  page: 1, per_page: perPage, total, has_more: total > perPage, country: "SE", dataset: "pdmr_dealings",
  latest_source_date: "2026-10-11", latest_retrieved_at: "2026-10-11T23:31:21Z",
  pagination: { page: 1, per_page: perPage, total_count: total, total_pages: Math.ceil(total / perPage) },
});

const LISTS = ["get_eu_insider_dealings", "get_eu_major_holdings", "get_eu_short_positions", "get_eu_annual_reports"];

beforeEach(() => { mock.mockReset(); }); // block body: a returned mock would be called as cleanup

describe("EU availability states are answers, not outages", () => {
  for (const name of LISTS) {
    it(`${name}: DATASET_NOT_LIVE -> success, status pending, rows null (unknown, not empty)`, async () => {
      mock.mockRejectedValue(err(404, "DATASET_NOT_LIVE", { country: "SE", status: "pending" }) as never);
      const r = await call(name, { country: "se", page: 1, limit: 25 });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toMatch(/\*\*Status: pending\*\*/);
      expect(textOf(r)).toMatch(/not an outage and not an empty result/);
      expect(textOf(r)).not.toMatch(/API error/);
      expect(r.structuredContent).toMatchObject({ country: "SE", status: "pending", rows: null, paging: null });
    });

    it(`${name}: COUNTRY_NOT_COVERED -> status not_covered with the covered list`, async () => {
      mock.mockRejectedValue(err(404, "COUNTRY_NOT_COVERED", { country: "FR", covered: ["se", "nl", "dk", "uk"] }) as never);
      const r = await call(name, { country: "fr", page: 1, limit: 25 });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain("Covered markets: se, nl, dk, uk.");
      expect(r.structuredContent).toMatchObject({ status: "not_covered", covered_countries: ["se", "nl", "dk", "uk"], rows: null });
    });
  }

  it("gb is pointed at uk", async () => {
    mock.mockRejectedValue(err(404, "COUNTRY_NOT_COVERED", { covered: ["se", "nl", "dk", "uk"] }) as never);
    expect(textOf(await call("get_eu_insider_dealings", { country: "gb", page: 1, limit: 25 }))).toContain("The United Kingdom is `uk`.");
  });

  it("UK short positions: DATASET_NOT_OFFERED -> status not_offered, a fixed fact", async () => {
    mock.mockRejectedValue(err(404, "DATASET_NOT_OFFERED", { country: "UK", dataset: "short_positions", status: "not_offered" }) as never);
    const r = await call("get_eu_short_positions", { country: "uk", page: 1, limit: 25 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/\*\*Status: not offered\*\*.*not a temporary gap/);
    expect(r.structuredContent).toMatchObject({ status: "not_offered", rows: null });
  });

  it("get_eu_issuer: a market with nothing live is pending, not 'issuer not found'", async () => {
    mock.mockRejectedValue(err(404, "DATASET_NOT_LIVE", { country: "SE", status: "pending" }) as never);
    const r = await call("get_eu_issuer", { country: "se", issuer: "lei:549300UINV5RINHGMG07" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/no dataset for Sweden \(SE\) is live/);
    expect(r.structuredContent).toMatchObject({ status: "pending", issuer: null, insider_dealings: null });
  });

  it("real errors still surface: bad issuer id (400), ISSUER_NOT_FOUND, other 404s, 429, 5xx", async () => {
    for (const e of [
      err(400, "INVALID_PARAM", { param: "issuer" }), err(404, "ISSUER_NOT_FOUND"), err(404, "NOT_FOUND"),
      err(429, "RATE_LIMITED"), err(500, "QUERY_ERROR"),
    ]) {
      mock.mockReset();
      mock.mockRejectedValue(e as never);
      await expect(call("get_eu_insider_dealings", { country: "se", issuer: "x:y", page: 1, limit: 25 })).rejects.toBe(e);
      mock.mockReset();
      mock.mockRejectedValue(e as never);
      await expect(call("get_eu_issuer", { country: "se", issuer: "lei:549300UINV5RINHGMG07" })).rejects.toBe(e);
    }
  });
});

describe("EU lists: proxy contract", () => {
  it("calls the country route with issuer / page / per_page, inside a bound below the upstream budget", async () => {
    mock.mockResolvedValue({ data: [PDMR()], meta: META(1) } as never);
    await call("get_eu_insider_dealings", { country: "SE", issuer: "lei:984500F33AB40805EE63", page: 2, limit: 10 });
    const [, path, params, opts] = mock.mock.calls[0];
    expect(path).toBe("/api/v1/eu/se/insider-dealings");
    expect(params).toEqual({ issuer: "lei:984500F33AB40805EE63", page: 2, per_page: 10 });
    expect(opts).toMatchObject({ envelope: true, timeoutMs: EU_FETCH_TIMEOUT_MS });
    // Iron rule 10: the proxy fails before the route it proxies.
    for (const [key, route] of Object.entries(UPSTREAM_CONTRACT.routes)) {
      if (key.includes("/api/v1/eu/")) expect(EU_FETCH_TIMEOUT_MS, key).toBeLessThan(route.timeoutMs);
    }
  });

  it("each dataset tool hits its own path", async () => {
    const want: Record<string, string> = {
      get_eu_insider_dealings: "insider-dealings", get_eu_major_holdings: "major-holdings",
      get_eu_short_positions: "short-positions", get_eu_annual_reports: "annual-reports",
    };
    for (const [name, seg] of Object.entries(want)) {
      mock.mockReset();
      mock.mockResolvedValue({ data: [], meta: META(0) } as never);
      await call(name, { country: "dk", page: 1, limit: 25 });
      expect(mock.mock.calls[0][1]).toBe(`/api/v1/eu/dk/${seg}`);
    }
  });

  it("renders rows with the per-row source credit, grain, latest date and an honest paging footer", async () => {
    mock.mockResolvedValue({ data: [PDMR()], meta: META(60) } as never);
    const r = await call("get_eu_insider_dealings", { country: "se", page: 1, limit: 25 });
    const t = textOf(r);
    expect(t).toContain("## Sweden — Insider dealings (PDMR)");
    expect(t).toMatch(/\*Grain: one row per transaction line/);
    expect(t).toContain("Latest source date in ko.io: 2026-10-11");
    expect(t).toContain("| Published | Issuer | Person | Role | Nature | Instrument | Quantity | Price | Trade date | Source |");
    expect(t).toContain("Källa: Finansinspektionen (FI), 2026-10-11 [record](https://marknadssok.fi.se/r/1)");
    expect(t).toContain("11,600 Antal");
    expect(t).toMatch(/rows 1-1 of 60 -- use page=2/);
    expect(t).toMatch(/credits its source register verbatim/);
    expect(r.structuredContent).toMatchObject({
      status: "live", latest_source_date: "2026-10-11",
      paging: { total_count: 60, has_more: true, next_page: 2 },
    });
    const row = (r.structuredContent!.rows as Array<Record<string, any>>)[0];
    expect(row.transaction).toMatchObject({ quantity: "11600", price: "2.01", currency: "SEK" });
    expect(row.source).toEqual({ ...SRC, copyright_note: null });
  });

  it("marks a superseded notice version instead of letting it read as a current trade", async () => {
    mock.mockResolvedValue({ data: [PDMR({ notice_version: 1, latest_version: 2 })], meta: META(1) } as never);
    expect(textOf(await call("get_eu_insider_dealings", { country: "se", page: 1, limit: 25 }))).toContain("(superseded: v1 of 2)");
  });

  it("a live but empty answer says so in words (no headed empty table)", async () => {
    mock.mockResolvedValue({ data: [], meta: META(0) } as never);
    const r = await call("get_eu_major_holdings", { country: "nl", issuer: "co:kvk:1", page: 1, limit: 25 });
    expect(textOf(r)).toContain("No major holdings rows for this request.");
    expect(textOf(r)).not.toMatch(/\| Event date/);
    expect(r.structuredContent).toMatchObject({ status: "live", rows: [] });
  });

  it("short positions: a below-threshold bound is a bound, a null percentage is never 0", async () => {
    const base = { record_id: "s", country: "SE", position_date: "2026-10-08", holder: "H", issuer: { id: "isin:SE0000806994", name: "JM AB", lei: null, isin: "SE0000806994" }, comment: "", source: SRC };
    mock.mockResolvedValue({ data: [
      { ...base, position_pct: null, position_upper_bound_pct: 0.5, is_below_threshold: true, is_position_missing: false },
      { ...base, position_pct: null, position_upper_bound_pct: null, is_below_threshold: false, is_position_missing: false },
    ], meta: META(2) } as never);
    const r = await call("get_eu_short_positions", { country: "se", page: 1, limit: 25 });
    expect(textOf(r)).toContain("< 0.5% (below threshold)");
    expect(textOf(r)).not.toMatch(/\| 0%/);
    expect((r.structuredContent!.rows as Array<Record<string, unknown>>)[1].position_pct).toBeNull();
  });

  it("UK rows carry the licensing note and no record link (and never name the regulator)", async () => {
    const uk = PDMR({ country: "UK", source: { ...SRC, attribution: "Source: Acme plc via the National Storage Mechanism", url: null, link_policy: "none" } });
    mock.mockResolvedValue({ data: [uk], meta: META(1) } as never);
    const t = textOf(await call("get_eu_insider_dealings", { country: "uk", page: 1, limit: 25 }));
    expect(t).toContain("UK: rows credit the filer and the National Storage Mechanism");
    expect(t).not.toContain("[record]");
    expect(t).not.toMatch(/fca/i);
  });

  it("UK: a URL that slips through upstream is still dropped here (second guard)", async () => {
    const uk = PDMR({ country: "UK", source: { ...SRC, attribution: "Source: Acme plc via the National Storage Mechanism" } });
    mock.mockResolvedValue({ data: [uk], meta: META(1) } as never);
    const r = await call("get_eu_insider_dealings", { country: "uk", page: 1, limit: 25 });
    expect(textOf(r)).not.toContain("[record]");
    expect(textOf(r)).not.toContain("https://");
    const row = (r.structuredContent!.rows as Array<Record<string, any>>)[0];
    expect(row.source).toMatchObject({ url: null, link_policy: "none" });
  });

  it("trims the issuer filter before sending it", async () => {
    mock.mockResolvedValue({ data: [], meta: META(0) } as never);
    await call("get_eu_insider_dealings", { country: "se", issuer: "  lei:984500F33AB40805EE63 ", page: 1, limit: 25 });
    expect((mock.mock.calls[0][2] as Record<string, unknown>).issuer).toBe("lei:984500F33AB40805EE63");
  });

  it("get_eu_issuer trims once: path, heading and `requested` name the same id", async () => {
    mock.mockRejectedValue(err(404, "DATASET_NOT_LIVE", { country: "SE", status: "pending" }) as never);
    const r = await call("get_eu_issuer", { country: "se", issuer: "  lei:549300UINV5RINHGMG07 " });
    expect(mock.mock.calls[0][1]).toBe("/api/v1/eu/se/issuers/lei%3A549300UINV5RINHGMG07");
    expect(textOf(r)).toContain("## Sweden — issuer `lei:549300UINV5RINHGMG07`\n");
    expect(r.structuredContent).toMatchObject({ requested: "lei:549300UINV5RINHGMG07", status: "pending" });
  });

  it("the issuer id schema trims before its length check (whitespace-only never reaches /issuers/)", () => {
    for (const name of ["get_eu_issuer", "get_eu_insider_dealings"]) {
      const schema = z.object(tools().get(name)!.schema as z.ZodRawShape);
      expect(schema.safeParse({ country: "se", issuer: "   " }).success, `${name}: blank id`).toBe(false);
      expect(schema.safeParse({ country: "se", issuer: "  ab " }).success, `${name}: 2 chars after trim`).toBe(false);
      // Review of #37, nit 4: a 6-space id must not be told "at least 3 character(s)".
      const blank = schema.safeParse({ country: "se", issuer: "      " });
      expect(blank.success ? "" : blank.error.issues[0].message).toBe("issuer id must have at least 3 non-blank characters");
      const ok = schema.safeParse({ country: "se", issuer: "  lei:549300UINV5RINHGMG07 " });
      expect(ok.success && (ok.data as { issuer: string }).issuer).toBe("lei:549300UINV5RINHGMG07");
    }
  });

  it("annual reports surface the issuer copyright note once", async () => {
    const row = {
      record_id: "1", country: "NL", source_system: "AFM", publication_date: "2019-06-04", published_at: null, period_end: null,
      issuer: { id: "name:ab", name: "Holland Colours N.V.", lei: null, isin: null }, package_url: null, report_url: "https://www.afm.nl/r",
      package_sha256: null, source: { ...SRC, attribution: "Bron/Source: AFM", copyright_note: "Issuer-authored annual reports remain the issuer's copyright." },
    };
    mock.mockResolvedValue({ data: [row, row], meta: META(2) } as never);
    const t = textOf(await call("get_eu_annual_reports", { country: "nl", page: 1, limit: 25 }));
    expect(t).toContain("[report](https://www.afm.nl/r)");
    expect(t.match(/\*Copyright: Issuer-authored/g)?.length).toBe(1);
  });

  it("keyless: a soft-wall window is named and the footer never offers an unopenable page 2", async () => {
    const meta = { ...META(60), softwall: { window_start: "2026-07-12", window_end: "2026-10-12", date_basis: "disclosure", row_cap: 25, continuation: "SIGNIN_REQUIRED" } };
    mock.mockResolvedValue({ data: [PDMR()], meta } as never);
    const t = textOf(await call("get_eu_insider_dealings", { country: "se", page: 1, limit: 25 }));
    expect(t).toMatch(/Free-plan window/);
    expect(t).toMatch(/SIGNIN_REQUIRED/);
    expect(t).not.toMatch(/use page=2/);
  });
});

describe("get_eu_issuer", () => {
  const body = (over: Record<string, unknown>, live: string[]) => ({
    data: {
      issuer: { id: "lei:549300UINV5RINHGMG07", name: "Skanska AB", lei: "549300UINV5RINHGMG07", isin: "SE0000113250", country: "SE",
        lei_valid: true, isin_valid: true, ticker: null, venue: "NASDAQ STOCKHOLM AB", lei_entity_verified: false },
      match_basis: "lei", insider_dealings: [], major_holdings: [], short_positions: [], annual_reports: [], ...over,
    },
    meta: { country: "SE", live_datasets: live, rows_per_dataset: 100 },
  });

  it("proxies the issuer path and keeps 'not live' (null) apart from 'no rows' ([])", async () => {
    mock.mockResolvedValue(body({ insider_dealings: [PDMR()] }, ["pdmr_dealings", "major_holdings"]) as never);
    const r = await call("get_eu_issuer", { country: "SE", issuer: "lei:549300UINV5RINHGMG07" });
    expect(mock.mock.calls[0][1]).toBe("/api/v1/eu/se/issuers/lei%3A549300UINV5RINHGMG07");
    const t = textOf(r);
    expect(t).toContain("## Skanska AB — Sweden issuer");
    expect(t).toContain("**LEI:** 549300UINV5RINHGMG07");
    expect(t).toMatch(/### Major holdings\nNo rows for this issuer\./);
    expect(t).toMatch(/### Net short positions\nNot live on ko\.io for this market yet \(pending\)/);
    expect(r.structuredContent).toMatchObject({
      status: "live", live_datasets: ["pdmr_dealings", "major_holdings"], major_holdings: [], short_positions: null, annual_reports: null,
    });
    expect((r.structuredContent!.insider_dealings as unknown[]).length).toBe(1);
  });

  it("states the per-dataset row bound from meta, and a keyless truncation in words (iron rule 12)", async () => {
    const b = body({ insider_dealings: [PDMR()] }, ["pdmr_dealings"]);
    mock.mockResolvedValue({ ...b, meta: { ...b.meta, rows_per_dataset: 100, softwall: { truncated: true, row_cap: 25 } } } as never);
    const t = textOf(await call("get_eu_issuer", { country: "se", issuer: "lei:549300UINV5RINHGMG07" }));
    expect(t).toContain("Newest rows per dataset (up to 100 each)");
    expect(t).toContain("Keyless access caps each list at 25 rows; more rows may exist. Send a free ko.io API key");

    mock.mockReset();
    mock.mockResolvedValue({ ...b, meta: { country: "SE", live_datasets: ["pdmr_dealings"] } } as never);
    const t2 = textOf(await call("get_eu_issuer", { country: "se", issuer: "lei:549300UINV5RINHGMG07" }));
    expect(t2).toContain("*Newest rows per dataset, matched");
    expect(t2).not.toMatch(/up to \d+ each|Keyless access caps/);
  });

  it("UK: short positions are 'not offered', not pending", async () => {
    mock.mockResolvedValue(body({ short_positions: null }, ["pdmr_dealings"]) as never);
    const t = textOf(await call("get_eu_issuer", { country: "uk", issuer: "lei:549300UINV5RINHGMG07" }));
    expect(t).toMatch(/### Net short positions\nNot offered for United Kingdom\./);
  });
});

describe("get_eu_markets", () => {
  it("renders every market's dataset status, counting only live pairs", async () => {
    mock.mockResolvedValue([
      { country: "SE", datasets: [
        { dataset: "pdmr_dealings", status: "live", latest_source_date: "2026-10-11", latest_retrieved_at: "2026-10-11T23:00:00Z" },
        { dataset: "major_holdings", status: "pending", latest_source_date: null, latest_retrieved_at: null },
        { dataset: "short_positions", status: "pending", latest_source_date: null, latest_retrieved_at: null },
        { dataset: "annual_reports", status: "pending", latest_source_date: null, latest_retrieved_at: null }] },
      { country: "UK", datasets: [
        { dataset: "pdmr_dealings", status: "pending", latest_source_date: null, latest_retrieved_at: null },
        { dataset: "major_holdings", status: "pending", latest_source_date: null, latest_retrieved_at: null },
        { dataset: "short_positions", status: "not_offered", latest_source_date: null, latest_retrieved_at: null },
        { dataset: "annual_reports", status: "pending", latest_source_date: null, latest_retrieved_at: null }] },
    ] as never);
    const r = await call("get_eu_markets", {});
    expect(mock.mock.calls[0][1]).toBe("/api/v1/eu/markets");
    const t = textOf(r);
    expect(t).toContain("| Sweden (`se`) | live (latest 2026-10-11) | pending | pending | pending |");
    expect(t).toContain("| United Kingdom (`uk`) | pending | pending | not offered | pending |");
    expect(t).toMatch(/pending = offered but not activated yet \(not an outage/);
    expect(r.structuredContent).toMatchObject({ live_count: 1 });
  });

  it("an unrecognised upstream status is reported as unknown, never guessed as pending", async () => {
    mock.mockResolvedValue([{ country: "SE", datasets: [{ dataset: "pdmr_dealings", status: "paused", latest_source_date: null, latest_retrieved_at: null }] }] as never);
    const r = await call("get_eu_markets", {});
    expect(textOf(r)).toContain("| Sweden (`se`) | paused |");
    expect((r.structuredContent!.markets as Array<Record<string, any>>)[0].datasets[0].status).toBe("unknown");
  });
});

describe("EU tool descriptions", () => {
  it("are concise and never name the UK regulator", () => {
    for (const [name, t] of tools()) {
      expect(t.description.length, name).toBeLessThanOrEqual(420);
      expect(t.description, name).not.toMatch(/fca/i);
    }
  });
});
