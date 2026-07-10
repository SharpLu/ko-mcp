from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

Handler = Callable[[httpx.Request], httpx.Response]


def envelope(data: Any, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"data": data, "meta": meta or {}}


def json_response(
    payload: dict[str, Any] | list[Any],
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps(payload).encode(),
        headers={"content-type": "application/json", **(headers or {})},
    )


class RecordingHandler:
    """MockTransport handler that records requests and replays responses."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        index = min(len(self.requests) - 1, len(self.responses) - 1)
        return self.responses[index]


@pytest.fixture
def make_client() -> Callable[..., Any]:
    from ko_sec import KoClient

    def factory(responses: list[httpx.Response], api_key: str | None = None, **kwargs: Any):
        handler = RecordingHandler(responses)
        client = KoClient(
            api_key=api_key, transport=httpx.MockTransport(handler), **kwargs
        )
        return client, handler

    return factory


@pytest.fixture
def make_async_client() -> Callable[..., Any]:
    from ko_sec import AsyncKoClient

    def factory(responses: list[httpx.Response], api_key: str | None = None, **kwargs: Any):
        handler = RecordingHandler(responses)
        client = AsyncKoClient(
            api_key=api_key, transport=httpx.MockTransport(handler), **kwargs
        )
        return client, handler

    return factory


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KO_API_KEY", raising=False)
    monkeypatch.delenv("KO_API_URL", raising=False)
