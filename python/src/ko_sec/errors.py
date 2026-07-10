"""Exception hierarchy for the ko.io API.

All API failures raise a subclass of :class:`KoError` carrying the HTTP
status, the stable machine-readable ``code`` returned by the API
(e.g. ``PLAN_REQUIRED``), and the human-readable message.
"""

from __future__ import annotations


class KoError(Exception):
    """Base class for all ko.io API errors."""

    def __init__(self, message: str, *, status: int = 0, code: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code

    def __str__(self) -> str:
        if self.status:
            return f"[{self.status} {self.code}] {self.message}"
        return self.message


class BadRequestError(KoError):
    """400 — invalid parameters (e.g. malformed quarter date)."""


class AuthenticationError(KoError):
    """401 — missing, invalid, or revoked API key.

    Get a free key (200 calls/day, no credit card) at https://ko.io/console.
    """


class PlanRequiredError(KoError):
    """403 — endpoint requires a higher plan.

    Macro, short-interest and bulk endpoints require Pro or above.
    See https://ko.io/pricing.
    """


class NotFoundError(KoError):
    """404 — unknown ticker, CIK, slug, or route."""


class RateLimitError(KoError):
    """429 — daily quota exhausted (resets at 00:00 UTC).

    ``retry_after`` holds the server-suggested wait in seconds, if provided.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int = 429,
        code: str = "RATE_LIMIT_EXCEEDED",
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message, status=status, code=code)
        self.retry_after = retry_after


class ServerError(KoError):
    """5xx — transient upstream or server failure. Safe to retry."""


_STATUS_MAP = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PlanRequiredError,
    404: NotFoundError,
    429: RateLimitError,
}


def error_for_status(
    status: int,
    code: str,
    message: str,
    retry_after: int | None = None,
) -> KoError:
    """Build the appropriate :class:`KoError` subclass for an HTTP status."""
    if status == 429:
        return RateLimitError(message, code=code or "RATE_LIMIT_EXCEEDED", retry_after=retry_after)
    cls = _STATUS_MAP.get(status)
    if cls is not None:
        return cls(message, status=status, code=code)
    if status >= 500:
        return ServerError(message, status=status, code=code)
    return KoError(message, status=status, code=code)
