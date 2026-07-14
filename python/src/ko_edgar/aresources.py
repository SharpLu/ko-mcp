"""Async resource namespaces for :class:`ko_edgar.AsyncKoClient`.

Method-for-method mirror of :mod:`ko_edgar.resources`; see that module for
full docstrings. All methods are coroutines.
"""

from __future__ import annotations

from collections.abc import Awaitable, Mapping
from typing import Any, Callable

from . import _endpoints as ep
from .result import ApiResult

AsyncGetter = Callable[[str, Mapping[str, Any]], Awaitable[ApiResult]]


class _AsyncResource:
    def __init__(self, get: AsyncGetter) -> None:
        self._get = get


class AsyncInstitutions(_AsyncResource):
    async def list(
        self,
        search: str | None = None,
        category: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.institutions_list(search, category, page, per_page))

    async def get(self, cik: str) -> ApiResult:
        return await self._get(*ep.institution_get(cik))

    async def holdings(
        self,
        cik: str,
        quarter: str | None = None,
        ticker: str | None = None,
        action: str | None = None,
        scope: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(
            *ep.institution_holdings(cik, quarter, ticker, action, scope, page, per_page)
        )

    async def quarters(self, cik: str) -> ApiResult:
        return await self._get(*ep.institution_quarters(cik))

    async def activity(self, cik: str) -> ApiResult:
        return await self._get(*ep.institution_activity(cik))

    async def similar(self, cik: str) -> ApiResult:
        return await self._get(*ep.institution_similar(cik))


class AsyncStocks(_AsyncResource):
    async def list(
        self,
        search: str | None = None,
        sector: str | None = None,
        page: int = 1,
        per_page: int = 24,
    ) -> ApiResult:
        return await self._get(*ep.stocks_list(search, sector, page, per_page))

    async def get(self, ticker: str) -> ApiResult:
        return await self._get(*ep.stock_get(ticker))

    async def price(
        self,
        ticker: str,
        days: int | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        page: int = 1,
        per_page: int = 500,
    ) -> ApiResult:
        return await self._get(*ep.stock_price(ticker, days, start_date, end_date, page, per_page))

    async def holders(
        self,
        ticker: str,
        quarter: str | None = None,
        action: str | None = None,
        page: int = 1,
        per_page: int = 12,
    ) -> ApiResult:
        return await self._get(*ep.stock_holders(ticker, quarter, action, page, per_page))

    async def activity(self, ticker: str, quarters: int = 8) -> ApiResult:
        return await self._get(*ep.stock_activity(ticker, quarters))

    async def financials(self, ticker: str) -> ApiResult:
        return await self._get(*ep.stock_financials(ticker))

    async def financials_history(self, ticker: str) -> ApiResult:
        return await self._get(*ep.stock_financials_history(ticker))


class AsyncInsiders(_AsyncResource):
    async def trades(
        self,
        ticker: str | None = None,
        role: str | None = None,
        period: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.insider_trades(ticker, role, period, page, per_page))

    async def by_company(self, ticker: str) -> ApiResult:
        return await self._get(*ep.insider_by_company(ticker))

    async def get(self, cik: str) -> ApiResult:
        return await self._get(*ep.insider_get(cik))

    async def transactions(
        self,
        cik: str,
        ticker: str | None = None,
        signal: str | None = None,
        side: str | None = None,
        page: int = 1,
        per_page: int = 25,
    ) -> ApiResult:
        return await self._get(*ep.insider_transactions(cik, ticker, signal, side, page, per_page))

    async def executive_trades(self, ticker: str) -> ApiResult:
        return await self._get(*ep.executive_trades(ticker))


class AsyncCongress(_AsyncResource):
    async def trades(
        self,
        ticker: str | None = None,
        chamber: str | None = None,
        party: str | None = None,
        search: str | None = None,
        sort: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(
            *ep.congress_trades(ticker, chamber, party, search, sort, page, per_page)
        )

    async def member(self, slug: str, page: int = 1, per_page: int = 50) -> ApiResult:
        return await self._get(*ep.congress_member(slug, page, per_page))

    async def stock(self, ticker: str, page: int = 1, per_page: int = 50) -> ApiResult:
        return await self._get(*ep.congress_stock(ticker, page, per_page))


class AsyncCrypto(_AsyncResource):
    async def exposure_summary(self) -> ApiResult:
        return await self._get(*ep.crypto_exposure_summary())

    async def holders(
        self,
        product: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.crypto_holders(product, page, per_page))

    async def holder(self, cik: str) -> ApiResult:
        return await self._get(*ep.crypto_holder(cik))


class AsyncForm144(_AsyncResource):
    async def list(
        self,
        ticker: str | None = None,
        cik: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.form144_list(ticker, cik, page, per_page))


class AsyncShort(_AsyncResource):
    async def ftd(
        self,
        ticker: str | None = None,
        days: int = 90,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.ftd(ticker, days, page, per_page))

    async def reg_sho(
        self,
        symbol: str | None = None,
        min_consecutive_days: int | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.reg_sho(symbol, min_consecutive_days, page, per_page))


class AsyncMacro(_AsyncResource):
    async def treasury_yields(
        self,
        days: int = 30,
        from_: str | None = None,
        to: str | None = None,
    ) -> ApiResult:
        return await self._get(*ep.treasury_yields(days, from_, to))

    async def fed_rates(self, days: int = 365, series: str | None = None) -> ApiResult:
        return await self._get(*ep.fed_rates(days, series))

    async def economic_indicators(
        self,
        category: str | None = None,
        series_id: str | None = None,
        days: int = 365,
        page: int = 1,
        per_page: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.economic_indicators(category, series_id, days, page, per_page))

    async def financial_stress(
        self, days: int = 365, series_name: str | None = None
    ) -> ApiResult:
        return await self._get(*ep.financial_stress(days, series_name))


class AsyncFilings(_AsyncResource):
    async def list(
        self,
        cik: str,
        form: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int = 50,
    ) -> ApiResult:
        return await self._get(*ep.filings_list(cik, form, from_, to, limit))

    async def index(self, cik: str, accession: str) -> ApiResult:
        return await self._get(*ep.filings_index(cik, accession))

    async def share(self, cik: str, accession: str, file: str | None = None) -> ApiResult:
        return await self._get(*ep.filings_share(cik, accession, file))
