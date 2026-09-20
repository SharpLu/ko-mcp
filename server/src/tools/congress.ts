import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";

export function registerCongressTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_congress_trades
  // ---------------------------------------------------------------------------
  server.tool(
    "get_congress_trades",
    "Search individual stock trades disclosed by U.S. Congress members (House and Senate) under the STOCK Act. Returns a markdown table of transactions: member name, chamber, ticker, buy/sell type, transaction date, disclosure date (the gap between the two reveals reporting delay), dollar amount range, and owner (self/spouse/joint). Use for questions like 'What did Nancy Pelosi trade recently?', 'Which members bought NVDA?', or 'Show the largest Senate trades this quarter'. Filter by chamber, ticker, or member name; sort by traded value, trade count, or recency. For one member's profile and complete trading history, use get_congress_member instead.",
    {
      chamber: z
        .enum(["house", "senate", "all"])
        .optional()
        .default("all")
        .describe("Congressional chamber: house, senate, or all (default all)"),
      // party / state REMOVED 2026-09-12 (ko-bastion#125). They were advertised
      // and silently discarded. The fix was not to implement them: party and
      // state live on marts.dim_congress_members, where 215 of 350 members have
      // BOTH columns blank -- 38.6% fill, 41.8% trade-weighted. A filter that
      // can cover at most 41.8% of the data without saying so is the #126
      // disease in a new place, so the ko-api implementation was written,
      // measured and reverted. Re-add these only after the dimension is filled.
      ticker: z.string().max(200).optional().describe("Stock ticker symbol to filter by, e.g. NVDA or AAPL"),
      search: z.string().max(200).optional().describe("Full or partial member name, e.g. 'Pelosi' or 'Dan Crenshaw'"),
      sort: z
        .enum(["volume", "trades", "recent"])
        .optional()
        .default("volume")
        .describe("Sort order — volume (most traded value), trades (most trades), recent (latest first)"),
      page: z.number().int().min(1).optional().default(1)
        .describe("Page number for pagination (default 1)"),
      limit: z.number().int().min(1).max(50).optional().default(20)
        .describe("Trades per page, 1-50 (default 20)"),
    },
    async ({ chamber, ticker, search, sort, page, limit }) => {
      // koFetch returns the array directly
      const trades = await koFetch<CongressTrade[]>(
        config,
        "/api/v1/congress-trades",
        { chamber, ticker, search, sort, page, limit }
      );

      const lines: string[] = [];
      lines.push(`## Congress Trades\n`);

      if (trades.length > 0) {
        lines.push("| # | Member | Chamber | Ticker | Asset | Type | Date | Disclosed | Amount | Owner |");
        lines.push("|---|--------|---------|--------|-------|------|------|-----------|--------|-------|");

        for (const [i, t] of trades.entries()) {
          const num = (page - 1) * limit + i + 1;
          lines.push(
            `| ${num} | **${t.member_name}** | ${t.chamber} | ${t.ticker || "—"} | ${t.asset_description?.slice(0, 40) || "—"} | ${t.transaction_type} | ${t.transaction_date} | ${t.disclosure_date} | ${t.amount_range} | ${t.owner || "—"} |`
          );
        }
      } else {
        lines.push("No congress trades found matching the criteria.");
      }

      if (trades.length === limit) {
        lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_congress_member
  // ---------------------------------------------------------------------------
  server.tool(
    "get_congress_member",
    "Get detailed trading history of a specific U.S. Congress member. Shows individual trades with transaction types, amounts, and disclosure dates.",
    {
      member: z
        .string()
        .describe(
          "Member slug (e.g. 'nancy-pelosi', 'dan-crenshaw'). Use get_congress_trades or search to find exact slugs."
        ),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async ({ member, page, limit }) => {
      const memberSlug = encodeURIComponent(member.toLowerCase().trim());

      // koFetch returns the array directly.
      // PAGE SIZE IS `per_page`, NOT `limit` (ko-bastion#126): the :member route
      // reads only `per_page` and falls back to its own 50-row default otherwise.
      // NOTE the sibling /api/v1/congress-trades collection route above is the one
      // route in this surface that DOES accept `limit` (`per_page ?? limit`), which
      // is why get_congress_trades was never affected and is not touched here.
      // ENVELOPE, NOT JUST `data` (CONGRESS_10_DOD D1, ko-bastion#170). About 72
      // members file every disclosure on paper: the clerk publishes a scan,
      // nothing machine-readable comes out of it, and ko-api answers 200 with an
      // empty `data` plus the reason in `meta.coverage`. Rendering only `data`
      // would report "0 trades returned" for a member who demonstrably DID file
      // -- making the model state something untrue, which is the ko-bastion#125
      // disease in a new place.
      //
      // PAGE SIZE IS `per_page`, NOT `limit` (ko-bastion#126): the :member route
      // reads only `per_page` and falls back to its own 50-row default otherwise.
      // NOTE the sibling /api/v1/congress-trades collection route above is the one
      // route in this surface that DOES accept `limit` (`per_page ?? limit`), which
      // is why get_congress_trades was never affected and is not touched here.
      const envelope = await koFetch<CongressMemberEnvelope | CongressTrade[]>(
        config,
        `/api/v1/congress-trades/${memberSlug}`,
        { type: "trades", page, per_page: limit },
        { withEnvelope: true }
      );
      // Tolerate a bare array: an older ko-api build, and every test that mocks
      // the transport with a plain payload.
      const trades: CongressTrade[] = Array.isArray(envelope) ? envelope : (envelope?.data ?? []);
      const coverage = Array.isArray(envelope) ? undefined : envelope?.meta?.coverage;

      // The heading and the count line are deliberately UNCHANGED, including the
      // caller's slug rather than `meta.member.name`: every line here would
      // otherwise depend on whether ko-api#283 has deployed, and this repo's
      // golden fixtures would have to be re-captured in lockstep with another
      // repo's release. The only thing that moves is the EMPTY branch.
      const lines: string[] = [
        `## ${member} — Trading History`,
        `*${trades.length} trades returned*\n`,
      ];

      if (trades.length > 0) {
        lines.push("| Date | Ticker | Asset | Type | Amount | Disclosed | Owner |");
        lines.push("|------|--------|-------|------|--------|-----------|-------|");
        for (const t of trades) {
          lines.push(
            `| ${t.transaction_date} | **${t.ticker || "N/A"}** | ${t.asset_description?.slice(0, 40) || "—"} | ${t.transaction_type} | ${t.amount_range} | ${t.disclosure_date} | ${t.owner || "—"} |`
          );
        }
      } else {
        // A headed table with no rows reads to a model as a valid, complete,
        // empty answer -- the `headed-empty-table` defect. Say it in words, and
        // when the API explains WHY there is nothing, pass that explanation
        // through verbatim rather than paraphrasing a number we did not compute.
        lines.push("No machine-readable trades returned for this member.");
        if (coverage?.note) lines.push(`\n**Coverage:** ${coverage.note}`);
      }

      if (trades.length === limit) {
        lines.push(`\n*Showing ${trades.length} trades — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** What /api/v1/congress-trades/:member returns when asked for the envelope. */
interface CongressMemberEnvelope {
  data: CongressTrade[];
  meta?: {
    member?: {
      name?: string; chamber?: string; party?: string;
      state?: string; district?: string; bioguide_id?: string;
    };
    coverage?: { paper_filings?: number | null; note?: string | null };
  };
}

interface CongressTrade {
  member_name: string;
  chamber: string;
  ticker: string | null;
  asset_description: string | null;
  transaction_type: string;
  transaction_date: string;
  disclosure_date: string;
  amount_range: string;
  owner: string | null;
}
