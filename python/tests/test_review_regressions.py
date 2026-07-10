"""Regression tests for the 2026-07-10 adversarial review findings."""

from __future__ import annotations

import httpx
import pytest

from ko_sec import AuthenticationError, KoClient, RateLimitError, paginate
from ko_sec.result import ApiResult

from .conftest import envelope, json_response

# -- Finding 1: rows normalization for alternate list keys --------------------


def test_rows_unwraps_single_list_field_holders() -> None:
    data = {"product": "IBIT", "page": 1, "total_count": 1456, "holders": [{"cik": "1"}]}
    assert ApiResult(data, {}).rows == [{"cik": "1"}]


def test_rows_unwraps_single_list_field_trend() -> None:
    data = {"ticker": "NVDA", "summary": {}, "trend": [{"quarter": "2026-03-31"}]}
    assert ApiResult(data, {}).rows == [{"quarter": "2026-03-31"}]


def test_rows_multi_list_object_stays_single_row() -> None:
    # financials/historical has quarterly + annual → ambiguous, keep object
    data = {"quarterly": [1], "annual": [2]}
    assert ApiResult(data, {}).rows == [data]


def test_rows_data_key_still_wins() -> None:
    data = {"data": [{"a": 1}], "holders": [{"b": 2}]}
    assert ApiResult(data, {}).rows == [{"a": 1}]


# -- Finding 2: paginate vs server-capped per_page -----------------------------


def test_paginate_honors_server_capped_per_page() -> None:
    pages = {1: [1, 2], 2: [3, 4], 3: [5]}

    def method(*args, page=1, per_page=100, **kwargs):
        rows = pages.get(page, [])
        return ApiResult(rows, {"per_page": 2, "page": page})  # server caps at 2

    assert list(paginate(method, per_page=1000)) == [1, 2, 3, 4, 5]


def test_paginate_infers_page_size_without_meta() -> None:
    pages = {1: [1, 2, 3], 2: [4]}

    def method(*args, page=1, per_page=100, **kwargs):
        return ApiResult(pages.get(page, []), {})

    assert list(paginate(method, per_page=1000)) == [1, 2, 3, 4]


def test_paginate_stops_when_endpoint_ignores_page() -> None:
    def method(*args, page=1, per_page=2, **kwargs):
        return ApiResult([{"id": 1}, {"id": 2}], {"per_page": 2})

    rows = list(paginate(method, per_page=2, max_pages=50))
    assert len(rows) == 2  # one page, then the repeat is detected


# -- Finding 3: non-dict JSON error bodies --------------------------------------


def test_error_body_json_array_still_maps_to_ko_error(make_client) -> None:
    client, _ = make_client([json_response(["bad request"], status=401)])
    with pytest.raises(AuthenticationError):
        client.search("x")


def test_error_body_json_string_still_maps(make_client) -> None:
    import json as _json

    client, _ = make_client(
        [httpx.Response(429, content=_json.dumps("slow down").encode(),
                        headers={"content-type": "application/json"})]
    )
    with pytest.raises(RateLimitError):
        client.search("x")


# -- Finding 4: empty api_key normalization ---------------------------------------


def test_empty_api_key_is_demo_mode(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))], api_key="")
    assert client.demo_mode
    client.search("x")
    request = handler.requests[0]
    assert request.url.params["demo"] == "true"
    assert "Authorization" not in request.headers


def test_empty_env_key_is_demo_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KO_API_KEY", "")
    client = KoClient(transport=httpx.MockTransport(lambda r: json_response(envelope([]))))
    assert client.demo_mode


# -- Findings 5/6: total_count fallbacks ---------------------------------------------


def test_total_count_from_data_level() -> None:
    assert ApiResult({"totalCount": 5499, "data": []}, {}).total_count == 5499
    assert ApiResult({"total_count": 7, "holders": []}, {}).total_count == 7


def test_total_count_null_falls_back() -> None:
    assert ApiResult([], {"total_count": None, "total_available": 99}).total_count == 99


# -- Finding 10: path segment escaping ------------------------------------------------


def test_path_params_url_escaped(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))], api_key="ko_live_t")
    client.institutions.get("103/../../etc")
    assert "/api/v1/institutions/103%2F..%2F..%2Fetc" in str(handler.requests[0].url)


# -- Finding 12: list params serialize as comma-join -----------------------------------


def test_list_param_serialization(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))], api_key="ko_live_t")
    client.get("/api/v1/stocks", tickers=["AAPL", "MSFT"])
    assert handler.requests[0].url.params["tickers"] == "AAPL,MSFT"


# -- Finding 14: async retry coverage ----------------------------------------------------


async def test_async_retries_503_then_succeeds(make_async_client, monkeypatch) -> None:
    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr("asyncio.sleep", no_sleep)
    client, handler = make_async_client(
        [
            json_response({"error": {"code": "SERVICE_UNAVAILABLE", "message": "x"}}, status=503),
            json_response(envelope([{"ok": 1}])),
        ]
    )
    result = await client.search("x")
    assert result.rows == [{"ok": 1}]
    assert len(handler.requests) == 2
    await client.close()
