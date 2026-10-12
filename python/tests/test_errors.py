from __future__ import annotations

import pytest

from ko_edgar import (
    AuthenticationError,
    BadRequestError,
    KoError,
    NotFoundError,
    PlanRequiredError,
    RateLimitError,
    ServerError,
)

from .conftest import json_response


def error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


@pytest.mark.parametrize(
    ("status", "code", "exc"),
    [
        (400, "BAD_REQUEST", BadRequestError),
        (401, "INVALID_API_KEY", AuthenticationError),
        (403, "PLAN_REQUIRED", PlanRequiredError),
        (404, "NOT_FOUND", NotFoundError),
        (500, "INTERNAL_ERROR", ServerError),
    ],
)
def test_status_maps_to_exception(make_client, status, code, exc) -> None:
    client, _ = make_client([json_response(error_body(code, "boom"), status=status)])
    with pytest.raises(exc) as info:
        client.search("x")
    assert info.value.status == status
    assert info.value.code == code
    assert "boom" in str(info.value)


def test_rate_limit_carries_retry_after(make_client) -> None:
    client, _ = make_client(
        [
            json_response(
                error_body("RATE_LIMIT_EXCEEDED", "quota"),
                status=429,
                headers={"Retry-After": "3600"},
            )
        ]
    )
    with pytest.raises(RateLimitError) as info:
        client.search("x")
    assert info.value.retry_after == 3600


def test_non_json_error_body_still_raises(make_client) -> None:
    import httpx

    client, _ = make_client([httpx.Response(404, content=b"not found")])
    with pytest.raises(NotFoundError):
        client.search("x")


def test_flat_docs_style_error_shape(make_client) -> None:
    client, _ = make_client(
        [json_response({"error": "Unauthorized", "message": "bad key", "status": 401}, status=401)]
    )
    with pytest.raises(AuthenticationError) as info:
        client.search("x")
    assert info.value.code == "Unauthorized"
    assert info.value.message == "bad key"


def test_missing_data_key_raises_ko_error(make_client) -> None:
    client, _ = make_client([json_response({"unexpected": True})])
    with pytest.raises(KoError) as info:
        client.search("x")
    assert info.value.code == "INVALID_RESPONSE"


def test_error_details_object_is_exposed(make_client) -> None:
    body = {
        "error": {
            "code": "COUNTRY_NOT_COVERED",
            "message": "fr is not covered",
            "details": {"covered": ["se", "nl", "dk", "uk"]},
        }
    }
    client, _ = make_client([json_response(body, status=404)])
    with pytest.raises(NotFoundError) as info:
        client.eu.insider_dealings("fr")
    assert info.value.code == "COUNTRY_NOT_COVERED"
    assert info.value.details == {"covered": ["se", "nl", "dk", "uk"]}


def test_error_details_on_rate_limit(make_client) -> None:
    body = {"error": {"code": "RATE_LIMIT_EXCEEDED", "message": "q", "details": {"limit": 200}}}
    client, _ = make_client([json_response(body, status=429, headers={"Retry-After": "5"})])
    with pytest.raises(RateLimitError) as info:
        client.search("x")
    assert info.value.details == {"limit": 200}
    assert info.value.retry_after == 5


@pytest.mark.parametrize(
    "body",
    [
        {"error": {"code": "NOT_FOUND", "message": "nope"}},
        {"error": {"code": "NOT_FOUND", "message": "nope", "details": ["x"]}},
        {"error": {"code": "NOT_FOUND", "message": "nope", "details": "x"}},
        {"error": "NOT_FOUND", "message": "flat shape"},
    ],
)
def test_error_details_none_when_absent_or_not_an_object(make_client, body) -> None:
    client, _ = make_client([json_response(body, status=404)])
    with pytest.raises(NotFoundError) as info:
        client.search("x")
    assert info.value.details is None


async def test_async_error_details_object_is_exposed(make_async_client) -> None:
    body = {
        "error": {
            "code": "DATASET_NOT_LIVE",
            "message": "pending",
            "details": {"status": "pending"},
        }
    }
    client, _ = make_async_client([json_response(body, status=404)])
    with pytest.raises(NotFoundError) as info:
        await client.eu.insider_dealings("se")
    assert info.value.details == {"status": "pending"}
