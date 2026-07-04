# Trading Bot Orchestrator

A control-plane agent that tunes **which strategies and filters each bot runs**,
toward a win%+expectancy objective. It never makes trade-level decisions — that
stays deterministic in the bots (Approach A). The agent only edits
`../orchestrator_config.json`, which the bots read each scan.

## How it works

```
curriculum/ (durable rules) ─┐
                             ├─► system prompt ─► Claude (claude-opus-4-8)
live data (tools) ───────────┘                        │
  • trade_ledger.jsonl  (futures resolved trades)      │ proposes candidate configs
  • bot_events.jsonl    (escalations)                  ▼
  • strategy_matrix_results.csv (backtest priors)   lib/guardrails.mjs  ◄── ENFORCES
                                                        │  (clamp · ≥2 · 1-change ·
                                                        │   win%≥60 · exp≥+0.2R · n≥20 ·
                                                        ▼   risk stricter-only)
                                                   lib/apply.mjs
                                              auto → write config + rationale
                                              approval → decisions/pending/
```

The model **proposes**; the deterministic guardrails in `lib/` **enforce**. The
guardrails are the load-bearing part and are unit-tested without the model
(`npm test`). The estimate heuristic (`lib/estimate.mjs`) is the intended tuning
knob; the gates around it are not.

## Objective

A config change is accepted only if, on an adequate sample, it clears all three:
**win% ≥ 60% AND expectancy ≥ +0.2R/trade AND sample ≥ 20 trades per combo.**
Win% alone is a trap (see `curriculum/objective.md`).

## Data sources

Win%/expectancy is estimated by **replaying the live-model trade log** filtered to
the candidate's active strategies (a trade is retained if ≥2 of its agreeing
strategies stay active). Source preference per bot:

- **Futures** → the live `trade_ledger.jsonl` once it has ≥ 20 retained trades,
  else the futures confluence backtest (`backtest_futures_results.json`).
- **Spot** → the spot confluence backtest (`backtest_results.json`); no live
  ledger (spot has no exchange-side exits). Regenerate via
  `node ../scripts/run_backtest.mjs` (and `run_backtest_futures.mjs`).

These backtests run the actual bot pipeline (confluence + bias-filter stack +
Ch.6 guard), include the `levels` strategy, and are on the same scale as the 60%
objective (spot ~65%, futures ~66%). **`strategy_matrix_results.csv` is a
ranking aid only** (`lookup_matrix`) — it's a neutral raw-edge sweep that excludes
`levels` and whose absolute win% (~47%) is NOT comparable to the objective.

## Run

```sh
npm install                 # @anthropic-ai/sdk + zod
export ANTHROPIC_API_KEY=…  # or: ant auth login
npm run cycle               # one decision cycle, then exit
npm test                    # guardrail + estimate tests (no API key needed)
```

Schedule it (Windows Task Scheduler) for periodic cycles, and trigger
`Start-ScheduledTask` on a high-severity line in `bot_events.jsonl` for the
event-driven path.

## Autonomy (hybrid)

- Enable/disable a strategy or filter within the validated universe → **auto-apply**
  (versioned, logged to `decisions/`, reversible).
- Raise the risk gate (`HISTORICAL_WIN_RATE`) → **approval-required**, staged to
  `decisions/pending/` for a human to promote. Lowering it (stricter) auto-applies.

## Files

| Path | Role |
|---|---|
| `config.mjs` | Validated universe (mirrors the bots) + thresholds |
| `lib/ledger.mjs` | Parse `trade_ledger.jsonl` → normalized trades + per-combo stats |
| `lib/backtest.mjs` | Parse confluence-backtest JSON → normalized live-model trades |
| `lib/events.mjs` | Parse `bot_events.jsonl` → escalation summary |
| `lib/matrix.mjs` | Parse `strategy_matrix_results.csv` → ranking aid only (not the estimate) |
| `lib/estimate.mjs` | Candidate-performance estimate by trade-log replay (the tuning knob) |
| `lib/guardrails.mjs` | **Deterministic enforcement** — the safety-critical core |
| `lib/apply.mjs` | Autonomy gate + versioned config write + dated rationale |
| `tools/index.mjs` | Anthropic SDK tool-runner wrappers around `lib/` |
| `index.mjs` | One-cycle entrypoint |
| `curriculum/` | Durable rules loaded into the system prompt |
| `decisions/` | Dated rationale per cycle (`pending/`, `rejected/` subfolders) |

## Known gaps (intentional, documented)

- **Filters aren't in the numeric estimate.** The static backtest log already
  baked in whichever bias filters were on when it ran, so toggling a filter in a
  candidate can't be re-simulated from the log. The agent proposes filter toggles
  and the guardrails clamp them, but their numeric effect isn't modeled — to
  measure a filter change, regenerate the backtest with that filter set. Strategy
  toggles, by contrast, ARE modeled (retain-by-active-strategies replay).
- **Estimate freshness depends on backtest recency.** Spot (and futures until its
  ledger fills) is only as current as the last `run_backtest*.mjs` run. Regenerate
  the backtests before trusting a cycle's spot decisions.
- **Futures resolution uses planned SL/TP levels, not exchange-realized PnL.**
  Fine for win%/expectancy at current sizing; for true realized PnL, add a
  `userTrades`/`income` getter to `src/core/binance_futures.js`.
