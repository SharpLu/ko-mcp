"""ko.io API clients.

>>> from ko_sec import KoClient
>>> ko = KoClient()                       # demo mode, no key needed
>>> ko = KoClient(api_key="ko_live_...")  # your plan and quota
>>> for holding in ko.institutions.holdings("1067983"):
...     print(holding["ticker"], holding["value"])
"""

from __future__ import annotations

from collections.abc import Mapping
from types import TracebackType
from typing import Any

import httpx

from ._transport import (
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    build_headers,
    request_async,
    request_sync,
    resolve_config,
)
from .aresources import (
    AsyncCongress,
    AsyncCrypto,
    AsyncFilings,
    AsyncForm144,
    AsyncInsiders,
    AsyncInstitutions,
    AsyncMacro,
    AsyncShort,
    AsyncStocks,
)
from .resources import (
    Congress,
    Crypto,
    Filings,
    Form144,
    Insiders,
    Institutions,
    Macro,
    Short,
    Stocks,
)
from .result import ApiResult


class KoClient:
    """Synchronous client for the ko.io API.

    Args:
        api_key: ``ko_live_...`` key. Defaults to the ``KO_API_KEY``
            environment variable. Without a key the client runs in keyless
            demo mode (rate-limited; free keys at https://ko.io/console).
        base_url: API origin, defaults to ``https://api.ko.io``
            (override with ``KO_API_URL``).
        timeout: per-request timeout in seconds (default 30).
        max_retries: retries for connection errors and 502/503/504
            (default 2). 4xx responses are never retried.
        transport: custom ``httpx`` transport (used by the test suite).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api_key, self._base_url = resolve_config(api_key, base_url)
        self._max_retries = max_retries
        self._http = httpx.Client(
            base_url=self._base_url,
            headers=build_headers(self._api_key),
            timeout=timeout,
            transport=transport,
        )
        self.institutions: Institutions = Institutions(self.get)
        self.stocks: Stocks = Stocks(self.get)
        self.insiders: Insiders = Insiders(self.get)
        self.congress: Congress = Congress(self.get)
        self.crypto: Crypto = Crypto(self.get)
        self.form144: Form144 = Form144(self.get)
        self.short: Short = Short(self.get)
        self.macro: Macro = Macro(self.get)
        self.filings: Filings = Filings(self.get)

    @property
    def demo_mode(self) -> bool:
        """True when running keyless (``demo=true`` is sent automatically)."""
        return self._api_key is None

    def search(self, query: str, limit: int = 5) -> ApiResult:
        """Universal search across institutions, stocks, and Congress members."""
        from . import _endpoints as ep

        return self.get(*ep.search(query, limit))

    def get(self, path: str, params: Mapping[str, Any] | None = None, **kwargs: Any) -> ApiResult:
        """Escape hatch: GET any ``/api/v1/...`` path with raw query params.

        >>> ko.get("/api/v1/exec-compensation", {"ticker": "AAPL"})
        """
        merged = {**(params or {}), **kwargs}
        return request_sync(self._http, self._api_key, path, merged, self._max_retries)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> KoClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class AsyncKoClient:
    """Async twin of :class:`KoClient` — identical surface, awaitable methods.

    >>> async with AsyncKoClient() as ko:
    ...     result = await ko.stocks.holders("NVDA")
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._api_key, self._base_url = resolve_config(api_key, base_url)
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            headers=build_headers(self._api_key),
            timeout=timeout,
            transport=transport,
        )
        self.institutions: AsyncInstitutions = AsyncInstitutions(self.get)
        self.stocks: AsyncStocks = AsyncStocks(self.get)
        self.insiders: AsyncInsiders = AsyncInsiders(self.get)
        self.congress: AsyncCongress = AsyncCongress(self.get)
        self.crypto: AsyncCrypto = AsyncCrypto(self.get)
        self.form144: AsyncForm144 = AsyncForm144(self.get)
        self.short: AsyncShort = AsyncShort(self.get)
        self.macro: AsyncMacro = AsyncMacro(self.get)
        self.filings: AsyncFilings = AsyncFilings(self.get)

    @property
    def demo_mode(self) -> bool:
        return self._api_key is None

    async def search(self, query: str, limit: int = 5) -> ApiResult:
        from . import _endpoints as ep

        return await self.get(*ep.search(query, limit))

    async def get(
        self, path: str, params: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ApiResult:
        merged = {**(params or {}), **kwargs}
        return await request_async(self._http, self._api_key, path, merged, self._max_retries)

    async def close(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncKoClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.close()
