"""Pure endpoint builders: (args) -> (path, query-params).

Single source of truth for URL shapes and parameter names, shared by the
sync and async clients. Keep these free of I/O.
"""

from __future__ import annotations

from typing import Any

Endpoint = tuple[str, dict[str, Any]]


def search(query: str, limit: int | None) -> Endpoint:
    return "/api/v1/search", {"q": query, "limit": limit}


# -- Institutions / 13F ----------------------------------------------------


def institutions_list(
    search: str | None, category: str | None, page: int | None, per_page: int | None
) -> Endpoint:
    return "/api/v1/institutions", {
        "search": search,
        "category": category,
        "page": page,
        "per_page": per_page,
    }


def institution_get(cik: str) -> Endpoint:
    return f"/api/v1/institutions/{cik}", {}


def institution_holdings(
    cik: str,
    quarter: str | None,
    ticker: str | None,
    action: str | None,
    scope: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return f"/api/v1/holdings/{cik}", {
        "quarter": quarter,
        "ticker": ticker,
        "action": action,
        "scope": scope,
        "page": page,
        "per_page": per_page,
    }


def institution_quarters(cik: str) -> Endpoint:
    return f"/api/v1/holdings/{cik}", {"type": "quarters"}


def institution_activity(cik: str) -> Endpoint:
    return f"/api/v1/institution-activity/{cik}", {}


def institution_similar(cik: str) -> Endpoint:
    return f"/api/v1/institutions/{cik}/similar", {}


# -- Stocks ------------------------------------------------------------------


def stocks_list(
    search: str | None, sector: str | None, page: int | None, per_page: int | None
) -> Endpoint:
    return "/api/v1/stocks", {
        "search": search,
        "sector": sector,
        "page": page,
        "per_page": per_page,
    }


def stock_get(ticker: str) -> Endpoint:
    return f"/api/v1/stocks/{ticker.upper()}", {}


def stock_price(
    ticker: str,
    days: int | None,
    start_date: str | None,
    end_date: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return f"/api/v1/stock-price/{ticker.upper()}", {
        "days": days,
        "start_date": start_date,
        "end_date": end_date,
        "page": page,
        "per_page": per_page,
    }


def stock_holders(
    ticker: str,
    quarter: str | None,
    action: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return f"/api/v1/stock-holders/{ticker.upper()}", {
        "quarter": quarter,
        "action": action,
        "page": page,
        "per_page": per_page,
    }


def stock_activity(ticker: str, quarters: int | None) -> Endpoint:
    return f"/api/v1/stock-holders/{ticker.upper()}", {"type": "activity", "quarters": quarters}


def stock_financials(ticker: str) -> Endpoint:
    return f"/api/v1/stocks/{ticker.upper()}/financials", {}


def stock_financials_history(ticker: str) -> Endpoint:
    return f"/api/v1/stocks/{ticker.upper()}/financials/historical", {}


# -- Insiders (Forms 3/4/5) ---------------------------------------------------


def insider_trades(
    ticker: str | None,
    role: str | None,
    period: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return "/api/v1/insider-trades", {
        "ticker": ticker,
        "role": role,
        "period": period,
        "page": page,
        "per_page": per_page,
    }


def insider_by_company(ticker: str) -> Endpoint:
    return f"/api/v1/insider/by-company/{ticker.upper()}", {}


def insider_get(cik: str) -> Endpoint:
    return f"/api/v1/insider/{cik}", {}


def insider_transactions(
    cik: str,
    ticker: str | None,
    signal: str | None,
    side: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return f"/api/v1/insider/{cik}/transactions", {
        "ticker": ticker,
        "signal": signal,
        "side": side,
        "page": page,
        "per_page": per_page,
    }


def executive_trades(ticker: str) -> Endpoint:
    return f"/api/v1/executive-trades/{ticker.upper()}", {}


# -- Congress -----------------------------------------------------------------


def congress_trades(
    ticker: str | None,
    chamber: str | None,
    party: str | None,
    search: str | None,
    sort: str | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return "/api/v1/congress-trades", {
        "ticker": ticker,
        "chamber": chamber,
        "party": party,
        "search": search,
        "sort": sort,
        "page": page,
        "per_page": per_page,
    }


def congress_member(slug: str, page: int | None, per_page: int | None) -> Endpoint:
    return f"/api/v1/congress-trades/{slug}", {"page": page, "per_page": per_page}


def congress_stock(ticker: str, page: int | None, per_page: int | None) -> Endpoint:
    return f"/api/v1/congress-trades/stock/{ticker.upper()}", {"page": page, "per_page": per_page}


# -- Crypto (spot BTC ETFs) -----------------------------------------------------


def crypto_exposure_summary() -> Endpoint:
    return "/api/v1/crypto/exposure-summary", {}


def crypto_holders(
    product: str | None, page: int | None, per_page: int | None
) -> Endpoint:
    return "/api/v1/crypto/institutional-holders", {
        "product": product,
        "page": page,
        "per_page": per_page,
    }


def crypto_holder(cik: str) -> Endpoint:
    return f"/api/v1/crypto/holder/{cik}", {}


# -- Form 144 -------------------------------------------------------------------


def form144_list(
    ticker: str | None, cik: str | None, page: int | None, per_page: int | None
) -> Endpoint:
    return "/api/v1/form144-notices", {
        "ticker": ticker,
        "cik": cik,
        "page": page,
        "per_page": per_page,
    }


# -- Short-side data --------------------------------------------------------------


def ftd(
    ticker: str | None, days: int | None, page: int | None, per_page: int | None
) -> Endpoint:
    return "/api/v1/sec/ftd", {"ticker": ticker, "days": days, "page": page, "per_page": per_page}


def reg_sho(
    symbol: str | None,
    min_consecutive_days: int | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return "/api/v1/reg-sho-threshold", {
        "symbol": symbol,
        "min_consecutive_days": min_consecutive_days,
        "page": page,
        "per_page": per_page,
    }


# -- Macro (Pro plan and above) -----------------------------------------------------


def treasury_yields(days: int | None, from_: str | None, to: str | None) -> Endpoint:
    return "/api/v1/treasury/yields", {"days": days, "from": from_, "to": to}


def fed_rates(days: int | None, series: str | None) -> Endpoint:
    return "/api/v1/fed/rates", {"days": days, "series": series}


def economic_indicators(
    category: str | None,
    series_id: str | None,
    days: int | None,
    page: int | None,
    per_page: int | None,
) -> Endpoint:
    return "/api/v1/economic/indicators", {
        "category": category,
        "series_id": series_id,
        "days": days,
        "page": page,
        "per_page": per_page,
    }


def financial_stress(days: int | None, series_name: str | None) -> Endpoint:
    return "/api/v1/stress/ofr", {"days": days, "series_name": series_name}


# -- SEC filings gateway --------------------------------------------------------------


def filings_list(
    cik: str, form: str | None, from_: str | None, to: str | None, limit: int | None
) -> Endpoint:
    return f"/api/v1/filings/{cik}", {"form": form, "from": from_, "to": to, "limit": limit}


def filings_index(cik: str, accession: str) -> Endpoint:
    return f"/api/v1/filings/{cik}/{accession}", {}


def filings_share(cik: str, accession: str, file: str | None) -> Endpoint:
    return f"/api/v1/filings/{cik}/{accession}/share", {"file": file}
