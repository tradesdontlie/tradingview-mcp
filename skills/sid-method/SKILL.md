---
name: sid-method
description: Test the SID Method on a TradingView chart — RSI(14) extremes + MACD(12/26/9) crossover, structural stop at the RSI extreme's swing, exit at RSI 50. Use when the user mentions SID method, Sid Naiman, RSI 30/70 mean reversion, or wants to backtest, screenshot, or iterate on this strategy. Drives the existing pine-develop loop using scripts/strategies/sid-method.pine.
---

# SID Method — Test Loop

Drive a focused test cycle for the SID Method strategy on TradingView.

## Pre-flight

1. TradingView must be running with CDP enabled. If not: `~/tradingview-cdp.sh`
2. Verify: `tv status` → look for `cdp_connected: true`
3. The canonical strategy lives at `scripts/strategies/sid-method.pine`

## Step 1 — Set chart context

The SID Method's tested universe is **US stocks, ETFs, and indices on Daily**.

Suggested instruments:

- Stocks: AAPL, MSFT, KO, IBM, JPM
- ETFs / indices: SPY, QQQ, DIA
- Index futures: ES1!, NQ1!

```
chart_set_symbol AAPL
chart_set_timeframe D
```

## Step 2 — Load the strategy

Copy the Pine source into the working file and push:

```bash
cp scripts/strategies/sid-method.pine scripts/current.pine
node scripts/pine_push.js
```

If compile errors come back, hand off to the `pine-develop` skill.

## Step 3 — Verify it runs

After a clean compile:

1. `capture_screenshot` region `chart` — confirm the green/red signal triangles and orange exit X are plotting.
2. `ui_open_panel` with `strategy-tester` — open the Strategy Tester.
3. `data_get_strategy_results` — pull headline metrics:
   - Net profit %
   - Win rate
   - Profit factor
   - Max drawdown
   - Total trades
4. Compare against the author's claimed metrics (~70% win rate, ~0.49% expectancy per trade). **Author numbers are unverified** — your backtest is the only number that matters.

## Step 4 — Loop the universe

Run the same strategy across several instruments and record the results:

```
for symbol in [AAPL, MSFT, KO, IBM, SPY, QQQ]:
    chart_set_symbol(symbol)
    chart_set_timeframe("D")
    capture_screenshot(region="chart")
    data_get_strategy_results()
    # append to a CSV / journal
```

## Step 5 — Tweak

The defaults match the documented method: RSI(14), MACD(12/26/9), exit at RSI 50. Resist tuning. If you must, change inputs in the Pine source (not the indicator settings panel) so the test is reproducible.

Useful toggles already exposed as inputs:

- `usePattern` — turn on the double-top/bottom proxy (currently a swing-pivot check with adjustable tolerance).
- `macdLookback` — widen / narrow the window between RSI extreme and MACD cross.
- `exitLevel` — try 45 or 55 to see how exit timing affects expectancy.

## Validation checklist

When Claude is asked to score a *live* setup against this strategy:

- [ ] RSI(14) recently crossed below 30 (long) or above 70 (short)
- [ ] MACD crossover happened **after** the RSI extreme, within `macdLookback` bars
- [ ] (Optional) reversal pattern visible (H&S / inverse H&S / double top/bottom)
- [ ] Stop placed at the swing low/high printed at the RSI extreme
- [ ] Indicators at defaults — no tuning
- [ ] Instrument is a US stock / ETF / index

## Universal risk rules

- Risk ladder: 0.5% per trade for trades 1–100, 0.75% for 101–200, 1% thereafter. Cap 1%.
- Position size = `(equity × risk_pct) / stop_distance`.
- Don't move stops backwards.
- Backtest 100+ trades before risking live capital.

## Next strategies (planned)

After SID Method is validated:

- Supply & Demand (Alex Morris) — zone-rejection on Forex 1H.
- Funded Quick Win (Deni Dantev) — BB pullback, prop-firm friendly.
- M-Tops & W-Bottoms (Simon Pullen) — neckline pending order.

Each will land at `scripts/strategies/<name>.pine` and a sibling `skills/<name>/SKILL.md`.

## Source

Visser & van Niekerk (2023), *Six Figures From Scratch*, Chapter 9. Rules paraphrased structurally; do not reproduce book text. Author's performance claims are not independently verified.
