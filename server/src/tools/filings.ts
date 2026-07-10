import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";

/**
 * SEC source-document gateway tools (ko-api#104).
 *
 * These surface the ORIGINAL filing documents (10-K / 13F / 8-K / ...) served
 * under ko.io. Design rule: get_filing_document returns a ko.io LINK + metadata
 * (+ an optional extracted excerpt), and NEVER dumps a whole filing into model
 * context — iXBRL 10-Ks are 5-30 MB and would blow up context + cost.
 *
 * The worker is a thin client: it calls ko-api (which does the rate-limited,
 * fair-access EDGAR fetch on a registered origin IP). The worker never hits SEC.
 */

const MAX_EXCERPT = 6000; // chars — keep well under any model context budget

export function registerFilingTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // sec_list_filings
  // ---------------------------------------------------------------------------
  server.tool(
    "sec_list_filings",
    "List an entity's SEC filings from EDGAR (most recent first), each with its accession number. Provide the company's CIK (use search or get_stock_profile to find it). Returns accession numbers to pass to sec_get_filing_index / sec_get_filing_document.",
    {
      cik: z.string().max(200).describe("Company CIK number (e.g. '320193' for Apple)"),
      form_type: z.string().max(200).optional().describe("Exact SEC form filter, e.g. '10-K', '13F-HR', '8-K'"),
      from: z.string().max(200).optional().describe("Earliest filing date, ISO YYYY-MM-DD"),
      to: z.string().max(200).optional().describe("Latest filing date, ISO YYYY-MM-DD"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max filings to return"),
    },
    async ({ cik, form_type, from, to, limit }) => {
      const filings = await koFetch<FilingListItem[]>(config, `/api/v1/filings/${encodeURIComponent(cik)}`, {
        form: form_type, from, to, limit,
      });
      const lines = [
        `## SEC Filings — CIK ${cik}`,
        `*${filings.length} filings · Source: SEC EDGAR*\n`,
        "| Filed | Form | Accession | Primary Document |",
        "|-------|------|-----------|------------------|",
      ];
      for (const f of filings) {
        lines.push(`| ${f.filingDate} | ${f.form} | \`${f.accession}\` | ${f.primaryDocument || "—"} |`);
      }
      if (filings.length === 0) lines.push("\nNo filings found.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // sec_get_filing_index
  // ---------------------------------------------------------------------------
  server.tool(
    "sec_get_filing_index",
    "Enumerate every file in a single SEC filing (primary document, exhibits, images, XBRL, the full .txt submission). Pass a file name from here to sec_get_filing_document.",
    {
      cik: z.string().max(200).describe("Company CIK number"),
      accession_no: z.string().max(200).describe("Accession number, e.g. '0000320193-23-000106'"),
    },
    async ({ cik, accession_no }) => {
      const index = await koFetch<FilingIndex>(
        config,
        `/api/v1/filings/${encodeURIComponent(cik)}/${encodeURIComponent(accession_no)}`,
      );
      const lines = [
        `## Filing ${index.accession} — CIK ${index.cik}`,
        `*${index.files.length} files · Source: SEC EDGAR*\n`,
        "| File | Type | Size |",
        "|------|------|------|",
      ];
      for (const f of index.files) {
        lines.push(`| \`${f.name}\` | ${f.type || "—"} | ${f.size ? `${f.size.toLocaleString()} B` : "—"} |`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // sec_get_filing_document
  // ---------------------------------------------------------------------------
  server.tool(
    "sec_get_filing_document",
    "Get a source document from a SEC filing, served by ko.io. Returns a ko.io LINK to the rendered document (open in a browser) plus, optionally, an extracted text excerpt. Never returns the whole file — for full content, open the link or request a specific section.",
    {
      cik: z.string().max(200).describe("Company CIK number"),
      accession_no: z.string().max(200).describe("Accession number, e.g. '0000320193-23-000106'"),
      file: z.string().max(200).optional().describe("File name within the filing (from sec_get_filing_index). Omit for the primary document."),
      include_excerpt: z.boolean().optional().default(true).describe("Include a text excerpt (first ~6000 chars) in the response"),
    },
    async ({ cik, accession_no, file, include_excerpt }) => {
      const base = `/api/v1/filings/${encodeURIComponent(cik)}/${encodeURIComponent(accession_no)}/file`;
      const q = file ? `?file=${encodeURIComponent(file)}` : "";

      // Browsers can't send Authorization headers, so the View link must be a
      // signed share link (ko.io-minted, expiring, scoped to this filing).
      // Fall back to the bare URL (works for API clients) if share fails.
      let htmlLink = new URL(`${base}${q}`, config.baseUrl).toString();
      let linkNote = "";
      try {
        const share = await koFetch<{ url: string; expires_at: string }>(
          config,
          `/api/v1/filings/${encodeURIComponent(cik)}/${encodeURIComponent(accession_no)}/share`,
          file ? { file } : {},
        );
        htmlLink = share.url;
        linkNote = ` *(link valid until ${share.expires_at})*`;
      } catch {
        linkNote = " *(unsigned link — requires an API key to open)*";
      }

      const lines = [
        `## SEC Filing Document`,
        `**CIK** ${cik} · **Accession** \`${accession_no}\`${file ? ` · **File** \`${file}\`` : " · primary document"}`,
        `**Source:** SEC EDGAR · served by ko.io`,
        `\n**View:** ${htmlLink}${linkNote}`,
      ];

      if (include_excerpt) {
        try {
          const mdUrl = new URL(`${base}${file ? `?file=${encodeURIComponent(file)}&` : "?"}format=markdown`, config.baseUrl);
          const res = await fetch(mdUrl.toString(), {
            headers: config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}`, "User-Agent": "ko-mcp-worker/1.0" }
              : { "User-Agent": "ko-mcp-worker/1.0" },
          });
          if (res.ok) {
            const text = await res.text();
            const excerpt = text.slice(0, MAX_EXCERPT);
            lines.push(`\n---\n\n${excerpt}${text.length > MAX_EXCERPT ? `\n\n*[excerpt — ${text.length.toLocaleString()} chars total; open the link for the full document]*` : ""}`);
          } else {
            lines.push(`\n*(excerpt unavailable: ${res.status})*`);
          }
        } catch (e) {
          lines.push(`\n*(excerpt unavailable: ${e instanceof Error ? e.message : "fetch error"})*`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types (mirror ko-api/src/lib/edgar/types.ts)
// ---------------------------------------------------------------------------
interface FilingListItem {
  accession: string;
  form: string;
  filingDate: string;
  primaryDocument: string;
  primaryDocDescription: string;
}
interface FilingFileEntry { name: string; type: string; size: number; lastModified: string }
interface FilingIndex { cik: string; accession: string; files: FilingFileEntry[] }
