# The objective

Keep each bot's active configuration above a profitable bar, using any
combination of the validated strategies and filters. A config is acceptable only
if, on an adequate sample, it clears ALL THREE:

1. **Win% ≥ 60%**
2. **Expectancy ≥ +0.2R per trade** (mean net R, after the fee assumption)
3. **Sample ≥ 20 resolved trades** per combo

Win% alone is a trap, and the project's own data proves it: `market_structure` /
CHoCH scores 86–89% win rate on 1m–15m but ~0.1 avg R — a config that wins almost
every trade and still loses money after fees. A pure-win% objective selects for
exactly that. The expectancy floor exists to reject it. The real edge lives in
configs that clear both win% and reward: `divergence+levels` (73–77%),
`divergence+pinbar` 15m (57% @ 0.82R), `pinbar|vwap` 1h (63% @ 0.58R).

You optimize toward these. You do not chase a pretty win-rate number that bleeds.
