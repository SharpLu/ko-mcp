import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares, num } from "../format.js";
import { pagingOf, pagingLines, windowLine, planLimitOf, dec, int, fmtIntExact, fmtUsdExact } from "../paging.js";
import { INSIDER_TRADES_OUTPUT } from "../output-schemas.js";

export function registerInsiderTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_insider_trades
  //
  // GRAIN IS THE WHOLE POINT (final-eval 2026-09-26, EVAL_CODEX_TECH #2).
  // This tool used to read /executive-trades/:ticker, whose mart holds ONE row
  // per insider per trade date with a single `action`. Jennifer Newstead's
  // AAPL Form 4 lines on 2026-09-15 were four transactions -- an open-market
  // sale of 1,438 sh ($474,813.22), an RSU vest/exercise acquiring 30,104 sh,
  // 16,228 sh withheld for tax ($5,376,985.52), and the derivative leg of the
  // vest -- and the tool showed them as one "SELL 17,666 sh, $5.85M". A model
  // reads that as a $5.85M discretionary sale; the discretionary part was
  // $474,813.22.
  //
  // Two views now, each saying which one it is:
  //   - executive_cik given  -> /insider/:cik/transactions: ONE ROW PER FORM 4
  //     TRANSACTION LINE with its SEC transaction code. The only per-line route
  //     ko-api has; it is keyed by the insider, so it needs the CIK.
  //   - otherwise            -> /insider-trades?ticker=&include=detail: one row
  //     per insider per trade date, labelled as an aggregate, with the
  //     open-market (P/S) side split from every other acquisition/disposition
  //     and BOTH dollar totals.
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_insider_trades",
    "Get insider (SEC Form 4) transactions for one company. Two grains, and the answer says which: " +
      "(1) with `executive_cik` -> one row per Form 4 transaction line, with its SEC code " +
      "(P open-market purchase, S open-market sale, M/X/C option or RSU exercise/conversion, A grant/award, " +
      "F shares withheld for tax, G gift, ...), shares, price and value; " +
      "(2) without it -> one row per insider per trade date that AGGREGATES all that day's lines, split into " +
      "open-market buys/sells (codes P/S -- the discretionary trading signal) versus all acquisitions/dispositions " +
      "(which also count vests, exercises and tax withholding), with both dollar totals and the line count; " +
      "when ko.io reports them, the Lines cell and structuredContent also carry that day's SEC codes " +
      "(e.g. '4 (F 1, M 2, S 1)'). " +
      "Do not read an aggregate day's total disposed value as a discretionary sale; use the open-market columns. " +
      "Keyless/Free access covers the trailing 92 days; `period` beyond 1Q requires Pro. " +
      "structuredContent carries the exact share counts and dollar amounts.",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol (e.g. 'AAPL')"),
      executive_cik: z
        .string()
        .optional()
        .describe(
          "Insider's SEC CIK (from a previous answer's person_cik, or list_insider_traders). When given, " +
          "returns that insider's individual Form 4 transaction lines in this company, newest first."
        ),
      period: z
        .enum(["1Q", "2Q", "1Y", "ALL"])
        .optional()
        .default("1Q")
        .describe(
          "Trade-date window for the per-day view: 1Q = trailing 90 days (default, allowed on every plan); " +
          "2Q / 1Y / ALL require Pro. Ignored when executive_cik is given (that view returns the full history " +
          "your plan allows)."
        ),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Rows per page, 1-200"),
    },
    async ({ ticker, executive_cik, period, page, limit }) => {
      const t = ticker.toUpperCase();
      const cik = (executive_cik ?? "").trim();

      if (cik) {
        // PAGE SIZE IS `per_page` (ko-bastion#126); the route has no period filter.
        const env = asEnvelope<Form4TxnRow[]>(
          await koFetch<unknown>(
            config,
            `/api/v1/insider/${encodeURIComponent(cik)}/transactions`,
            { ticker: t, page, per_page: limit },
            { envelope: true },
          ),
        );
        const rows = Array.isArray(env.data) ? env.data : [];
        const paging = pagingOf(env.meta, { page, limit, returned: rows.length });
        const lines: string[] = [
          `## Form 4 Transactions — ${t} · insider CIK ${cik}`,
          "*Grain: one row per Form 4 transaction line (newest first). Code = SEC transaction code; " +
            "only P (open-market purchase) and S (open-market sale) are discretionary market trades.*",
        ];
        const w = windowLine(env.meta);
        if (w) lines.push(w);
        lines.push("");
        if (rows.length > 0) {
          lines.push("| Date | Code | Meaning | Security | Deriv. | Acq/Disp | Shares | Price | Value | Owned After |");
          lines.push("|------|------|---------|----------|--------|----------|--------|-------|-------|-------------|");
          for (const r of rows) {
            lines.push(
              `| ${r.transaction_date} | ${r.transaction_code || "—"} | ${codeMeaning(r.transaction_code)} | ${r.security_title || "—"} | ${num(r.is_derivative) ? "yes" : "no"} | ${r.side === "BUY" ? "Acquired" : "Disposed"} | ${fmtIntExact(r.shares)} | ${r.price == null ? "—" : fmtUsdExact(r.price)} | ${r.value == null ? "—" : fmtUsdExact(r.value)} | ${fmtIntExact(r.shares_owned_after)} |`
            );
          }
        } else {
          lines.push(`No Form 4 transaction lines found for insider CIK ${cik} in ${t}${env.meta.softwall ? " inside the Free-plan window" : ""}.`);
        }
        lines.push(...pagingLines(paging));
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            ticker: t,
            grain: "form4_transaction_line",
            executive_cik: cik,
            period: null,
            rows: rows.map((r) => ({
              trade_date: r.transaction_date ?? null,
              person_cik: cik,
              person_name: null,
              transaction_code: r.transaction_code ?? null,
              code_meaning: codeMeaning(r.transaction_code),
              open_market: r.transaction_code === "P" || r.transaction_code === "S",
              acquired_disposed: r.side === "BUY" ? "A" : r.side === "SELL" ? "D" : null,
              security_title: r.security_title ?? null,
              is_derivative: num(r.is_derivative) === 1,
              shares: dec(r.shares),
              price: dec(r.price),
              value: dec(r.value),
              shares_owned_after: dec(r.shares_owned_after),
            })),
            paging,
            plan_limit: planLimitOf(env.meta),
          },
        };
      }

      // Per-insider-per-day aggregate. include=detail adds the P/S-only share
      // counts; include=codes adds the day's Form 4 transaction codes
      // (ko-api#340). ko-api refuses both together with period=ALL (unbounded
      // read), so ALL goes without them: the P/S shares render as unknown and
      // the Lines cell shows the count alone, exactly as before codes existed.
      // An API that does not know `codes` ignores it -- same fallback.
      const env = asEnvelope<InsiderDayRow[]>(
        await koFetch<unknown>(
          config,
          "/api/v1/insider-trades",
          { ticker: t, period, include: period === "ALL" ? undefined : "detail,codes", page, per_page: limit },
          { envelope: true },
        ),
      );
      const rows = Array.isArray(env.data) ? env.data : [];
      const paging = pagingOf(env.meta, { page, limit, returned: rows.length });
      const lines: string[] = [
        `## Insider Trades — ${t} (period ${period})`,
        "*Grain: one row per insider per trade date, AGGREGATING every Form 4 line that day (`Lines`). " +
          "Open-market = SEC codes P/S only (the discretionary trading signal). All acquired/disposed also count " +
          "grants, option/RSU exercises (M), shares withheld for tax (F), gifts (G), etc. -- never read those as a " +
          "sale decision. For the individual lines, call again with executive_cik = the insider's CIK.*",
      ];
      const w = windowLine(env.meta);
      if (w) lines.push(w);
      lines.push("");
      if (rows.length > 0) {
        lines.push("| Date | Insider (CIK) | Title | Lines | Open-Mkt Bought (sh / $) | Open-Mkt Sold (sh / $) | All Acquired (sh) | All Disposed (sh / $) | Owned After |");
        lines.push("|------|---------------|-------|-------|--------------------------|------------------------|-------------------|-----------------------|-------------|");
        for (const r of rows) {
          const title = r.officer_title || (num(r.is_director) ? "Director" : num(r.is_ten_percent_owner) ? "10%+ Owner" : "—");
          lines.push(
            `| ${r.trade_date} | ${r.person_name} (${r.person_cik}) | ${title} | ${linesCell(r)} | ${sideCell(r.ps_shares_bought, r.om_value_bought, r.om_buy_tx)} | ${sideCell(r.ps_shares_sold, r.om_value_sold, r.om_sell_tx)} | ${fmtIntExact(r.stock_shares_bought)} | ${fmtIntExact(r.stock_shares_sold)} / ${fmtUsdExact(r.stock_value_sold)} | ${fmtIntExact(r.shares_owned_after)} |`
          );
        }
      } else {
        lines.push(`No insider trades found for ${t} in period ${period}${env.meta.softwall ? " inside the Free-plan window" : ""}.`);
      }
      lines.push(...pagingLines(paging));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ticker: t,
          grain: "insider_trade_date",
          executive_cik: null,
          period,
          rows: rows.map((r) => ({
            trade_date: r.trade_date ?? null,
            person_cik: r.person_cik ?? null,
            person_name: r.person_name ?? null,
            officer_title: r.officer_title ?? null,
            form4_lines: int(r.total_transactions),
            open_market_buy_lines: int(r.om_buy_tx),
            open_market_sell_lines: int(r.om_sell_tx),
            open_market_shares_bought: dec(r.ps_shares_bought),
            open_market_value_bought: dec(r.om_value_bought),
            open_market_shares_sold: dec(r.ps_shares_sold),
            open_market_value_sold: dec(r.om_value_sold),
            all_shares_acquired: dec(r.stock_shares_bought),
            all_value_acquired: dec(r.stock_value_bought),
            all_shares_disposed: dec(r.stock_shares_sold),
            all_value_disposed: dec(r.stock_value_sold),
            shares_owned_after: dec(r.shares_owned_after),
            first_filed_date: r.first_filed_date ?? null,
            last_filed_date: r.last_filed_date ?? null,
            // Always present on this grain (null = ko.io did not report codes),
            // so the structured shape does not depend on the upstream version.
            transaction_codes: codesOf(r),
            transaction_code_breakdown: breakdownOf(r),
          })),
          paging,
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: INSIDER_TRADES_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: list_insider_traders
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "list_insider_traders",
    "List executives/insiders who have recently traded their company stock. Filter by role (CEO only or all executives). Useful for finding notable insider buying/selling activity across the market.",
    {
      search: z.string().max(200).optional().describe("Search by name or ticker"),
      role: z
        .preprocess((v) => {
          if (v == null) return v;
          const s = String(v).toLowerCase().trim();
          const map: Record<string, string> = {
            ceo: "ceo",
            "chief executive": "ceo",
            "chief executive officer": "ceo",
            executive: "executive",
            exec: "executive",
            executives: "executive",
            officer: "executive",
            officers: "executive",
            all: "all",
            any: "all",
            "": "all",
          };
          return map[s] ?? s;
        }, z.enum(["ceo", "executive", "all"]))
        .optional()
        .default("all")
        .describe("Filter by role (case-insensitive): CEO, executive/officer, or all"),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ search, role, page, limit }) => {
      // PAGE SIZE IS `per_page`, NOT `limit` (ko-bastion#126).
      const env = asEnvelope<InsiderTraderRow[]>(
        await koFetch<unknown>(
          config,
          "/api/v1/insider-trades",
          { search, role, page, per_page: limit },
          { envelope: true },
        ),
      );
      const traders = Array.isArray(env.data) ? env.data : [];

      // Same grain rule as get_insider_trades: a row is one insider on one trade
      // date, and "Sold" used to be every disposition that day (tax withholding
      // included). The open-market columns are the discretionary signal.
      const lines: string[] = [
        `## Insider Traders${role !== "all" ? ` (${role.toUpperCase()}s only)` : ""} — Page ${page}`,
        "*Grain: one row per insider per trade date. Open-market = SEC codes P/S; All Disposed also counts tax " +
          "withholding, gifts and other non-market dispositions.*",
      ];
      const w = windowLine(env.meta);
      if (w) lines.push(w);
      lines.push(
        "",
        "| Ticker | Company | Person (CIK) | Title | Trade Date | Lines | Open-Mkt Bought | Open-Mkt Sold | All Disposed | Shares Owned |",
        "|--------|---------|--------------|-------|------------|-------|-----------------|---------------|--------------|-------------|",
      );

      for (const t of traders) {
        const title = t.officer_title || (num(t.is_director) ? "Director" : num(t.is_ten_percent_owner) ? "10%+ Owner" : "—");
        lines.push(
          `| **${t.ticker}** | ${t.company_name} | ${t.person_name} (${t.person_cik}) | ${title} | ${t.trade_date} | ${num(t.total_transactions) || "—"} | ${fmtMoney(t.om_value_bought)} | ${fmtMoney(t.om_value_sold)} | ${fmtMoney(t.stock_value_sold)} | ${fmtShares(t.shares_owned_after)} |`
        );
      }

      lines.push(...pagingLines(pagingOf(env.meta, { page, limit, returned: traders.length })));

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
 * SEC Form 4 transaction codes (Form 4 General Instructions 8). Only P and S
 * are open-market, discretionary trades; everything else is compensation,
 * exercise mechanics, tax withholding, gifts or other non-market events.
 */
const FORM4_CODES: Record<string, string> = {
  P: "Open-market purchase",
  S: "Open-market sale",
  A: "Grant / award",
  M: "Exercise/conversion of derivative (e.g. option, RSU vest)",
  X: "Exercise of in/at-the-money derivative",
  C: "Conversion of derivative",
  F: "Shares withheld to pay exercise price or tax",
  G: "Gift",
  D: "Disposition to the issuer",
  J: "Other acquisition or disposition",
  I: "Discretionary transaction (plan)",
  W: "Acquired/disposed by will or laws of descent",
  Z: "Deposit into / withdrawal from voting trust",
  K: "Equity swap or similar",
  E: "Expiration of short derivative position",
  H: "Expiration/cancellation of long derivative position",
  O: "Exercise of out-of-the-money derivative",
  L: "Small acquisition (Rule 16a-6)",
  U: "Disposition in a change-of-control tender",
  V: "Voluntarily reported earlier than required",
};

function codeMeaning(code: string | null | undefined): string {
  if (!code) return "—";
  return FORM4_CODES[code] ?? "Other (see Form 4 instructions)";
}

/** "1,438 sh / $474,813.22 (1 line)" -- or "—" when that side did not happen. */
function sideCell(shares: unknown, value: unknown, lines: unknown): string {
  const n = num(lines);
  if (!n && dec(value) === null && dec(shares) === null) return "—";
  const sh = dec(shares) === null ? "? sh" : `${fmtIntExact(shares)} sh`;
  return `${sh} / ${fmtUsdExact(value)} (${n} line${n === 1 ? "" : "s"})`;
}

/** The day's distinct codes, when ko.io reported them (include=codes); else null. */
function codesOf(r: InsiderDayRow): string[] | null {
  return Array.isArray(r.transaction_codes) ? r.transaction_codes.map(String) : null;
}

function breakdownOf(r: InsiderDayRow) {
  if (!Array.isArray(r.transaction_code_breakdown)) return null;
  return r.transaction_code_breakdown.map((b) => ({
    code: b.code ? String(b.code) : null,
    code_meaning: codeMeaning(b.code),
    acquired_disposed: b.acquired_disposed === "D" ? ("D" as const) : ("A" as const),
    is_derivative: b.derivative === true,
    lines: int(b.lines),
    shares: dec(b.shares),
    value: dec(b.value),
  }));
}

/**
 * The Lines cell: "4" as before, or "4 (F 1, M 2, S 1)" -- lines per SEC code --
 * when ko.io reported the codes. The header stays "Lines" either way, so the
 * table's contract does not depend on the upstream version.
 */
function linesCell(r: InsiderDayRow): string {
  const total = fmtIntExact(r.total_transactions);
  const brk = Array.isArray(r.transaction_code_breakdown) ? r.transaction_code_breakdown : null;
  if (!brk || brk.length === 0) return total;
  const per = new Map<string, number>();
  for (const b of brk) {
    const code = b.code ? String(b.code) : "?";
    per.set(code, (per.get(code) ?? 0) + (int(b.lines) ?? 0));
  }
  const parts = [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c} ${n}`);
  return `${total} (${parts.join(", ")})`;
}

/** /api/v1/insider/:cik/transactions -- one Form 4 line. */
interface Form4TxnRow {
  transaction_date: string;
  ticker: string;
  company: string;
  transaction_code: string;
  signal_class: string;
  side: string;
  trade_type: string;
  security_title: string | null;
  shares: number | string | null;
  price: number | string | null;
  value: number | string | null;
  shares_owned_after: number | string | null;
  is_derivative: number | string;
  ownership_type: string | null;
}

/** /api/v1/insider-trades (+ include=detail) -- one insider, one trade date. */
interface InsiderDayRow {
  ticker: string;
  company_name: string;
  person_name: string;
  person_cik: string;
  officer_title: string | null;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  trade_date: string;
  stock_shares_bought: number | string | null;
  stock_value_bought: number | string | null;
  stock_shares_sold: number | string | null;
  stock_value_sold: number | string | null;
  om_value_bought: number | string | null;
  om_value_sold: number | string | null;
  om_buy_tx: number | string | null;
  om_sell_tx: number | string | null;
  total_transactions: number | string | null;
  shares_owned_after: number | string | null;
  ps_shares_bought?: number | string | null;
  ps_shares_sold?: number | string | null;
  first_filed_date?: string | null;
  last_filed_date?: string | null;
  // include=codes (ko-api#340); absent on an API that predates it.
  transaction_codes?: string[] | null;
  transaction_code_breakdown?: Array<{
    code: string | null;
    acquired_disposed: string;
    derivative: boolean;
    lines: number | string | null;
    shares: number | string | null;
    value: number | string | null;
  }> | null;
}

interface InsiderTraderRow {
  ticker: string;
  company_name: string;
  person_name: string;
  person_cik: string;
  officer_title: string | null;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  trade_date: string;
  stock_shares_bought: number;
  stock_value_bought: number;
  stock_shares_sold: number;
  stock_value_sold: number;
  om_value_bought?: number | string | null;
  om_value_sold?: number | string | null;
  total_transactions: number | string;
  shares_owned_after: number;
}
