"""Synchronous resource namespaces for :class:`ko_edgar.KoClient`."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable

from . import _endpoints as ep
from .result import ApiResult

Getter = Callable[[str, Mapping[str, Any]], ApiResult]


class _Resource:
    def __init__(self, get: Getter) -> None:
        self._get = get


class Institutions(_Resource):
    """13F institutional filers and their holdings (85M+ rows, 2013→today)."""

    def list(
        self,
        search: str | None = None,
        category: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """List institutions ranked by portfolio value.

        >>> ko.institutions.list(search="berkshire")[0]["name"]
        'Berkshire Hathaway Inc'
        """
        return self._get(*ep.institutions_list(search, category, page, per_page))

    def get(self, cik: str) -> ApiResult:
        """Institution profile by CIK (e.g. Berkshire = ``"1067983"``)."""
        return self._get(*ep.institution_get(cik))

    def holdings(
        self,
        cik: str,
        quarter: str | None = None,
        ticker: str | None = None,
        action: str | None = None,
        scope: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Holdings for an institution (or manager family), latest quarter by default.

        ``quarter`` is a quarter-end date like ``"2026-03-31"``. ``action``
        filters by quarter-over-quarter change: ``NEW_POSITION``, ``ADDED``,
        ``TRIMMED``, ``CLEARED``, ``UNCHANGED``. Pass ``ticker`` with
        ``scope="all"`` for the full per-quarter trade history of one stock.
        """
        return self._get(
            *ep.institution_holdings(cik, quarter, ticker, action, scope, page, per_page)
        )

    def quarters(self, cik: str) -> ApiResult:
        """Available quarters for an institution.

        Returns an object: ``{"quarters": [...], "latest_quarter": ...}``.
        """
        return self._get(*ep.institution_quarters(cik))

    def activity(self, cik: str) -> ApiResult:
        """Quarterly buy/sell activity summary."""
        return self._get(*ep.institution_activity(cik))

    def similar(self, cik: str) -> ApiResult:
        """Institutions with a similar strategy profile."""
        return self._get(*ep.institution_similar(cik))


class Stocks(_Resource):
    """Company profiles, prices, financials, and institutional ownership."""

    def list(
        self,
        search: str | None = None,
        sector: str | None = None,
        page: int = 1,
        per_page: int = 24,
    ) -> ApiResult:
        """Search / browse stocks."""
        return self._get(*ep.stocks_list(search, sector, page, per_page))

    def get(self, ticker: str) -> ApiResult:
        """Stock profile: company info, key stats, latest ownership summary."""
        return self._get(*ep.stock_get(ticker))

    def price(
        self,
        ticker: str,
        days: int | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        page: int = 1,
        per_page: int = 500,
    ) -> ApiResult:
        """Daily OHLCV history (most recent first)."""
        return self._get(*ep.stock_price(ticker, days, start_date, end_date, page, per_page))

    def holders(
        self,
        ticker: str,
        quarter: str | None = None,
        action: str | None = None,
        page: int = 1,
        per_page: int = 12,
    ) -> ApiResult:
        """Institutional holders of a ticker (13F, family-consolidated).

        Note: rows are nested — use ``result.rows`` (handled automatically).
        """
        return self._get(*ep.stock_holders(ticker, quarter, action, page, per_page))

    def activity(self, ticker: str, quarters: int = 8) -> ApiResult:
        """Institutional accumulation/distribution across recent quarters."""
        return self._get(*ep.stock_activity(ticker, quarters))

    def financials(self, ticker: str) -> ApiResult:
        """Latest reported financials."""
        return self._get(*ep.stock_financials(ticker))

    def financials_history(self, ticker: str) -> ApiResult:
        """Historical financials.

        Returns an object with ``quarterly`` and ``annual`` arrays.
        """
        return self._get(*ep.stock_financials_history(ticker))


class Insiders(_Resource):
    """Insider (Form 3/4/5) transactions by executives and directors."""

    def trades(
        self,
        ticker: str | None = None,
        role: str | None = None,
        period: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Recent insider trades, optionally filtered by ticker or role."""
        return self._get(*ep.insider_trades(ticker, role, period, page, per_page))

    def by_company(self, ticker: str) -> ApiResult:
        """Insiders who traded a company's stock."""
        return self._get(*ep.insider_by_company(ticker))

    def get(self, cik: str) -> ApiResult:
        """Profile of one insider (person) by CIK."""
        return self._get(*ep.insider_get(cik))

    def transactions(
        self,
        cik: str,
        ticker: str | None = None,
        signal: str | None = None,
        side: str | None = None,
        page: int = 1,
        per_page: int = 25,
    ) -> ApiResult:
        """One insider's transactions. ``side``: ``BUY`` or ``SELL``."""
        return self._get(*ep.insider_transactions(cik, ticker, signal, side, page, per_page))

    def executive_trades(self, ticker: str) -> ApiResult:
        """Executive trades for a ticker (the view behind the MCP tool)."""
        return self._get(*ep.executive_trades(ticker))


class Congress(_Resource):
    """US Congress member stock trades (STOCK Act disclosures)."""

    def trades(
        self,
        ticker: str | None = None,
        chamber: str | None = None,
        party: str | None = None,
        search: str | None = None,
        sort: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Congress trades. ``chamber``: house/senate. ``party``: D/R/I.

        ``sort``: ``volume`` | ``trades`` | ``recent``.
        """
        return self._get(*ep.congress_trades(ticker, chamber, party, search, sort, page, per_page))

    def member(self, slug: str, page: int = 1, per_page: int = 50) -> ApiResult:
        """A member's trades by slug (e.g. ``"nancy-pelosi"``)."""
        return self._get(*ep.congress_member(slug, page, per_page))

    def stock(self, ticker: str, page: int = 1, per_page: int = 50) -> ApiResult:
        """All Congress trades in one ticker."""
        return self._get(*ep.congress_stock(ticker, page, per_page))


class Crypto(_Resource):
    """Institutional spot-BTC-ETF exposure derived from 13F filings."""

    def exposure_summary(self) -> ApiResult:
        """Market-wide exposure. Returns an object ``{complex, products}``."""
        return self._get(*ep.crypto_exposure_summary())

    def holders(
        self,
        product: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Institutions holding spot BTC ETFs (``product`` e.g. ``"IBIT"``)."""
        return self._get(*ep.crypto_holders(product, page, per_page))

    def holder(self, cik: str) -> ApiResult:
        """One institution's crypto ETF exposure."""
        return self._get(*ep.crypto_holder(cik))


class Form144(_Resource):
    """Form 144 notices — proposed insider sales filed before the trade."""

    def list(
        self,
        ticker: str | None = None,
        cik: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Recent Form 144 notices."""
        return self._get(*ep.form144_list(ticker, cik, page, per_page))


class Short(_Resource):
    """Short-side stress data: fails-to-deliver and Reg SHO threshold list."""

    def ftd(
        self,
        ticker: str | None = None,
        days: int = 90,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """SEC fails-to-deliver records."""
        return self._get(*ep.ftd(ticker, days, page, per_page))

    def reg_sho(
        self,
        symbol: str | None = None,
        min_consecutive_days: int | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """Reg SHO threshold list (persistent settlement failures)."""
        return self._get(*ep.reg_sho(symbol, min_consecutive_days, page, per_page))


class Macro(_Resource):
    """US macro data. Requires a Pro plan or higher (403 on Free/demo)."""

    def treasury_yields(
        self,
        days: int = 30,
        from_: str | None = None,
        to: str | None = None,
    ) -> ApiResult:
        """Daily Treasury yield curve. **Pro+**"""
        return self._get(*ep.treasury_yields(days, from_, to))

    def fed_rates(self, days: int = 365, series: str | None = None) -> ApiResult:
        """Federal Reserve policy rates. **Pro+**"""
        return self._get(*ep.fed_rates(days, series))

    def economic_indicators(
        self,
        category: str | None = None,
        series_id: str | None = None,
        days: int = 365,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        """CPI, unemployment, NFP, PPI, JOLTS. **Pro+**"""
        return self._get(*ep.economic_indicators(category, series_id, days, page, per_page))

    def financial_stress(self, days: int = 365, series_name: str | None = None) -> ApiResult:
        """OFR Financial Stress Index. **Pro+**"""
        return self._get(*ep.financial_stress(days, series_name))


class Filings(_Resource):
    """SEC EDGAR source-document gateway (white-labeled, cached)."""

    def list(
        self,
        cik: str,
        form: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int = 50,
    ) -> ApiResult:
        """List an entity's SEC filings (``form`` e.g. ``"10-K"``)."""
        return self._get(*ep.filings_list(cik, form, from_, to, limit))

    def index(self, cik: str, accession: str) -> ApiResult:
        """Enumerate the files inside one filing."""
        return self._get(*ep.filings_index(cik, accession))

    def share(self, cik: str, accession: str, file: str | None = None) -> ApiResult:
        """Mint a signed, keyless, browser-openable link to a document. **Paid**"""
        return self._get(*ep.filings_share(cik, accession, file))
