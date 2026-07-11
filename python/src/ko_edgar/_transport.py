"""HTTP transport shared by the sync and async clients."""

from __future__ import annotations

import os
import time
from collections.abc import Mapping
from typing import Any

import httpx

from ._version import __version__
from .errors import KoError, error_for_status
from .result import ApiResult

DEFAULT_BASE_URL = "https://api.ko.io"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2
_RETRYABLE_STATUSES = frozenset({502, 503, 504})
_USER_AGENT = f"ko-edgar-python/{__version__}"


def resolve_config(
    api_key: str | None,
    base_url: str | None,
) -> tuple[str | None, str]:
    """Resolve key and base URL from arguments, falling back to env vars."""
    key = api_key if api_key is not None else os.environ.get("KO_API_KEY")
    url = (base_url or os.environ.get("KO_API_URL") or DEFAULT_BASE_URL).rstrip("/")
    return key or None, url


def build_headers(api_key: str | None) -> dict[str, str]:
    headers = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def prepare_params(api_key: str | None, params: Mapping[str, Any]) -> dict[str, str]:
    """Serialize query params: drop Nones, stringify booleans, add demo mode."""
    prepared: dict[str, str] = {}
    for name, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            prepared[name] = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            prepared[name] = ",".join(str(item) for item in value)
        else:
            prepared[name] = str(value)
    if not api_key:
        # Keyless demo mode (rate-limited). Free keys: https://ko.io/console
        prepared["demo"] = "true"
    return prepared


def parse_response(response: httpx.Response) -> ApiResult:
    """Parse a `{data, meta}` envelope or raise the mapped KoError."""
    if response.status_code >= 400:
        code, message = "", f"HTTP {response.status_code}"
        try:
            body = response.json()
            if isinstance(body, dict):
                error = body.get("error")
                if isinstance(error, dict):
                    code = str(error.get("code", ""))
                    message = str(error.get("message", message))
                elif isinstance(error, str):  # docs-style flat error shape
                    code = error
                    message = str(body.get("message", message))
        except ValueError:
            pass
        retry_after: int | None = None
        raw_retry = response.headers.get("Retry-After")
        if raw_retry and raw_retry.isdigit():
            retry_after = int(raw_retry)
        raise error_for_status(response.status_code, code, message, retry_after)

    try:
        body = response.json()
    except ValueError as exc:
        raise KoError(
            "Invalid JSON in API response", status=response.status_code, code="INVALID_RESPONSE"
        ) from exc
    if not isinstance(body, dict) or "data" not in body:
        raise KoError(
            "Unexpected response shape (missing 'data')",
            status=response.status_code,
            code="INVALID_RESPONSE",
        )
    meta = body.get("meta")
    return ApiResult(body["data"], meta if isinstance(meta, dict) else {})


def should_retry(attempt: int, max_retries: int, status: int | None) -> bool:
    """Retry connection failures and transient 5xx, never 4xx."""
    if attempt >= max_retries:
        return False
    return status is None or status in _RETRYABLE_STATUSES


def backoff_seconds(attempt: int) -> float:
    return 0.25 * float(2**attempt)


def request_sync(
    http: httpx.Client,
    api_key: str | None,
    path: str,
    params: Mapping[str, Any],
    max_retries: int,
) -> ApiResult:
    attempt = 0
    prepared = prepare_params(api_key, params)
    while True:
        status: int | None = None
        try:
            response = http.get(path, params=prepared)
            status = response.status_code
            if status not in _RETRYABLE_STATUSES:
                return parse_response(response)
        except httpx.TransportError:
            if not should_retry(attempt, max_retries, None):
                raise
        if not should_retry(attempt, max_retries, status):
            return parse_response(response)
        time.sleep(backoff_seconds(attempt))
        attempt += 1


async def request_async(
    http: httpx.AsyncClient,
    api_key: str | None,
    path: str,
    params: Mapping[str, Any],
    max_retries: int,
) -> ApiResult:
    import asyncio

    attempt = 0
    prepared = prepare_params(api_key, params)
    while True:
        status: int | None = None
        try:
            response = await http.get(path, params=prepared)
            status = response.status_code
            if status not in _RETRYABLE_STATUSES:
                return parse_response(response)
        except httpx.TransportError:
            if not should_retry(attempt, max_retries, None):
                raise
        if not should_retry(attempt, max_retries, status):
            return parse_response(response)
        await asyncio.sleep(backoff_seconds(attempt))
        attempt += 1
