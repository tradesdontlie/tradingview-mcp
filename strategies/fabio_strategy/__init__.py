"""
Fabio-style intraday strategy: Context -> Location -> Price Reaction ->
Trigger -> Trade. Two primary setups (trend-pullback continuation, failed-
breakout reversal) gated by a 5m-bar market-state classifier
(BULLISH_DIRECTIONAL / BEARISH_DIRECTIONAL / BALANCE), with a TRANSITION
state that stops the strategy from chasing a structural break — it must
wait for a bounce/pullback to actually fail before treating a level break
as a new trend, not just react to the break itself.

Run a backtest:
    python -m strategies.fabio_strategy.backtest --symbol MNQ1! --tier swing --session ny
"""
