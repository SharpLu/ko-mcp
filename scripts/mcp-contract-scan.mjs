/**
 * Live contract scan of every MCP tool on mcp.ko.io.
 *
 *   node scripts/mcp-contract-scan.mjs                  # demo mode (NO key)
 *   MCP_KEY=ko_live_xxx node scripts/mcp-contract-scan.mjs   # with a real key
 *   MCP_BASE=https://mcp.ko.io node scripts/mcp-contract-scan.mjs
 *
 * Stateless Streamable HTTP: POST /mcp (JSON-RPC). With no key, the worker must
 * fall back to demo mode (free tier, rate-limited) -- NOT a deployment key, so
 * gated datasets (macro / filings) correctly return 403 here. Always exit 0.
 */
const BASE = process.env.MCP_BASE || "https://mcp.ko.io";
const KEY = process.env.MCP_KEY || "";
const url = `${BASE}/mcp${KEY ? `?api_key=${KEY}` : ""}`;

let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP may return SSE framing; extract the JSON payload.
  const jsonStr = text.startsWith("{") ? text : (text.match(/data: (\{.*\})/)?.[1] ?? text);
  try { return JSON.parse(jsonStr); } catch { return { _raw: text, _status: res.status }; }
}

// Precise gate/error markers — koFetch throws "ko.io API error (403): Access
// forbidden (check your plan)". Match that, NOT a bare "403" (data can contain
// 403 as a substring of a CIK/value -> false positives).
const GATE_RE = /ko\.io api error \(40[13]\)|access forbidden|authentication required|check your plan/i;
const ERR_RE = /ko\.io api error \(5\d\d\)|not iterable|undefined is not|cannot read/i;

async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return { tag: "RPC-ERR", text: r.error.message || JSON.stringify(r.error) };
  const result = r.result;
  const text = (result?.content || []).map((c) => c.text || "").join("\n");
  if (GATE_RE.test(text)) return { tag: "GATED", text };
  if (result?.isError || ERR_RE.test(text)) return { tag: "TOOL-ERR", text };
  if (/^\s*$/.test(text) || (/\bno .{0,30}(found|data|holdings|positions|trades|results)\b/i.test(text) && text.length < 160)) return { tag: "EMPTY", text };
  return { tag: "OK", text };
}

// tool -> representative args
const T = {
  get_institution_holdings: { institution: "1067983" },
  list_institutions: {},
  get_stock_profile: { ticker: "NVDA" },
  get_stock_holders: { ticker: "AAPL" },
  get_stock_activity: { ticker: "AAPL" },
  get_stock_price: { ticker: "NVDA" },
  get_insider_trades: { ticker: "AAPL" },
  list_insider_traders: {},
  get_congress_trades: {},
  get_congress_member: { member: "mike-kelly" },
  search: { query: "apple" },
  get_form144_notices: { ticker: "AAPL" },
  sec_list_filings: { cik: "320193" },
  get_stock_financials: { ticker: "AAPL" },
  get_treasury_yields: {},
  get_fed_rates: {},
  get_economic_indicators: {},
  get_ftd_data: { ticker: "AAPL" },
  get_financial_stress: {},
  // crypto (after deploy)
  get_crypto_exposure: {},
  get_crypto_holders: {},
  get_crypto_holder: { institution: "1512857" },
  // filing detail tools need a real accession; covered shallowly
  sec_get_filing_index: { cik: "320193", accession_no: "0000320193-24-000123" },
  sec_get_filing_document: { cik: "320193", accession_no: "0000320193-24-000123" },
};

async function main() {
  console.log(`MCP scan: ${url.replace(KEY, KEY ? "***" : "")}  (mode: ${KEY ? "keyed" : "demo"})\n`);
  const list = await rpc("tools/list", {});
  const tools = (list.result?.tools || []).map((t) => t.name);
  console.log(`registered tools: ${tools.length}`);

  const results = {};
  for (const name of tools) {
    const args = T[name] ?? {};
    const r = await callTool(name, args);
    results[name] = r;
    const mark = ["TOOL-ERR", "RPC-ERR"].includes(r.tag) ? " <<<" : "";
    console.log(`${r.tag.padEnd(9)} ${name}${mark}  ${r.tag !== "OK" ? r.text.slice(0, 90).replace(/\n/g, " ") : r.text.split("\n")[0].slice(0, 70)}`);
  }

  // ── Regression checks (memory: get_stock_financials broken, dividend x100, activity int64) ──
  console.log("\n=== REGRESSION CHECKS ===");
  const fin = await callTool("get_stock_financials", { ticker: "AAPL" });
  const finOk = fin.tag === "OK" && /revenue|net income|margin/i.test(fin.text) && !/not iterable|undefined/i.test(fin.text);
  console.log(`get_stock_financials usable: ${finOk ? "PASS" : "FAIL"}`);

  const prof = await callTool("get_stock_profile", { ticker: "NVDA" });
  const dyMatch = prof.text.match(/dividend[^\n]*?(-?\d+(?:\.\d+)?)\s*%/i);
  const dy = dyMatch ? parseFloat(dyMatch[1]) : null;
  const dyOk = dy === null || dy < 20; // NVDA real ~0.49%; x100 bug -> 49%
  console.log(`dividend yield not x100: ${dyOk ? "PASS" : "FAIL"} (parsed ${dy ?? "n/a"}%)`);

  const act = await callTool("get_stock_activity", { ticker: "AAPL" });
  const overflow = /9223372036854775807|-922337203685/.test(act.text);
  console.log(`get_stock_activity no int64 overflow: ${overflow ? "FAIL" : "PASS"}`);

  // crypto presence
  const hasCrypto = tools.includes("get_crypto_exposure") && tools.includes("get_crypto_holders");
  console.log(`crypto tools present: ${hasCrypto ? "YES" : "NO (deploy pending)"}`);

  // demo fallback proof: gated tools must be GATED (403), not OK, in demo mode
  if (!KEY) {
    const gatedTools = ["get_treasury_yields", "get_fed_rates", "get_economic_indicators", "get_financial_stress"];
    const leaked = gatedTools.filter((t) => results[t]?.tag === "OK");
    console.log(`demo fallback (gated tools 403 not data): ${leaked.length === 0 ? "PASS" : "FAIL -- leaked: " + leaked.join(",")}`);
  }

  // Summary
  const tally = {};
  for (const r of Object.values(results)) tally[r.tag] = (tally[r.tag] || 0) + 1;
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(tally));
  const broken = Object.entries(results).filter(([, r]) => ["TOOL-ERR", "RPC-ERR"].includes(r.tag));
  if (broken.length) {
    console.log("\nBROKEN TOOLS:");
    for (const [n, r] of broken) console.log(`  ${n}: ${r.text.slice(0, 160)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(0); });
