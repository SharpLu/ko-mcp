"""ko-sec — official Python SDK for the ko.io financial data API.

Source-traced SEC & market data for AI agents and quants: 13F institutional
holdings, insider trades, Congress trading, crypto ETF exposure, macro
indicators, and the EDGAR filings gateway.

Quickstart (keyless demo mode)::

    from ko_sec import KoClient

    ko = KoClient()
    for inst in ko.institutions.list(search="berkshire"):
        print(inst["name"], inst["portfolio_value"])

Docs: https://ko.io/docs · Free API key: https://ko.io/console
"""

from ._version import __version__
from .client import AsyncKoClient, KoClient
from .errors import (
    AuthenticationError,
    BadRequestError,
    KoError,
    NotFoundError,
    PlanRequiredError,
    RateLimitError,
    ServerError,
)
from .pagination import paginate
from .result import ApiResult

__all__ = [
    "__version__",
    "KoClient",
    "AsyncKoClient",
    "ApiResult",
    "paginate",
    "KoError",
    "AuthenticationError",
    "BadRequestError",
    "NotFoundError",
    "PlanRequiredError",
    "RateLimitError",
    "ServerError",
]
