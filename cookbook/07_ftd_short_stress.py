"""Settlement-stress check: fails-to-deliver + Reg SHO threshold list.

Read the FTD numbers for what they are. Each SEC fails-to-deliver quantity is
the aggregate BALANCE of shares still undelivered on that settlement date --
not the fails that arose that day -- so balances carry over and must never be
summed across dates. Fails have many causes (processing delays, long sales,
market-maker activity); FTDs on their own are not evidence of naked short
selling. A persistently high balance plus a spot on the Reg SHO threshold list
is a sign of settlement stress worth reading the filings behind.

    python cookbook/07_ftd_short_stress.py [TICKER]
"""

import sys

from ko_edgar import KoClient


def main() -> None:
    ticker = (sys.argv[1] if len(sys.argv) > 1 else "GME").upper()
    ko = KoClient()

    print(f"=== Fails-to-deliver for {ticker} (last 90 days) ===\n")
    ftds = ko.short.ftd(ticker=ticker, days=90, per_page=10)
    if not ftds:
        print("  No FTD records in this window.")
    for row in ftds:
        date = row.get("settlement_date") or row.get("date", "?")
        qty = float(row.get("quantity") or row.get("ftd_shares") or 0)
        price = row.get("price", "")
        print(f"  {date}  {qty:>12,.0f} shares outstanding (fail balance)  @ {price}")

    if ftds:
        print("  (balances, not daily new fails -- compare levels, never sum across dates)")

    print(f"\n=== Reg SHO threshold list appearances for {ticker} ===\n")
    threshold = ko.short.reg_sho(symbol=ticker, per_page=10)
    if not threshold:
        print("  Not currently on the threshold list.")
    for row in threshold:
        print(
            f"  {row.get('trade_date', '?')}  "
            f"consecutive days on list: {row.get('consecutive_days_on_list', '?')}"
        )


if __name__ == "__main__":
    main()
