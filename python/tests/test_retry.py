from __future__ import annotations

import httpx
import pytest

from ko_sec import NotFoundError, ServerError

from .conftest import envelope, json_response


def test_retries_503_then_succeeds(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ko_sec._transport.time.sleep", lambda s: None)
    client, handler = make_client(
        [
            json_response({"error": {"code": "SERVICE_UNAVAILABLE", "message": "x"}}, status=503),
            json_response(envelope([{"ok": 1}])),
        ]
    )
    result = client.search("x")
    assert result.rows == [{"ok": 1}]
    assert len(handler.requests) == 2


def test_gives_up_after_max_retries(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ko_sec._transport.time.sleep", lambda s: None)
    error = json_response({"error": {"code": "SERVICE_UNAVAILABLE", "message": "x"}}, status=503)
    client, handler = make_client([error, error, error], max_retries=2)
    with pytest.raises(ServerError):
        client.search("x")
    assert len(handler.requests) == 3  # initial + 2 retries


def test_404_is_not_retried(make_client) -> None:
    client, handler = make_client(
        [json_response({"error": {"code": "NOT_FOUND", "message": "x"}}, status=404)]
    )
    with pytest.raises(NotFoundError):
        client.search("x")
    assert len(handler.requests) == 1


def test_connection_error_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    from ko_sec import KoClient

    monkeypatch.setattr("ko_sec._transport.time.sleep", lambda s: None)
    calls = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("boom", request=request)
        return json_response(envelope([]))

    client = KoClient(transport=httpx.MockTransport(flaky))
    client.search("x")
    assert calls["n"] == 2


def test_connection_error_exhausts_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    from ko_sec import KoClient

    monkeypatch.setattr("ko_sec._transport.time.sleep", lambda s: None)

    def always_fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = KoClient(transport=httpx.MockTransport(always_fail), max_retries=1)
    with pytest.raises(httpx.ConnectError):
        client.search("x")
