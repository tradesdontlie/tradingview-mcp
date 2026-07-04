# Known baselines (the prior — confirm against current data each cycle)

These are measured figures from the project's backtests as of mid-2026. Treat
them as priors to sanity-check the live numbers against, not as current truth —
always pull fresh stats via the tools before deciding.

## Confluence-bot backtests (the live model)
- Spot, CVD-inclusive consistent measurement: **65% (24W/37)**.
- Futures, CVD-inclusive: **66% (33W/50)**.
- Strongest pair across both: **divergence+levels** (73–77%).
- `cvd_divergence+fibonacci` strong on spot (small sample — treat with caution).
- `cvd_divergence+sfp` weak on futures (~25%, small sample).

## Strategy matrix (neutral both-directions sim — raw edge, not the live model)
- **market_structure / CHoCH**: 86–89% win% on 1m–15m but ~0.1 avg R — high
  hit-rate scalp, NOT a profitable standalone. The canonical expectancy trap.
- **VWAP is the strongest confirmation filter** (market_structure|vwap 93%,
  pinbar|vwap 63% @ 0.58R). Levels filter close behind. VPVR weakest.
- Most balanced real edge (good win% AND reward): `divergence+pinbar` 15m
  (57% @ 0.82R), `pinbar|vwap` 1h (63% @ 0.58R).
- ⚠️ 1m/5m divergence & CVD rows show PF 700+/avg R 400+ — pure artifact. Win%
  (~46–47%) is the only meaningful figure on those rows.

## Universe
Validated for BTC/ETH/BNB only. The rules do NOT generalize — a top-20-volume
backtest dropped spot 58→49% and futures 69→46%, with meme coins at 17%. Never
propose widening beyond these three symbols (the clamp blocks it anyway).
