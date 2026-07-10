"""What did top hedge funds open NEW positions in last quarter?

New positions are the highest-signal rows in a 13F: a manager deploying
fresh capital into a name they didn't own. This sweeps several
well-followed funds and collects their newest buys.

    python cookbook/09_smart_money_new_positions.py
"""

from ko_sec import KoClient

FUNDS = {
    "1067983": "Berkshire Hathaway",
    "1350694": "Bridgewater Associates",
    "1179392": "Pershing Square",
    "1336528": "Appaloosa",
}


def main() -> None:
    ko = KoClient()

    print("=== Fresh capital: NEW positions, latest quarter ===\n")
    for cik, label in FUNDS.items():
        try:
            new_rows = ko.institutions.holdings(cik, action="NEW_POSITION", per_page=8)
        except Exception as exc:  # noqa: BLE001 — keep sweeping other funds
            print(f"  {label}: skipped ({exc})")
            continue
        if not new_rows:
            print(f"  {label}: no new positions")
            continue
        print(f"  {label}:")
        for h in new_rows:
            value = float(h.get("holding_value") or 0)
            print(f"    + {h.get('ticker', '?'):<8} ${value / 1e6:>9.1f}M")
        print()

    print("Tip: action also accepts ADDED / TRIMMED / CLEARED / UNCHANGED.")


if __name__ == "__main__":
    main()
