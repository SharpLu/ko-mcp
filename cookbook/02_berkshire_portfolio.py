"""What does Berkshire Hathaway hold right now?

Reconstruct Warren Buffett's portfolio from the latest 13F filing:
top positions by value, portfolio weight, and what changed vs the prior
quarter. ko.io consolidates Berkshire's multiple filing entities into one
family-level view, so you see the real portfolio — not fragments.

    python cookbook/02_berkshire_portfolio.py
"""

from ko_sec import KoClient

BERKSHIRE_CIK = "1067983"


def main() -> None:
    ko = KoClient()

    holdings = ko.institutions.holdings(BERKSHIRE_CIK, per_page=15)
    if not holdings:
        print("No holdings returned — check the CIK.")
        return

    first = holdings[0]
    total = float(first.get("total_portfolio_value") or 0)
    print("=== Berkshire Hathaway — latest 13F ===")
    print(f"Portfolio value: ${total / 1e9:.1f}B | quarter: {first.get('quarter_date')}\n")

    print("Top 15 holdings:\n")
    for h in holdings:
        value = float(h.get("holding_value") or 0)
        weight = float(h.get("portfolio_weight_pct") or 0)
        print(
            f"  {h.get('ticker', '?'):<8} ${value / 1e9:>7.2f}B  "
            f"{weight:>5.1f}%  {h.get('action', '')}"
        )

    quarters = ko.institutions.quarters(BERKSHIRE_CIK)
    data = quarters.data if isinstance(quarters.data, dict) else {}
    available = data.get("quarters", [])
    print(f"\nHistory available: {len(available)} quarters (back to 2013).")


if __name__ == "__main__":
    main()
