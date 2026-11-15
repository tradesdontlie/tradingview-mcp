# MT5 tree-trading bot: foundation

Risk-first engine for the tree design: a winning trade funds two smaller child trades,
a losing trade ends its branch, at most two positions open account-wide, kill switch on top.

**No strategy has passed validation yet (see research.py results). This is infrastructure.
Do not use real money. The only live target for now is an MT5 DEMO account.**

## Web console
    python app.py --mode sim      # simulated broker, any OS -> open http://127.0.0.1:8765
    python app.py --mode demo     # MT5 DEMO account (Windows), random placeholder signals
The page shows equity, the live trade trees, open trades, refused trades, the event log,
the rules in force, and an account planner (how deep your tree can really grow).
Pause / Freeze / Liquidate / Reset need the control token printed at startup. The server
binds to 127.0.0.1 only. Never expose it to a network.

## Layout
| File | Role |
|---|---|
| tradingbot/tree_manager.py | parent/child ledger, budgets, branch death, expiry |
| tradingbot/trade_scheduler.py | slot limit, reserved root slot |
| tradingbot/risk_manager.py | approval gate: sizing (round down), min-lot, spread, headroom, correlation, daily/drawdown limits |
| tradingbot/kill_switch.py | persistent PAUSE / FREEZE / LIQUIDATE, explicit reset |
| tradingbot/execution_engine.py | intent-first orders, ambiguity resolution, reconciliation, time stops |
| tradingbot/orchestrator.py | the tick loop |
| tradingbot/database.py, analytics.py | SQLite persistence, statistics |
| tradingbot/broker_sim.py | offline broker with failure injection |
| tradingbot/broker_mt5.py | MT5 adapter (**not yet run against a terminal**) |
| tradingbot/server.py + dashboard/index.html | browser console (stdlib server, no dependencies) |
| app.py | one command: bot + console |
| run_sim.py / run_demo.py / check_mt5.py / kill.py | simulator, demo plumbing test, read-only health check, kill CLI |

## Research (evidence-based strategies)
    python portfolio_research.py --synthetic random   # negative control: all must fail
    python portfolio_research.py --synthetic trend    # positive control: trend rules must pass
    python portfolio_research.py                      # your data in data/ (daily files)
Tests volatility-targeted trend (time-series momentum) across many instruments and FX
cross-sectional momentum, with costs, 2x-cost stress, both-halves check and the Deflated
Sharpe Ratio. A strategy must pass here before it goes anywhere near the bot.

## Commands
    python -m unittest discover -s tests -v   # 22 tests, any OS
    python run_sim.py --equity 10000          # whole bot on the simulated broker
    python run_sim.py --equity 1000           # see the tree collapse on a small account
    python check_mt5.py                       # Windows, read-only: hedging? min lot? tree depth?
    python run_demo.py --interval 60          # Windows, DEMO only, random placeholder signal
    python kill.py freeze                     # from a second window, any time

## Rules implemented (defaults in config.py)
- Win = net P&L after costs > 0. Winner's profit x 1/3, split in two = child budget (1/6 each).
- Child planned loss = 50% of its budget; target 1:3. Child risk = 1/4 of its parent's.
- Root win also adds 10% of its profit to a root pool (recorded, **not spent**: undecided).
- Loss ends the branch and cancels unopened descendants; siblings continue.
- Max 2 open account-wide; children may not take the last slot.
- Unused child budgets expire after 3 days. Trades are time-stopped after 48 hours.
- Child below one minimum lot becomes DUST: skipped, never rounded up.

## Known limits
- Weekly loss limit and broker-day boundaries are not implemented (daily uses UTC).
- Emergency liquidation exists but default policy should stay FREEZE.
- Correlation guard is currency-based and simple.
- MT5 adapter, filling modes, history lookup and tick-value maths need demo validation.
