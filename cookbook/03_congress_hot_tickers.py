"""What is Congress trading?

STOCK Act disclosures reveal what US senators and representatives buy and
sell. This ranks the most-traded tickers by Congress members recently and
shows who is behind the volume.

    python cookbook/03_congress_hot_tickers.py
"""

from collections import Counter, defaultdict

from ko_sec import KoClient


def main() -> None:
    ko = KoClient()

    trades = ko.congress.trades(sort="recent", per_page=100)

    by_ticker: Counter = Counter()
    members: defaultdict = defaultdict(set)
    for t in trades:
        ticker = t.get("ticker")
        if not ticker:
            continue
        by_ticker[ticker] += 1
        member = t.get("member_name") or t.get("name")
        if member:
            members[ticker].add(member)

    print("=== Hottest tickers in recent Congress trades ===\n")
    for ticker, count in by_ticker.most_common(10):
        names = ", ".join(sorted(members[ticker])[:3])
        more = len(members[ticker]) - 3
        suffix = f" +{more} more" if more > 0 else ""
        print(f"  {ticker:<8} {count:>3} trades  ({names}{suffix})")

    print("\nDrill into one member, e.g.:")
    print('  ko.congress.member("nancy-pelosi")')


if __name__ == "__main__":
    main()
