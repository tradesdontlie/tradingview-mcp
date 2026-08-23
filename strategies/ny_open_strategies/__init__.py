"""
NY-session strategy family: VWAP mean-reversion, liquidity-sweep reversal,
MA9 trend-following, and opening-range breakout. All four are scoped to the
NY session (09:30-16:00 ET) with entries blocked during the first 15 minutes
after the open (configurable) — the open is far more volatile than the rest
of the session and isn't a regime any of these rules were designed for.

Run any single strategy's backtest as a module, e.g.:
    python -m strategies.ny_open_strategies.vwap_reversion --symbol MGC1!
    python -m strategies.ny_open_strategies.backtest_all --symbol MGC1!
"""
