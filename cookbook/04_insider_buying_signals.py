"""Insider cluster buys — the strongest Form 4 signal.

One executive buying can be noise. Several insiders at the same company
buying in the same window is one of the best-documented bullish signals.
This scans recent insider activity and surfaces companies with multiple
distinct open-market buyers.

    python cookbook/04_insider_buying_signals.py
"""

from collections import defaultdict

from ko_sec import KoClient


def main() -> None:
    ko = KoClient()

    rows = ko.insiders.trades(per_page=200)

    buyers_by_ticker: defaultdict = defaultdict(set)
    for t in rows:
        bought = float(t.get("om_value_bought") or 0) + float(t.get("stock_value_bought") or 0)
        if bought <= 0:
            continue
        ticker = t.get("ticker")
        insider = t.get("person_name")
        if ticker and insider:
            buyers_by_ticker[ticker].add(insider)

    clusters = {t: names for t, names in buyers_by_ticker.items() if len(names) >= 2}

    print("=== Companies with 2+ distinct insider buyers (recent window) ===\n")
    if not clusters:
        print("  No clusters in this window. Single buyers:")
        singles = sorted(buyers_by_ticker.items(), key=lambda kv: kv[0])[:10]
        for ticker, names in singles:
            print(f"  {ticker:<8} {next(iter(names))}")
    for ticker, names in sorted(clusters.items(), key=lambda kv: -len(kv[1])):
        print(f"  {ticker:<8} {len(names)} buyers: {', '.join(sorted(names)[:4])}")

    print("\nVerify any name against the primary filing:")
    print('  ko.insiders.transactions("<insider CIK>", side="BUY")')


if __name__ == "__main__":
    main()
