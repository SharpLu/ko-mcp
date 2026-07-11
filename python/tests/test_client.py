from __future__ import annotations

import httpx
import pytest

from ko_edgar import KoClient

from .conftest import envelope, json_response


def test_demo_mode_appends_demo_param(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))])
    assert client.demo_mode
    client.search("berkshire")
    request = handler.requests[0]
    assert request.url.params["demo"] == "true"
    assert "Authorization" not in request.headers


def test_api_key_sets_bearer_header_and_skips_demo(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))], api_key="ko_live_abc")
    assert not client.demo_mode
    client.search("berkshire")
    request = handler.requests[0]
    assert request.headers["Authorization"] == "Bearer ko_live_abc"
    assert "demo" not in request.url.params


def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KO_API_KEY", "ko_live_env")
    client = KoClient(transport=httpx.MockTransport(lambda r: json_response(envelope([]))))
    assert not client.demo_mode


def test_base_url_from_env(monkeypatch: pytest.MonkeyPatch, make_client) -> None:
    monkeypatch.setenv("KO_API_URL", "https://staging.example.com/")
    client, handler = make_client([json_response(envelope([]))])
    client.search("x")
    assert str(handler.requests[0].url).startswith("https://staging.example.com/api/v1/search")


def test_user_agent_header(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))])
    client.search("x")
    assert handler.requests[0].headers["User-Agent"].startswith("ko-edgar-python/")


def test_none_params_dropped_and_bools_serialized(make_client) -> None:
    client, handler = make_client([json_response(envelope([]))])
    client.get("/api/v1/stocks", search=None, active=True)
    params = handler.requests[0].url.params
    assert "search" not in params
    assert params["active"] == "true"


def test_context_manager_closes() -> None:
    with KoClient(transport=httpx.MockTransport(lambda r: json_response(envelope([])))) as ko:
        ko.search("x")
    assert ko._http.is_closed


async def test_async_client_mirrors_sync(make_async_client) -> None:
    client, handler = make_async_client(
        [json_response(envelope([{"ticker": "NVDA"}]))], api_key="ko_live_abc"
    )
    result = await client.stocks.holders("nvda")
    assert result.rows == [{"ticker": "NVDA"}]
    assert handler.requests[0].url.path == "/api/v1/stock-holders/NVDA"
    await client.close()
