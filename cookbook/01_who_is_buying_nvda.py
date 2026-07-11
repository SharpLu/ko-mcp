"""Who is buying NVDA?

The question every 13F season: which institutions are accumulating a stock,
and is the smart money adding or trimming? This pulls the top institutional
holders of NVDA and the aggregate accumulation/distribution trend across
recent quarters.

Run it (no API key needed — demo mode):

    pip install ko-edgar
    python cookbook/01_who_is_buying_nvda.py

Set KO_API_KEY for your own quota (free at https://ko.io/console).
"""

from ko_edgar import KoClient

TICKER = "NVDA"


def main() -> None:
    ko = KoClient()

    print(f"=== Top institutional holders of {TICKER} ===\n")
    holders = ko.stocks.holders(TICKER, per_page=10)
    for h in holders:
        value = float(h.get("holding_value") or 0)
        print(f"  {h.get('name', '?'):<50} ${value / 1e9:>8.2f}B  {h.get('action', '')}")

    print(f"\n=== Institutional activity in {TICKER}, last 8 quarters ===\n")
    activity = ko.stocks.activity(TICKER, quarters=8)
    trend = activity.data.get("trend", []) if isinstance(activity.data, dict) else []
    for q in trend:
        net = float(q.get("netValue") or 0)
        direction = "net BUY " if net >= 0 else "net SELL"
        print(
            f"  {q.get('quarter', '?')}: {q.get('institutionsIncreased', 0):>5} added, "
            f"{q.get('institutionsDecreased', 0):>5} reduced, "
            f"{q.get('institutionsNew', 0):>4} new → {direction} ${abs(net) / 1e9:.1f}B"
        )

    print("\nEvery row above is traced to a real SEC 13F filing.")


if __name__ == "__main__":
    main()
