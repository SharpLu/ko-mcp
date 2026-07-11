"""Form 144 — insider sales announced before they happen.

Form 144 must be filed when an insider *intends* to sell restricted stock,
making it a forward-looking signal (unlike Form 4, which reports after the
trade). This lists recent notices for a ticker.

    python cookbook/06_form144_planned_sales.py [TICKER]
"""

import sys

from ko_edgar import KoClient


def main() -> None:
    ticker = (sys.argv[1] if len(sys.argv) > 1 else "TSLA").upper()
    ko = KoClient()

    print(f"=== Recent Form 144 notices for {ticker} ===\n")
    notices = ko.form144.list(ticker=ticker, per_page=15)
    if not notices:
        print("  None found — try another ticker (e.g. NVDA, META).")
        return

    for n in notices:
        units = float(n.get("num_units_to_sell") or 0)
        value = float(n.get("aggregate_market_value") or 0)
        plan = " (10b5-1 plan)" if n.get("has_10b5_1_plan") else ""
        print(
            f"  {n.get('filed_date', '?')}  {n.get('seller_name', '?'):<32} "
            f"{units:>12,.0f} sh  ${value / 1e6:>8.2f}M{plan}"
        )

    print("\nCross-check against completed sales:")
    print(f'  ko.insiders.trades(ticker="{ticker}", per_page=20)')


if __name__ == "__main__":
    main()
