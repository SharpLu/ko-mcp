import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, KoApiError, KO_FETCH_TIMEOUT_MS, type KoConfig } from "../ko-fetch.js";
import { str, int } from "../paging.js";
import { FILINGS_LIST_OUTPUT, FILING_INDEX_OUTPUT, FILING_DOCUMENT_OUTPUT } from "../output-schemas.js";

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
  defineTool(server, 
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
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          cik,
          filters: { form_type: str(form_type), from: str(from), to: str(to) },
          rows: (Array.isArray(filings) ? filings : []).map((f) => ({
            filing_date: str(f.filingDate), form: str(f.form), accession: str(f.accession),
            primary_document: str(f.primaryDocument), description: str(f.primaryDocDescription),
          })),
        },
      };
    },
    { outputSchema: FILINGS_LIST_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // sec_get_filing_index
  // ---------------------------------------------------------------------------
  defineTool(server, 
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
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          cik: str(index.cik),
          accession: str(index.accession),
          files: index.files.map((f) => ({ name: str(f.name), type: str(f.type), size_bytes: int(f.size), last_modified: str(f.lastModified) })),
        },
      };
    },
    { outputSchema: FILING_INDEX_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // sec_get_filing_document
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "sec_get_filing_document",
    "Get a source document from a SEC filing, served by ko.io. Returns a ko.io LINK to the rendered document (open in a browser) plus, optionally, an extracted text excerpt. Never returns the whole file — for full content, open the link or request a specific section. " +
      "Requires a paid ko.io plan (Pro): on Free or keyless access the call returns an explicit plan-limit error. " +
      "Use sec_list_filings / sec_get_filing_index (open on every plan) to find filings and their files.",
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
      // Both legs are paid upstream (/share = apiKeyPaid, /file =
      // signedTokenOrApiKeyPaid). A Free/keyless caller used to get a SUCCESS
      // envelope holding an unsigned link it could not open and
      // "(excerpt unavailable: 403)" -- which a model reports as "I fetched the
      // document". A plan refusal is now an error that names the plan.
      //
      // Rule (final-eval R1 #6): a CONFIRMED plan denial stays an error unless
      // something usable actually came back. "Usable" = a signed link, or an
      // excerpt that arrived. An unsigned link is not usable to a caller without
      // a paid key, so a 5xx / timeout on the other leg must not launder a
      // PLAN_REQUIRED into a success.
      let planDenied: string | null = null;
      let shareOk = false;
      let shareFailure: string | null = null;
      let expiresAt: string | null = null;
      try {
        const share = await koFetch<{ url: string; expires_at: string }>(
          config,
          `/api/v1/filings/${encodeURIComponent(cik)}/${encodeURIComponent(accession_no)}/share`,
          file ? { file } : {},
        );
        if (share && typeof share.url === "string" && share.url) {
          htmlLink = share.url;
          expiresAt = share.expires_at ?? null;
          shareOk = true;
          linkNote = ` *(link valid until ${share.expires_at})*`;
        } else {
          shareFailure = "share link response carried no url";
        }
      } catch (e) {
        if (e instanceof KoApiError && (e.status === 401 || e.status === 403)) planDenied = e.message;
        else shareFailure = e instanceof Error ? e.message : String(e);
      }
      if (!shareOk) linkNote = " *(unsigned link — requires a paid API key to open)*";

      const lines = [
        `## SEC Filing Document`,
        `**CIK** ${cik} · **Accession** \`${accession_no}\`${file ? ` · **File** \`${file}\`` : " · primary document"}`,
        `**Source:** SEC EDGAR · served by ko.io`,
        `\n**View:** ${htmlLink}${linkNote}`,
      ];

      let excerptStatus: "ok" | "unavailable" | "not_requested" = "not_requested";
      let excerptText: string | null = null;
      let excerptChars: number | null = null;
      let excerptFailure: string | null = null;
      if (include_excerpt) {
        try {
          const mdUrl = new URL(`${base}${file ? `?file=${encodeURIComponent(file)}&` : "?"}format=markdown`, config.baseUrl);
          // No key -> demo mode (mirror ko-fetch); without it the excerpt 401s.
          if (!config.apiKey) mdUrl.searchParams.set("demo", "true");
          // The one raw fetch in the tool layer. It gets the same bound as
          // koFetch (ko-bastion#127): an excerpt that never arrives must not be
          // able to hold the whole tool call open past the upstream's budget.
          const res = await fetch(mdUrl.toString(), {
            headers: config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}`, "User-Agent": "ko-mcp-worker/1.0" }
              : { "User-Agent": "ko-mcp-worker/1.0" },
            signal: AbortSignal.timeout(KO_FETCH_TIMEOUT_MS),
          });
          if (res.ok) {
            const text = await res.text();
            excerptStatus = "ok";
            excerptChars = text.length;
            excerptText = text.slice(0, MAX_EXCERPT);
            lines.push(`\n---\n\n${excerptText}${text.length > MAX_EXCERPT ? `\n\n*[excerpt — ${text.length.toLocaleString()} chars total; open the link for the full document]*` : ""}`);
          } else {
            excerptStatus = "unavailable";
            if (res.status === 401 || res.status === 403) {
              planDenied ??= `ko.io API error (${res.status}): excerpt refused (paid plan required)`;
            }
            excerptFailure = `ko.io API error (${res.status})`;
            lines.push(`\n*(excerpt unavailable: ${res.status})*`);
          }
        } catch (e) {
          excerptStatus = "unavailable";
          excerptFailure = e instanceof Error ? e.message : "fetch error";
          lines.push(`\n*(excerpt unavailable: ${excerptFailure})*`);
        }
      }

      const usable = shareOk || excerptStatus === "ok";
      if (!usable) {
        if (planDenied) return planLimitResult(planDenied);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text:
              "ko.io could not serve this filing document right now (no signed link and no excerpt). " +
              `Share link: ${shareFailure ?? "not attempted"}. Excerpt: ${excerptFailure ?? "not requested"}. ` +
              "This is a service failure, not evidence the document does not exist; retry, or use sec_get_filing_index.",
          }],
        };
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          cik,
          accession_no,
          file: file ?? null,
          link: { url: htmlLink, signed: shareOk, expires_at: expiresAt },
          excerpt: {
            status: excerptStatus,
            text: excerptText,
            chars_total: excerptChars,
            truncated: excerptChars !== null ? excerptChars > MAX_EXCERPT : null,
          },
        },
      };
    },
    { outputSchema: FILING_DOCUMENT_OUTPUT },
  );
}

function planLimitResult(upstream: string) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text:
        "ko.io plan limit (PLAN_REQUIRED): sec_get_filing_document requires a paid ko.io plan (Pro). " +
        "This caller is on the Free plan or keyless, so neither the signed link nor the excerpt can be served -- " +
        "this is a plan limit, not a missing document. sec_list_filings and sec_get_filing_index work on every plan; " +
        `SEC's own copy is on https://www.sec.gov/. Upstream said: ${upstream}`,
    }],
  };
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
