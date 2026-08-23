"""Asian-session failed-breakout / liquidity-sweep setup: a rule-based state
machine, not an ML model. See config.py for the full parameter surface and
engine.py for the state machine itself.

Run a backtest:
    python -m strategies.asian_failed_breakout.backtest --symbol MGC1! --days 30
"""
