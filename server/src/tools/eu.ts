import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, type ToolResultLike } from "../tool-def.js";
import { koFetch, asEnvelope, KoApiError, type KoConfig, type KoEnvelope, type KoMeta } from "../ko-fetch.js";
import { pagingOf, pagingLines, windowLine, planLimitOf, dec, int, str, bool } from "../paging.js";
import {
  EU_MARKETS_OUTPUT, EU_INSIDER_DEALINGS_OUTPUT, EU_MAJOR_HOLDINGS_OUTPUT, EU_SHORT_POSITIONS_OUTPUT,
  EU_ANNUAL_REPORTS_OUTPUT, EU_ISSUER_OUTPUT,
} from "../output-schemas.js";

// European market disclosures: ko-api /api/v1/eu/* (ko-api src/routes/v1/eu.ts).
//
// A (market, dataset) pair is `live`, `pending` (offered, not activated yet) or
// `not_offered`; ko-api answers the last two -- and an uncovered market -- with a
// 404 carrying a code. Those are availability STATES, not failures: a model that
// reads "ko.io API error (404)" reports an outage or "no data", both false. So
// they become a normal answer that names the state, with `rows: null` (unknown)
// rather than `[]` (empty). Everything else (400 bad issuer id, 401, 429, 5xx)
// still surfaces as an error.

/**
 * Below the 20 s the upstream EU routes declare (`timeoutMs: 20000` in the pinned
 * contract), so this proxy fails first and names its own limit (iron rule 10).
 * Healthy EU reads are well under a second; a list is up to four bounded
 * ClickHouse reads of 15 s each upstream.
 */
export const EU_FETCH_TIMEOUT_MS = 15_000;

type EuDataset = "pdmr_dealings" | "major_holdings" | "short_positions" | "annual_reports";
type EuStatus = "live" | "pending" | "not_offered" | "not_covered";

const DATASETS: readonly EuDataset[] = ["pdmr_dealings", "major_holdings", "short_positions", "annual_reports"];

const DATASET: Record<EuDataset, { path: string; label: string; tool: string; grain: string }> = {
  pdmr_dealings: {
    path: "insider-dealings", label: "Insider dealings (PDMR)", tool: "get_eu_insider_dealings",
    grain: "one row per transaction line of a manager's (PDMR, MAR art. 19) notice, newest disclosure first",
  },
  major_holdings: {
    path: "major-holdings", label: "Major holdings", tool: "get_eu_major_holdings",
    grain: "one row per voting-rights notification, newest first; Votes % includes financial instruments, Shares % is shares only",
  },
  short_positions: {
    path: "short-positions", label: "Net short positions", tool: "get_eu_short_positions",
    grain: "one row per disclosed net short position (holder, issuer, position date), newest first",
  },
  annual_reports: {
    path: "annual-reports", label: "Annual financial reports", tool: "get_eu_annual_reports",
    grain: "one row per annual financial report filing, newest publication first; ko.io serves register fields and links only",
  },
};

const MARKET_NAMES: Record<string, string> = { SE: "Sweden", NL: "Netherlands", DK: "Denmark", UK: "United Kingdom" };
const marketName = (cc: string) => MARKET_NAMES[cc] ?? cc;

const COUNTRY = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "a two-letter market code")
  .describe("Market: se (Sweden), nl (Netherlands), dk (Denmark) or uk (United Kingdom)");

// trim() before min(3): a whitespace-only id is a -32602 at the schema layer,
// never a call to `/issuers/` (review of ko-mcp #36, nit 5).
const ISSUER_ID = z
  .string()
  .trim()
  .min(3, "issuer id must have at least 3 non-blank characters")
  .max(200)
  .describe("ko.io issuer id as returned in a row's issuer.id: lei:<LEI>, isin:<ISIN>, co:<register id> or name:<hash>");

const PAGE = z.number().int().min(1).optional().default(1).describe("Page number (default 1)");
const LIMIT = z.number().int().min(1).max(100).optional().default(25).describe("Rows per page, 1-100 (default 25)");

const CREDIT_LINE = "*Each row credits its source register verbatim (Source column; `source.attribution`). Quote the credit with the data.*";
const UK_NOTE =
  "*UK: rows credit the filer and the National Storage Mechanism. Its terms allow no link to an individual " +
  "record, so ko.io gives none (`source.url` is null).*";

// ---------------------------------------------------------------------------
// Availability states (pending / not offered / not covered)
// ---------------------------------------------------------------------------

const NOT_SERVED: Record<string, Exclude<EuStatus, "live">> = {
  DATASET_NOT_LIVE: "pending",
  DATASET_NOT_OFFERED: "not_offered",
  COUNTRY_NOT_COVERED: "not_covered",
};

interface NotServed {
  status: Exclude<EuStatus, "live">;
  covered: string[] | null;
}

/** The 404 states ko-api answers from configuration; null for any real error. */
function notServed(e: unknown): NotServed | null {
  if (!(e instanceof KoApiError) || e.status !== 404 || !e.code) return null;
  const status = NOT_SERVED[e.code];
  if (!status) return null;
  const covered = Array.isArray(e.details?.covered) ? (e.details!.covered as unknown[]).map((c) => String(c)) : null;
  return { status, covered };
}

/** One honest sentence per state. Never "error", never "no data". */
function notServedLine(cc: string, dataset: EuDataset | null, s: NotServed): string {
  const what = dataset ? DATASET[dataset].label : "No dataset";
  const where = `${marketName(cc)} (${cc})`;
  switch (s.status) {
    case "pending":
      return (
        `**Status: pending** -- ${dataset ? `${what} for ${where}: offered, not live` : `no dataset for ${where} is live`} ` +
        "on ko.io yet. This is not an outage and not an empty result: no rows are served until ko.io activates it. " +
        "`get_eu_markets` shows what is live."
      );
    case "not_offered":
      return (
        `**Status: not offered** -- ko.io does not offer ${what.toLowerCase()} for ${where}. ` +
        "This is a fixed source/licensing decision, not a temporary gap."
      );
    case "not_covered": {
      const covered = (s.covered ?? ["se", "nl", "dk", "uk"]).map((c) => c.toLowerCase()).join(", ");
      const hint = cc === "GB" ? " The United Kingdom is `uk`." : "";
      return `**Status: not covered** -- ko.io covers no European market \`${cc.toLowerCase()}\`. Covered markets: ${covered}.${hint}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Markdown-table-safe cell text. */
function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return s === "" ? "—" : s;
}

/** A number as the source gave it, with thousands separators; "—" for unknown (never 0). */
function fmtNum(v: unknown): string {
  const d = dec(v);
  if (d === null) return "—";
  return Number(d).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function fmtPctVal(v: unknown): string {
  const d = dec(v);
  return d === null ? "—" : `${Number(d).toLocaleString("en-US", { maximumFractionDigits: 6 })}%`;
}

/** Only an https link is rendered. */
const link = (label: string, url: unknown) => (typeof url === "string" && url.startsWith("https://") ? `[${label}](${url})` : null);

function sourceCell(src: Row | undefined): string {
  const credit = cell(src?.attribution);
  const rec = link("record", src?.url);
  return rec ? `${credit} ${rec}` : credit;
}

const sourceOut = (s: Row | undefined) => ({
  attribution: str(s?.attribution), source_date: str(s?.source_date), retrieved_at: str(s?.retrieved_at),
  url: str(s?.url), link_policy: str(s?.link_policy), copyright_note: str(s?.copyright_note),
});
const issuerOut = (i: Row | undefined) => ({ id: str(i?.id), name: str(i?.name), lei: str(i?.lei), isin: str(i?.isin) });

const pdmrOut = (r: Row) => ({
  record_id: str(r.record_id), notice_id: str(r.notice_id), notice_version: int(r.notice_version),
  latest_version: int(r.latest_version), notice_status_label: str(r.notice_status_label),
  published_at: str(r.published_at), publication_date: str(r.publication_date), issuer: issuerOut(r.issuer),
  person: {
    name: str(r.person?.name), reporting_person: str(r.person?.reporting_person), role: str(r.person?.role),
    closely_associated: bool(r.person?.closely_associated),
  },
  transaction: {
    date: str(r.transaction?.date), nature_label: str(r.transaction?.nature_label),
    instrument_name: str(r.transaction?.instrument_name), instrument_type_label: str(r.transaction?.instrument_type_label),
    quantity: dec(r.transaction?.quantity), quantity_unit: str(r.transaction?.quantity_unit),
    price: dec(r.transaction?.price), currency: str(r.transaction?.currency), price_unit: str(r.transaction?.price_unit),
    venue: str(r.transaction?.venue),
  },
  source: sourceOut(r.source),
});

const majorOut = (r: Row) => {
  const a = r.after ?? {}, b = r.before ?? {}, f = r.instruments ?? {};
  return {
    record_id: str(r.record_id), notice_status_label: str(r.notice_status_label), published_at: str(r.published_at),
    publication_date: str(r.publication_date), transaction_date: str(r.transaction_date), event_date: str(r.event_date),
    event_date_kind: str(r.event_date_kind), issuer: issuerOut(r.issuer),
    holders: Array.isArray(r.holders) ? r.holders.map((h: unknown) => String(h)) : [],
    reason_label: str(r.reason_label), instrument: str(r.instrument),
    after: {
      shares: dec(a.shares), shares_pct: dec(a.shares_pct), potential_shares_pct: dec(a.potential_shares_pct),
      total_votes_pct: dec(a.total_votes_pct), direct_votes: dec(a.direct_votes), indirect_votes: dec(a.indirect_votes),
      direct_votes_pct: dec(a.direct_votes_pct), indirect_votes_pct: dec(a.indirect_votes_pct),
    },
    before: { shares: dec(b.shares), votes: dec(b.votes) },
    instruments: {
      votes: dec(f.votes), votes_pct: dec(f.votes_pct), physical_votes: dec(f.physical_votes),
      physical_votes_pct: dec(f.physical_votes_pct), cash_votes: dec(f.cash_votes), cash_votes_pct: dec(f.cash_votes_pct),
    },
    missing_fields: Array.isArray(r.missing_fields) ? r.missing_fields.map((m: unknown) => String(m)) : [],
    comment: str(r.comment),
    source: sourceOut(r.source),
  };
};

const shortOut = (r: Row) => ({
  record_id: str(r.record_id), position_date: str(r.position_date), holder: str(r.holder), issuer: issuerOut(r.issuer),
  position_pct: dec(r.position_pct), position_upper_bound_pct: dec(r.position_upper_bound_pct),
  is_below_threshold: bool(r.is_below_threshold), is_position_missing: bool(r.is_position_missing),
  comment: str(r.comment), source: sourceOut(r.source),
});

const annualOut = (r: Row) => ({
  record_id: str(r.record_id), source_system: str(r.source_system), publication_date: str(r.publication_date),
  published_at: str(r.published_at), period_end: str(r.period_end), issuer: issuerOut(r.issuer),
  report_url: str(r.report_url), package_url: str(r.package_url), package_sha256: str(r.package_sha256),
  source: sourceOut(r.source),
});

const OUT: Record<EuDataset, (r: Row) => Record<string, unknown>> = {
  pdmr_dealings: pdmrOut, major_holdings: majorOut, short_positions: shortOut, annual_reports: annualOut,
};

/** Markdown table for one dataset's rows (header + one line per row). */
function table(dataset: EuDataset, rows: Row[]): string[] {
  switch (dataset) {
    case "pdmr_dealings": {
      const out = [
        "| Published | Issuer | Person | Role | Nature | Instrument | Quantity | Price | Trade date | Source |",
        "|-----------|--------|--------|------|--------|------------|----------|-------|------------|--------|",
      ];
      for (const r of rows) {
        const t = r.transaction ?? {}, p = r.person ?? {};
        const superseded = int(r.latest_version) !== null && int(r.notice_version) !== null && int(r.notice_version)! < int(r.latest_version)!
          ? ` (superseded: v${int(r.notice_version)} of ${int(r.latest_version)})` : "";
        const person = `${cell(p.name)}${p.closely_associated ? " (closely associated)" : ""}`;
        const qty = `${fmtNum(t.quantity)}${t.quantity_unit ? ` ${cell(t.quantity_unit)}` : ""}`;
        const price = dec(t.price) === null ? "—" : `${fmtNum(t.price)}${t.price_unit ? ` ${cell(t.price_unit)}` : ""}`;
        out.push(
          `| ${cell(r.publication_date)} | ${cell(r.issuer?.name)} | ${person} | ${cell(p.role)} | ${cell(t.nature_label)}${superseded} | ` +
          `${cell(t.instrument_name)} | ${qty} | ${price} | ${cell(t.date)} | ${sourceCell(r.source)} |`,
        );
      }
      return out;
    }
    case "major_holdings": {
      const out = [
        "| Event date | Issuer | Holder(s) | Votes % after | Shares % after | Instruments % | Reason | Source |",
        "|------------|--------|-----------|---------------|----------------|---------------|--------|--------|",
      ];
      for (const r of rows) {
        const date = `${cell(r.event_date)}${r.event_date_kind === "transaction" ? " (trade)" : ""}`;
        const holders = Array.isArray(r.holders) && r.holders.length ? r.holders.join("; ") : null;
        out.push(
          `| ${date} | ${cell(r.issuer?.name)} | ${cell(holders)} | ${fmtPctVal(r.after?.total_votes_pct)} | ` +
          `${fmtPctVal(r.after?.shares_pct)} | ${fmtPctVal(r.instruments?.votes_pct)} | ${cell(r.reason_label)} | ${sourceCell(r.source)} |`,
        );
      }
      return out;
    }
    case "short_positions": {
      const out = [
        "| Position date | Holder | Issuer | ISIN | Net short | Source |",
        "|---------------|--------|--------|------|-----------|--------|",
      ];
      for (const r of rows) {
        let pos = fmtPctVal(r.position_pct);
        if (dec(r.position_pct) === null && bool(r.is_below_threshold) && dec(r.position_upper_bound_pct) !== null) {
          pos = `< ${fmtPctVal(r.position_upper_bound_pct)} (below threshold)`;
        } else if (dec(r.position_pct) === null && bool(r.is_position_missing)) {
          pos = "not stated by source";
        }
        out.push(
          `| ${cell(r.position_date)} | ${cell(r.holder)} | ${cell(r.issuer?.name)} | ${cell(r.issuer?.isin)} | ${pos} | ${sourceCell(r.source)} |`,
        );
      }
      return out;
    }
    case "annual_reports": {
      const out = [
        "| Published | Issuer | LEI | Period end | Report | Source |",
        "|-----------|--------|-----|------------|--------|--------|",
      ];
      for (const r of rows) {
        const report = link("report", r.report_url) ?? link("package", r.package_url) ?? "—";
        out.push(
          `| ${cell(r.publication_date)} | ${cell(r.issuer?.name)} | ${cell(r.issuer?.lei)} | ${cell(r.period_end)} | ${report} | ${sourceCell(r.source)} |`,
        );
      }
      return out;
    }
  }
}

/** Credit + licensing footer for rows actually shown. */
function creditLines(cc: string, rowsBySet: Row[][]): string[] {
  const all = rowsBySet.flat();
  if (!all.length) return [];
  const out = [`\n${CREDIT_LINE}`];
  const notes = [...new Set(all.map((r) => str(r.source?.copyright_note)).filter((n): n is string => n !== null))];
  for (const n of notes) out.push(`*Copyright: ${n}*`);
  if (cc === "UK") out.push(UK_NOTE);
  return out;
}

/** ko-api's EU list meta says `total` / `pagination.*`; the paging helpers read `total_count` / `per_page`. */
function euMeta(meta: KoMeta): KoMeta {
  const p = (meta.pagination ?? {}) as { total_count?: unknown; per_page?: unknown };
  return {
    ...meta,
    total_count: (meta.total_count ?? meta.total ?? p.total_count) as number | string | undefined,
    per_page: (p.per_page ?? meta.per_page) as number | undefined,
  };
}

const segment = (country: string) => encodeURIComponent(country.toLowerCase());

/**
 * UK rows never carry a link (the National Storage Mechanism terms allow none).
 * ko-api already nulls every UK URL; this is the second guard, so the UK note's
 * "ko.io gives none" does not rest on upstream alone.
 */
function ukSafe(cc: string, rows: Row[]): Row[] {
  if (cc !== "UK") return rows;
  return rows.map((r) => ({
    ...r,
    ...("report_url" in r ? { report_url: null } : {}),
    ...("package_url" in r ? { package_url: null } : {}),
    source: r.source ? { ...r.source, url: null, link_policy: "none" } : r.source,
  }));
}

const textResult = (lines: string[], structuredContent: Record<string, unknown>): ToolResultLike => ({
  content: [{ type: "text", text: lines.join("\n") }],
  structuredContent,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerEuTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_eu_markets
  // ---------------------------------------------------------------------------
  defineTool(server,
    "get_eu_markets",
    "Which European markets and datasets ko.io serves: for Sweden, Netherlands, Denmark and the UK, the status of insider dealings (PDMR), major holdings, net short positions and annual reports -- live (with latest source date), pending (not activated yet) or not offered. Call first when unsure whether an EU dataset is live.",
    {},
    async () => {
      const data = await koFetch<unknown>(config, "/api/v1/eu/markets", {}, { timeoutMs: EU_FETCH_TIMEOUT_MS });
      const markets = (Array.isArray(data) ? data : []) as Row[];
      const lines = ["## European markets on ko.io\n"];
      let live = 0;
      if (markets.length) {
        lines.push("| Market | Insider dealings (PDMR) | Major holdings | Net short positions | Annual reports |");
        lines.push("|--------|-------------------------|----------------|---------------------|----------------|");
        for (const m of markets) {
          const cc = String(m.country ?? "");
          const sets = (Array.isArray(m.datasets) ? m.datasets : []) as Row[];
          const cells = DATASETS.map((d) => {
            const s = sets.find((x) => x.dataset === d);
            if (!s) return "—";
            if (s.status === "live") {
              live++;
              return s.latest_source_date ? `live (latest ${s.latest_source_date})` : "live";
            }
            return s.status === "not_offered" ? "not offered" : cell(s.status);
          });
          lines.push(`| ${marketName(cc)} (\`${cc.toLowerCase()}\`) | ${cells.join(" | ")} |`);
        }
        // One fixed legend (not a "nothing is live" variant): the status cells say it,
        // and a constant line keeps this answer's contract stable across activation.
        lines.push("\n*live = served; pending = offered but not activated yet (not an outage, not empty); not offered = a fixed source/licensing decision.*");
        lines.push(UK_NOTE);
      } else {
        lines.push("No European market status returned.");
      }
      return textResult(lines, {
        markets: markets.map((m) => ({
          country: String(m.country ?? ""),
          datasets: ((Array.isArray(m.datasets) ? m.datasets : []) as Row[])
            .filter((s) => (DATASETS as readonly string[]).includes(String(s.dataset)))
            .map((s) => ({
              dataset: s.dataset as EuDataset,
              // A status this tool does not know is reported as such, never guessed.
              status: (["live", "pending", "not_offered"].includes(String(s.status)) ? s.status : "unknown") as EuStatus | "unknown",
              latest_source_date: str(s.latest_source_date),
              latest_retrieved_at: str(s.latest_retrieved_at),
            })),
        })),
        live_count: live,
      });
    },
    { outputSchema: EU_MARKETS_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tools: the four per-market dataset lists
  // ---------------------------------------------------------------------------
  const LIST_TOOLS: Array<{ dataset: EuDataset; description: string; output: typeof EU_INSIDER_DEALINGS_OUTPUT }> = [
    {
      dataset: "pdmr_dealings",
      description:
        "European insider dealings: transactions by managers and closely associated persons (PDMR, MAR article 19) from the national registers of Sweden, Netherlands, Denmark or the UK, newest first. One row per notice transaction line with person, role, nature, quantity, price and per-row source credit. Filter by issuer id; check get_eu_markets for which markets are live.",
      output: EU_INSIDER_DEALINGS_OUTPUT,
    },
    {
      dataset: "major_holdings",
      description:
        "European major holdings (voting-rights) notifications for Sweden, Netherlands, Denmark or the UK, newest first: issuer, holder(s), voting-rights % after (incl. instruments), shares %, reason, per-row source credit. Filter by issuer id; check get_eu_markets for which markets are live.",
      output: EU_MAJOR_HOLDINGS_OUTPUT,
    },
    {
      dataset: "short_positions",
      description:
        "European disclosed net short positions for Sweden, Netherlands or Denmark (not offered for the UK), newest position date first: holder, issuer, ISIN, net short % of issued capital, per-row source credit. Filter by issuer id; check get_eu_markets for which markets are live.",
      output: EU_SHORT_POSITIONS_OUTPUT,
    },
    {
      dataset: "annual_reports",
      description:
        "European annual financial report filings for Sweden, Netherlands, Denmark or the UK, newest first: issuer, LEI, period end, link to the original report where the source allows, per-row source credit. Filter by issuer id; check get_eu_markets for which markets are live.",
      output: EU_ANNUAL_REPORTS_OUTPUT,
    },
  ];

  for (const spec of LIST_TOOLS) {
    const { dataset } = spec;
    const meta = DATASET[dataset];
    defineTool(server,
      meta.tool,
      spec.description,
      {
        country: COUNTRY,
        issuer: ISSUER_ID.optional(),
        page: PAGE,
        limit: LIMIT,
      },
      async ({ country, issuer: rawIssuer, page, limit }) => {
        const cc = country.toUpperCase();
        const issuer = rawIssuer?.trim() || undefined;
        const heading = `## ${marketName(cc)} — ${meta.label}`;
        const base = {
          country: cc, dataset, issuer_filter: str(issuer), plan_limit: null,
          latest_source_date: null, latest_retrieved_at: null, covered_countries: null,
        };
        let env: KoEnvelope<Row[]>;
        try {
          env = asEnvelope<Row[]>(
            await koFetch<unknown>(
              config,
              `/api/v1/eu/${segment(country)}/${meta.path}`,
              { issuer, page, per_page: limit },
              { envelope: true, timeoutMs: EU_FETCH_TIMEOUT_MS },
            ),
          );
        } catch (e) {
          const ns = notServed(e);
          if (!ns) throw e;
          return textResult([heading, "", notServedLine(cc, dataset, ns)], {
            ...base, status: ns.status, covered_countries: ns.covered, rows: null, paging: null,
          });
        }
        const rows = ukSafe(cc, Array.isArray(env.data) ? env.data : []);
        const m = euMeta(env.meta);
        const lines = [heading, `*Grain: ${meta.grain}.*`];
        const latest = str(m.latest_source_date);
        if (latest) lines.push(`*Latest source date in ko.io: ${latest}.*`);
        if (issuer) lines.push(`*Issuer filter: \`${issuer}\` (matched through its LEI/ISIN/name closure in this market).*`);
        const w = windowLine(m);
        if (w) lines.push(w);
        lines.push("");
        if (rows.length) {
          lines.push(...table(dataset, rows));
        } else {
          lines.push(`No ${meta.label.toLowerCase()} rows${m.softwall ? " inside the Free-plan window" : ""} for this request.`);
        }
        const paging = pagingOf(m, { page, limit, returned: rows.length });
        lines.push(...pagingLines(paging));
        lines.push(...creditLines(cc, [rows]));
        return textResult(lines, {
          ...base,
          status: "live",
          latest_source_date: latest,
          latest_retrieved_at: str(m.latest_retrieved_at),
          rows: rows.map(OUT[dataset]),
          paging,
          plan_limit: planLimitOf(m),
        });
      },
      { outputSchema: spec.output },
    );
  }

  // ---------------------------------------------------------------------------
  // Tool: get_eu_issuer
  // ---------------------------------------------------------------------------
  defineTool(server,
    "get_eu_issuer",
    "One European issuer in one market (se, nl, dk, uk): identity (name, LEI, ISIN, venue) and its newest rows of insider dealings, major holdings, net short positions and annual reports, each with source credit. Takes the issuer id from any get_eu_* row (issuer.id).",
    {
      country: COUNTRY,
      issuer: ISSUER_ID,
    },
    async ({ country, issuer: rawIssuer }) => {
      const cc = country.toUpperCase();
      // Trimmed once, like the list tools' issuer filter: the path, the heading and
      // `requested` all name the same id.
      const issuer = rawIssuer.trim();
      const base = {
        country: cc, requested: issuer, covered_countries: null, issuer: null, match_basis: null, live_datasets: null,
        insider_dealings: null, major_holdings: null, short_positions: null, annual_reports: null, plan_limit: null,
      };
      let env: KoEnvelope<Row>;
      try {
        env = asEnvelope<Row>(
          await koFetch<unknown>(
            config,
            `/api/v1/eu/${segment(country)}/issuers/${encodeURIComponent(issuer)}`,
            {},
            { envelope: true, timeoutMs: EU_FETCH_TIMEOUT_MS },
          ),
        );
      } catch (e) {
        const ns = notServed(e);
        if (!ns) throw e;
        return textResult([`## ${marketName(cc)} — issuer \`${issuer}\``, "", notServedLine(cc, null, ns)], {
          ...base, status: ns.status, covered_countries: ns.covered,
        });
      }
      const d = (env.data && typeof env.data === "object" && !Array.isArray(env.data) ? env.data : {}) as Row;
      const i = (d.issuer ?? {}) as Row;
      const live = new Set<EuDataset>(
        (Array.isArray(env.meta.live_datasets) ? env.meta.live_datasets : []).map((x) => String(x) as EuDataset),
      );
      const KEY: Record<EuDataset, string> = {
        pdmr_dealings: "insider_dealings", major_holdings: "major_holdings",
        short_positions: "short_positions", annual_reports: "annual_reports",
      };
      // A dataset that is not live comes back as [] upstream: that is "not served", not "no rows".
      const rowsOf = (ds: EuDataset): Row[] | null =>
        live.has(ds) && Array.isArray(d[KEY[ds]]) ? ukSafe(cc, d[KEY[ds]] as Row[]) : null;

      const lines = [`## ${cell(i.name)} — ${marketName(cc)} issuer`];
      const ids = [
        `**Id:** \`${cell(i.id)}\` (matched by ${cell(d.match_basis)})`,
        i.lei ? `**LEI:** ${i.lei}${i.lei_valid ? "" : " (checksum invalid)"}` : null,
        i.isin ? `**ISIN:** ${i.isin}${i.isin_valid ? "" : " (checksum invalid)"}` : null,
        i.venue ? `**Venue:** ${cell(i.venue)}` : null,
        i.ticker ? `**Ticker:** ${cell(i.ticker)}` : null,
      ].filter(Boolean);
      lines.push(ids.join(" · "));
      const per = int(env.meta.rows_per_dataset);
      lines.push(`*Newest rows per dataset${per ? ` (up to ${per} each)` : ""}, matched through the id's LEI/ISIN/name closure in this market.*`);
      const w = windowLine(env.meta);
      if (w) lines.push(w);
      // Iron rule 12: a keyless cap must not let a cut list read as complete.
      const sw = env.meta.softwall;
      if (sw?.truncated) {
        lines.push(
          `*Keyless access caps each list at ${sw.row_cap ?? "a fixed number of"} rows; more rows may exist. ` +
          "Send a free ko.io API key (Authorization: Bearer ko_...) for the full list.*",
        );
      }

      const shown: Row[][] = [];
      for (const ds of DATASETS) {
        lines.push(`\n### ${DATASET[ds].label}`);
        if (ds === "short_positions" && d.short_positions === null) {
          lines.push(`Not offered for ${marketName(cc)}.`);
          continue;
        }
        const rows = rowsOf(ds);
        if (rows === null) {
          lines.push("Not live on ko.io for this market yet (pending) -- not an empty result.");
          continue;
        }
        if (!rows.length) {
          lines.push(`No rows for this issuer${env.meta.softwall ? " inside the Free-plan window" : ""}.`);
          continue;
        }
        lines.push(...table(ds, rows));
        shown.push(rows);
      }
      lines.push(...creditLines(cc, shown));

      const listOf = (ds: EuDataset) => rowsOf(ds)?.map(OUT[ds]) ?? null;
      return textResult(lines, {
        ...base,
        status: "live",
        issuer: {
          id: str(i.id), name: str(i.name), lei: str(i.lei), isin: str(i.isin), lei_valid: bool(i.lei_valid),
          isin_valid: bool(i.isin_valid), ticker: str(i.ticker), venue: str(i.venue), lei_entity_verified: bool(i.lei_entity_verified),
        },
        match_basis: str(d.match_basis),
        live_datasets: DATASETS.filter((ds) => live.has(ds)),
        insider_dealings: listOf("pdmr_dealings"),
        major_holdings: listOf("major_holdings"),
        short_positions: listOf("short_positions"),
        annual_reports: listOf("annual_reports"),
        plan_limit: planLimitOf(env.meta),
      });
    },
    { outputSchema: EU_ISSUER_OUTPUT },
  );
}
