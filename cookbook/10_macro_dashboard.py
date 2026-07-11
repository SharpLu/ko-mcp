"""A one-screen macro dashboard: yield curve, Fed rates, stress index.

Requires a Pro plan or higher (https://ko.io/pricing) — macro endpoints are
not in the free tier. With a free/demo key this prints a friendly notice
instead of crashing.

    KO_API_KEY=ko_live_... python cookbook/10_macro_dashboard.py
"""

from ko_edgar import KoClient, PlanRequiredError


def main() -> None:
    ko = KoClient()

    try:
        yields = ko.macro.treasury_yields(days=5)
    except PlanRequiredError:
        print("Macro endpoints require a Pro plan ($29/mo) → https://ko.io/pricing")
        print("Everything else in this cookbook runs on the free tier.")
        return

    print("=== Treasury yield curve (latest) ===\n")
    latest = yields.rows[0] if yields.rows else {}
    for tenor in ("1m", "3m", "6m", "1y", "2y", "5y", "10y", "30y"):
        key = f"yield_{tenor}" if f"yield_{tenor}" in latest else tenor
        if key in latest:
            print(f"  {tenor:>3}: {latest[key]}%")

    print("\n=== Fed policy rates (last year) ===\n")
    for row in ko.macro.fed_rates(days=365).rows[:5]:
        print(f"  {row.get('date', '?')}: {row.get('rate') or row.get('value')}")

    print("\n=== OFR Financial Stress Index ===\n")
    for row in ko.macro.financial_stress(days=30).rows[:5]:
        print(f"  {row.get('date', '?')}: {row.get('value')}")


if __name__ == "__main__":
    main()
