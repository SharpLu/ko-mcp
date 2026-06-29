# KO Financial Data — MCP Server

**Real SEC, 13F, insider, congress & macro data your AI agent can cite.**
One command to plug clean, citable US financial data into Claude, Cursor, or ChatGPT.

```bash
claude mcp add ko-financial-data --transport http https://mcp.ko.io/mcp
```

No install, no API key to get started — it's a hosted remote MCP server (Streamable HTTP). **Free tier: 200 calls/day.**

---

## Why KO

Most "financial data" tools hand an LLM a blob of numbers with no provenance. KO is built for agents: every answer traces back to the original SEC filing, so your agent can **cite its source**. Model-agnostic — works with any MCP client.

- **85M+ institutional holdings rows**, 13F data 2013 → today
- **Insider trades** (Form 4), **congressional trades**, **spot Bitcoin-ETF ownership**
- **Company financials**, **macro series** (Treasury, Fed, BLS, OFR)
- **EDGAR source documents** — fetch the actual filing your answer came from

## Example prompts

Once connected, just ask your assistant:

1. *"What did members of Congress trade last week?"*
2. *"Show me the biggest changes in Berkshire Hathaway's latest 13F."*
3. *"Which institutions hold the most spot Bitcoin ETF exposure?"*
4. *"List recent insider buying at NVDA and who the buyers were."*
5. *"Get Apple's quarterly revenue and net income for the last 8 quarters."*

> Live sample: institutions currently hold **$16B+** in US spot Bitcoin ETFs — BlackRock's IBIT alone is held by 1,400+ filers.

## Tools (24)

**Institutions / 13F** — `get_institution_holdings`, `list_institutions`, `get_stock_holders`, `get_stock_activity`
**Stocks** — `get_stock_profile`, `get_stock_price`, `get_stock_financials`, `search`
**Insiders** — `get_insider_trades`, `list_insider_traders`, `get_form144_notices`
**Congress** — `get_congress_trades`, `get_congress_member`
**Crypto** — `get_crypto_exposure`, `get_crypto_holders`, `get_crypto_holder`
**Macro** — `get_treasury_yields`, `get_fed_rates`, `get_economic_indicators`, `get_financial_stress`
**Short data** — `get_ftd_data`
**SEC filings (EDGAR)** — `sec_list_filings`, `sec_get_filing_index`, `sec_get_filing_document`

## Connect

| Client | How |
|--------|-----|
| **Claude Code** | `claude mcp add ko-financial-data --transport http https://mcp.ko.io/mcp` |
| **Claude Desktop / others** | Add a remote MCP server pointing at `https://mcp.ko.io/mcp` (Streamable HTTP) |
| **Cursor** | Add an MCP server with URL `https://mcp.ko.io/mcp` |

## Plans

- **Free** — 200 calls/day, no card required
- **Pro ($29/mo)** — 20K calls/day, full history, all macro tools
- Higher tiers at [ko.io](https://ko.io)

## Links

- Website: https://ko.io
- API docs: https://api.ko.io
- MCP endpoint: https://mcp.ko.io/mcp

Data sourced from SEC EDGAR, US Treasury, Federal Reserve, BLS, and OFR.
