"""
Trend-breakout continuation: a standalone strategy (not a modification of
the failed-breakout/reversal strategies elsewhere in strategies/) built to
catch the kind of large, sustained trending move those strategies are
specifically designed to reject.

Core idea: wait for a level break to show ACCEPTANCE evidence — sustained
closes beyond it, no reclaim, real distance travelled — the same kind of
evidence strategies/asian_failed_breakout's engine treats as a reason to
invalidate a fade trade, used here as the entry trigger instead. Once in,
manage with a trailing stop (not a fixed R target) so a genuinely large move
isn't capped early.

Scoped to the specific high-participation windows this was built for: MGC's
Asian open (~20:00-21:00 ET) and the London/NY pre-market handoff
(~08:00-09:30 ET), and MNQ's NY open (~09:30-10:30 ET) — configurable.

Run a backtest:
    python -m strategies.trend_breakout.backtest --symbol MGC1! --days 30
"""
