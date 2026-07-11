"""How much do two funds' portfolios overlap?

Compare any two 13F filers position-by-position: shared names, weights, and
the conviction picks each holds that the other doesn't. Useful for checking
whether "diversifying" across two managers actually diversifies anything.

    python cookbook/08_fund_overlap.py [CIK_A] [CIK_B]

Defaults: Berkshire Hathaway (1067983) vs Bridgewater (1350694).
"""

import sys

from ko_edgar import KoClient


def top_holdings(ko: KoClient, cik: str, n: int = 50) -> dict:
    result = ko.institutions.holdings(cik, per_page=n)
    return {
        h["ticker"]: float(h.get("holding_value") or 0) for h in result if h.get("ticker")
    }


def main() -> None:
    cik_a = sys.argv[1] if len(sys.argv) > 1 else "1067983"
    cik_b = sys.argv[2] if len(sys.argv) > 2 else "1350694"
    ko = KoClient()

    def name_of(cik: str) -> str:
        rows = ko.institutions.get(cik).rows
        return rows[0].get("name", cik) if rows else cik

    name_a = name_of(cik_a)
    name_b = name_of(cik_b)

    a = top_holdings(ko, cik_a)
    b = top_holdings(ko, cik_b)
    shared = sorted(set(a) & set(b), key=lambda t: -(a[t] + b[t]))

    print(f"=== {name_a} vs {name_b} (top-50 positions) ===\n")
    print(f"Shared positions: {len(shared)}\n")
    for ticker in shared[:10]:
        print(f"  {ticker:<8} ${a[ticker] / 1e9:>7.2f}B vs ${b[ticker] / 1e9:>7.2f}B")

    only_a = [t for t in a if t not in b][:5]
    only_b = [t for t in b if t not in a][:5]
    print(f"\nOnly {name_a}: {', '.join(only_a)}")
    print(f"Only {name_b}: {', '.join(only_b)}")


if __name__ == "__main__":
    main()
