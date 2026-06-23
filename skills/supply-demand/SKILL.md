---
name: supply-demand
description: Test the Supply & Demand zone strategy on a TradingView chart — consolidation-then-impulse zone detection, fresh-zone tracking, reversal candle (pin / engulfer / tweezer) entries with min 1:2 RR. Use when the user mentions Alex Morris, supply zone, demand zone, institutional zone, fresh retest, or wants to backtest, screenshot, or iterate on this Forex strategy. Drives the existing pine-develop loop using scripts/strategies/supply-demand.pine.
---

# Supply & Demand — Test Loop

Drive a focused test cycle for the Supply & Demand strategy on TradingView.

## Pre-flight

1. TradingView must be running with CDP enabled. If not: `~/tradingview-cdp.sh`
2. Verify: `tv status` → look for `cdp_connected: true`
3. Canonical strategy: `scripts/strategies/supply-demand.pine`

## Step 1 — Set chart context

This strategy is designed for **Forex on 1H**.

Suggested instruments:

- Majors: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD
- Crosses: EURGBP, GBPJPY, EURJPY

```
chart_set_symbol EURUSD
chart_set_timeframe 60
```

## Step 2 — Load the strategy

Copy the Pine source into the working file and push:

```bash
cp scripts/strategies/supply-demand.pine scripts/current.pine
node scripts/pine_push.js
```

If compile errors come back, hand off to the `pine-develop` skill. Common gotchas in this file:

- Pine v6 user-defined types (`type Zone`) must be declared at top level.
- `box.new()` requires `max_boxes_count` set in `strategy(...)` declaration (it already is — 200).
- `array.unshift` / `array.pop` are v6 idioms.

## Step 3 — Verify it runs

After a clean compile:

1. `capture_screenshot` region `chart` — confirm:
   - Demand zones drawn as green boxes.
   - Supply zones drawn as red boxes.
   - Touched zones turn grey.
   - Green/red triangles plot when a confirmed entry fires.
2. `ui_open_panel` with `strategy-tester` — open the Strategy Tester.
3. `data_get_strategy_results` — pull headline metrics:
   - Net profit %
   - Win rate
   - Profit factor
   - Max drawdown
   - Total trades
   - Average winner / average loser (validate the min 1:2 RR is biting)

## Step 4 — Walk the universe

```
for symbol in [EURUSD, GBPUSD, USDJPY, AUDUSD, EURGBP, GBPJPY]:
    chart_set_symbol(symbol)
    chart_set_timeframe("60")
    capture_screenshot(region="chart")
    data_get_strategy_results()
    # log to CSV
```

## Step 5 — Tune the zone detector (this is the hard part)

Default knobs to play with — change them in the Pine source:

| Input | Default | Effect |
|-------|---------|--------|
| `consolBars` | 2 | Higher = stricter "needs more sideways action" before counting an impulse |
| `consolMaxAtr` | 0.8 | Lower = tighter consolidation requirement |
| `impulseMinAtr` | 1.5 | Higher = bigger breakouts only |
| `atrLen` | 14 | Volatility yardstick |
| `pinWickPct` | 0.5 | Lower = looser pin-bar definition |
| `tweezerTolPct` | 0.05 | Tighter wick alignment requirement |
| `minRR` | 2.0 | Drop to 1.5 if too few trades |
| `stopBufferAtrFrac` | 0.1 | Wider stops if too many premature exits |

Recommended sequence:

1. Start at defaults, capture metrics.
2. If too few trades → loosen `consolMaxAtr` to 1.0 and `impulseMinAtr` to 1.2.
3. If too many bad zones triggering → tighten `consolBars` to 3.
4. If RR is fine but win rate is low → tighten confirmation candles (disable tweezers; raise `pinWickPct` to 0.6).

## Validation checklist (for live setup scoring)

When Claude is asked to score a *live* setup against this strategy:

- [ ] Zone formed from a clear consolidation → impulsive breakout
- [ ] Anchor candle is the last opposite-colour candle before the impulse
- [ ] Zone has NOT been retested yet (fresh-only rule)
- [ ] Pin bar / engulfer / tweezer prints inside the zone
- [ ] Stop placed beyond the reversal candle (not the entire zone)
- [ ] Nearest opposing zone gives ≥ 1:2 RR
- [ ] No red-folder news in trade window

## Universal risk rules

- Risk ladder: 0.5% trades 1–100, 0.75% 101–200, 1% thereafter. Cap 1%.
- Position size = `(equity × risk_pct) / stop_distance`.
- Don't move stops backwards.
- Backtest 100+ trades before risking live capital.

## Known limitations of this Pine implementation

- **Consolidation detection is range-based**, not pattern-based. It uses ATR-relative range over `consolBars` bars. This catches most useful zones but will miss some textbook ones and pick up some noise — tune via the inputs above.
- **Anchor candle search** looks back a small window only. Very long consolidations may use the wrong anchor.
- **No news filter built in.** Skip red-folder days manually (or pair with an external news-blackout MCP tool).
- **First-retest rule** is implemented via a per-zone `fresh` flag. Once any bar's range intersects the zone, the zone is dead.

## Source

Visser & van Niekerk (2023), *Six Figures From Scratch*, Chapter 10. Rules paraphrased structurally; do not reproduce book text.
