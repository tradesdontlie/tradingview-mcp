# MT5 Tree Bot

A risk-first MT5 trading engine and demo console.

> [!CAUTION]
> **No strategy has passed validation.** Use simulation or an MT5 DEMO account only. Do not risk real funds with the included placeholder signals or research experiments.

## Components

| Path | Role |
|---|---|
| `tradingbot/tree_manager.py` | Parent/child ledger, budgets, branch cancellation, expiry |
| `tradingbot/trade_scheduler.py` | Signal ranking and queued-child assignment |
| `tradingbot/risk_manager.py` | Position sizing and account risk gates |
| `tradingbot/kill_switch.py` | Persistent PAUSE/FREEZE/LIQUIDATE control |
| `tradingbot/execution_engine.py` | Order intent, reconciliation, and ambiguous-order handling |
| `tradingbot/orchestrator.py` | Tick loop and component orchestration |
| `tradingbot/database.py` | SQLite persistence |
| `tradingbot/analytics.py` | Trading statistics |
| `tradingbot/broker_sim.py` | Offline simulated broker |
| `tradingbot/broker_mt5.py` | MetaTrader 5 broker adapter |
| `tradingbot/server.py`, `dashboard/` | Browser console and HTTP API |
| `app.py` | Combined engine and console entry point |

## Start in simulation

```bash
python -m venv venv
# macOS/Linux
source venv/bin/activate
# Windows
# venv\Scripts\activate

pip install -r requirements.txt
python app.py --mode sim
```

Open `http://127.0.0.1:8765` unless a different `--host` or `--port` is used.

## Start against MT5 demo

```bash
python app.py --mode demo
```

MT5 demo mode requires Windows and a running MetaTrader 5 terminal logged into a demo account. The demo adapter has not been validated against every broker configuration. Emergency or real-account use is outside this project's validated scope.

## Profiles

- `standard`: improved checklist, journal, equity guard, and tree controls
- `small`: one-trade-at-a-time profile for smaller accounts
- `scalp`: M5-oriented profile; cost and edge assumptions require proof on your own data

Profiles are still defaults to validate, not proven profitable configurations.

## Research and validation

```bash
python portfolio_research.py --synthetic random
python portfolio_research.py --synthetic trend
python setup_research.py --synthetic random
python setup_research.py --synthetic trend
python setup_research.py --ablation
python analyze_journal.py
python compare_modes.py --market random
```

Real-data research requires files such as `data/<PAIR>_H1.csv` or `data/<PAIR>_M5.csv`. Research scripts do not prove future profitability and must not be used as an automatic trading recommendation.

## Tests

```bash
python -m unittest discover -s tests -v
```

Core coverage includes tree rules, risk gates, kill switches, execution reconciliation, Supabase/mobile API behavior, settings, small-account/scalp profiles, and broker assumptions.

## Safety rules

- Never expose the console directly to the public internet.
- Use HTTPS and private networking when accessing a remote console.
- Keep emergency control available; test it in simulation first.
- Add a real demo-account validation report before any live-broker expansion.
- Preserve server-side stops and reconcile broker state after every restart.
