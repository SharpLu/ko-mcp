# Cookbook

Ten runnable answers to real investing questions. Every example works in
keyless demo mode — `pip install ko-sec` and run. Set `KO_API_KEY` for your
own quota (free at [ko.io/console](https://ko.io/console)).

| # | Question | Data used |
|---|----------|-----------|
| [01](01_who_is_buying_nvda.py) | Who is buying NVDA? | 13F holders + quarterly flow |
| [02](02_berkshire_portfolio.py) | What does Berkshire hold right now? | Family-consolidated 13F |
| [03](03_congress_hot_tickers.py) | What is Congress trading? | STOCK Act disclosures |
| [04](04_insider_buying_signals.py) | Where are insider cluster buys? | Form 3/4/5 |
| [05](05_btc_etf_institutional_exposure.py) | Which institutions hold spot BTC ETFs? | 13F crypto exposure |
| [06](06_form144_planned_sales.py) | Which insiders plan to sell? | Form 144 notices |
| [07](07_ftd_short_stress.py) | Is a short squeeze brewing? | FTD + Reg SHO threshold |
| [08](08_fund_overlap.py) | Do two funds actually diversify? | 13F portfolio overlap |
| [09](09_smart_money_new_positions.py) | What NEW positions did top funds open? | 13F action filter |
| [10](10_macro_dashboard.py) | One-screen macro dashboard | Treasury/Fed/OFR (Pro) |

```bash
pip install ko-sec
python cookbook/01_who_is_buying_nvda.py
```

Examples print real, source-traced SEC data. 01–09 run on the free tier;
10 requires Pro (it degrades gracefully without one).
