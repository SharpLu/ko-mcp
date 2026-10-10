from __future__ import annotations

import inspect

import httpx
import pytest

from ko_edgar import AsyncGovContracts, AsyncKoClient, GovContracts, KoClient

CASES = [
    ("company", ("ba",), {"fiscal_year": 2026, "agency": "097", "sub_agency": "2100"}, "/BA"),
    (
        "transactions", ("BA",),
        {"award_id": "CONT_AWD_X", "page": 2, "per_page": 200}, "/BA/transactions",
    ),
    (
        "search", (),
        {"from_": "2026-01-01", "to": "2026-02-01", "min_amount": "1.50", "facets": "agency"}, "",
    ),
    ("companies", (), {"ticker": "BA,LMT", "sort": "gross", "period": "1Q"}, "/companies"),
    ("coverage", (), {}, "/coverage"),
]


@pytest.mark.parametrize("method,args,kwargs,suffix", CASES)
async def test_sync_async_wire_parity(method, args, kwargs, suffix):
    requests = []
    amounts = ["0.00", "1.50", "-1250000.00", "123456789012345678901234567890.10"]
    body = {
        "data": [{"obligated_amount": v} for v in amounts],
        "meta": {"scope": "award", "identity": {"cik": "0000012927"}},
    }

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json=body)

    transport = httpx.MockTransport(handle)
    with KoClient(api_key="ko_test", transport=transport) as ko:
        sync = getattr(ko.gov_contracts, method)(*args, **kwargs)
    async with AsyncKoClient(api_key="ko_test", transport=transport) as ko:
        async_result = await getattr(ko.gov_contracts, method)(*args, **kwargs)
    assert sync.data == async_result.data == body["data"]
    assert sync.meta == async_result.meta == body["meta"]
    assert requests[0].url == requests[1].url
    assert requests[0].url.path == "/api/v1/gov-contracts" + suffix
    for key, value in kwargs.items():
        assert requests[0].url.params["from" if key == "from_" else key] == str(value)
    assert "period" not in requests[0].url.params or "period" in kwargs
    assert inspect.signature(getattr(GovContracts, method)) == inspect.signature(
        getattr(AsyncGovContracts, method)
    )


async def test_empty_award_metadata_survives_both_clients():
    body = {
        "data": [],
        "meta": {
            "identity": {"cik": "0000012927", "company_name": "BOEING", "issuer_tickers": ["BA"]},
            "scope": "award", "refreshed_at": None, "caveats": ["listed_today_survivorship"],
        },
    }
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=body))
    with KoClient(transport=transport) as ko:
        result = ko.gov_contracts.transactions("BA", award_id="CONT_AWD_X")
        assert result.data == []
        assert result.meta == body["meta"]
    async with AsyncKoClient(transport=transport) as ko:
        result = await ko.gov_contracts.transactions("BA", award_id="CONT_AWD_X")
        assert result.data == []
        assert result.meta == body["meta"]
