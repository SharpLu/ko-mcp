"""Which institutions hold spot Bitcoin ETFs?

13F filings reveal institutional BTC exposure through spot ETFs (IBIT,
FBTC, ...). This shows the market-wide picture and the largest holders —
data most BTC dashboards don't have because it requires parsing 13F.

    python cookbook/05_btc_etf_institutional_exposure.py
"""

from ko_sec import KoClient


def main() -> None:
    ko = KoClient()

    summary = ko.crypto.exposure_summary()
    data = summary.data if isinstance(summary.data, dict) else {}
    complex_stats = data.get("complex", {})
    products = data.get("products", [])

    total = float(complex_stats.get("total_usd") or 0)
    qoq = float(complex_stats.get("qoq_change") or 0)
    print("=== Institutional spot-BTC-ETF exposure (from 13F) ===\n")
    print(f"  Total: ${total / 1e9:.2f}B  (QoQ {'+' if qoq >= 0 else '-'}${abs(qoq) / 1e9:.2f}B)")
    print(f"  Products tracked: {complex_stats.get('products', len(products))}\n")

    print("By product:\n")
    for p in products[:8]:
        value = float(p.get("total_usd") or 0)
        print(
            f"  {p.get('product_ticker', '?'):<6} {p.get('holders', '?'):>5} holders  "
            f"${value / 1e9:>6.2f}B  ({p.get('sponsor', '')})"
        )

    print("\nTop IBIT holders:\n")
    holders_result = ko.crypto.holders(product="IBIT", per_page=10)
    holder_rows = (
        holders_result.data.get("holders", [])
        if isinstance(holders_result.data, dict)
        else holders_result.rows
    )
    for h in holder_rows:
        value = float(h.get("total_usd") or 0)
        print(f"  {h.get('name', '?'):<50} ${value / 1e6:>9.1f}M")


if __name__ == "__main__":
    main()
