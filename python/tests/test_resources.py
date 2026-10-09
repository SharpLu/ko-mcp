from __future__ import annotations

import pytest

from .conftest import envelope, json_response


def _request_for(make_client, call):
    client, handler = make_client([json_response(envelope([]))], api_key="ko_live_t")
    call(client)
    return handler.requests[0]


def test_institution_holdings_params(make_client) -> None:
    request = _request_for(
        make_client,
        lambda ko: ko.institutions.holdings(
            "1067983", quarter="2026-03-31", action="NEW_POSITION", per_page=100
        ),
    )
    assert request.url.path == "/api/v1/holdings/1067983"
    params = request.url.params
    assert params["quarter"] == "2026-03-31"
    assert params["action"] == "NEW_POSITION"
    assert params["per_page"] == "100"


def test_institution_quarters_uses_type_param(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.institutions.quarters("1067983"))
    assert request.url.params["type"] == "quarters"


def test_ticker_uppercased_across_stock_routes(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.stocks.price("nvda", days=30))
    assert request.url.path == "/api/v1/stock-price/NVDA"


def test_stock_activity_route(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.stocks.activity("nvda", quarters=12))
    assert request.url.path == "/api/v1/stock-holders/NVDA"
    assert request.url.params["type"] == "activity"
    assert request.url.params["quarters"] == "12"


def test_congress_trades_filters(make_client) -> None:
    request = _request_for(
        make_client,
        lambda ko: ko.congress.trades(ticker="NVDA", chamber="senate", sort="volume"),
    )
    assert request.url.path == "/api/v1/congress-trades"
    assert request.url.params["chamber"] == "senate"
    assert "party" not in request.url.params


def test_congress_trades_has_no_party_argument(make_client) -> None:
    # The API has no party filter; the old argument was sent and silently ignored.
    import inspect

    from ko_edgar.aresources import AsyncCongress
    from ko_edgar.resources import Congress

    assert "party" not in inspect.signature(Congress.trades).parameters
    assert "party" not in inspect.signature(AsyncCongress.trades).parameters
    client, _ = make_client([json_response(envelope([]))])
    with pytest.raises(TypeError):
        client.congress.trades(party="D")


def test_financial_stress_paginates(make_client) -> None:
    request = _request_for(
        make_client,
        lambda ko: ko.macro.financial_stress(days=30, series_name="OFR FSI", page=2, per_page=200),
    )
    assert request.url.path == "/api/v1/stress/ofr"
    params = request.url.params
    assert params["days"] == "30"
    assert params["series_name"] == "OFR FSI"
    assert params["page"] == "2"
    assert params["per_page"] == "200"


def test_financial_stress_works_with_paginate(make_client) -> None:
    from ko_edgar import paginate

    client, handler = make_client(
        [
            json_response(envelope([{"d": 1}, {"d": 2}], {"total_count": 3, "per_page": 2})),
            json_response(envelope([{"d": 3}], {"total_count": 3, "per_page": 2})),
        ],
        api_key="ko_live_t",
    )
    rows = list(paginate(client.macro.financial_stress, days=30, per_page=2))
    assert rows == [{"d": 1}, {"d": 2}, {"d": 3}]
    assert [r.url.params["page"] for r in handler.requests] == ["1", "2"]


async def test_async_financial_stress_paginates(make_async_client) -> None:
    client, handler = make_async_client([json_response(envelope([]))], api_key="ko_live_t")
    await client.macro.financial_stress(days=30, page=4, per_page=10)
    params = handler.requests[0].url.params
    assert handler.requests[0].url.path == "/api/v1/stress/ofr"
    assert params["page"] == "4"
    assert params["per_page"] == "10"
    await client.close()


def test_macro_treasury_yields_route(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.macro.treasury_yields(days=90))
    assert request.url.path == "/api/v1/treasury/yields"
    assert request.url.params["days"] == "90"


def test_filings_list_route(make_client) -> None:
    request = _request_for(
        make_client, lambda ko: ko.filings.list("320193", form="10-K", limit=10)
    )
    assert request.url.path == "/api/v1/filings/320193"
    assert request.url.params["form"] == "10-K"


def test_crypto_and_form144_and_short_routes(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.crypto.holders(product="IBIT"))
    assert request.url.path == "/api/v1/crypto/institutional-holders"

    request = _request_for(make_client, lambda ko: ko.form144.list(ticker="TSLA"))
    assert request.url.path == "/api/v1/form144-notices"

    request = _request_for(make_client, lambda ko: ko.short.ftd(ticker="GME", days=180))
    assert request.url.path == "/api/v1/sec/ftd"

    request = _request_for(make_client, lambda ko: ko.short.reg_sho(symbol="GME"))
    assert request.url.path == "/api/v1/reg-sho-threshold"


def test_search_query_param(make_client) -> None:
    request = _request_for(make_client, lambda ko: ko.search("warren", limit=3))
    assert request.url.path == "/api/v1/search"
    assert request.url.params["q"] == "warren"
    assert request.url.params["limit"] == "3"
