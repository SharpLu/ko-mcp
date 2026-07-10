from __future__ import annotations

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
