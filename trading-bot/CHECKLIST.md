# Pre-trade checklist (every item must be YES)

The bot enforces this automatically (`tradingbot/checklist.py`). Use the same list if you ever
trade or review by hand. One NO means no trade.

## MARKET FLOW
1. **Trend**: does the 4-hour trend point the same way as the trade?
2. **Structure**: did price break its last swing high (buy) or swing low (sell) in the last 20 bars?
3. **Location**: buying in the discount half, or selling in the premium half, of the swing range?
4. **Trigger**: is there ONE of: liquidity sweep and close back, order-block tap with rejection,
   opening-range breakout (London), or a long-wick rejection candle?
5. **Room**: is there at least 2R of clear space before the opposing swing?

## CONDITIONS
6. **Not chasing**: is price within 2 ATR of its 20-bar average?
7. **Volatility**: is ATR between 0.6x and 1.8x of its normal level?
8. **Session**: London, overlap or New York only, and not late Friday?
9. **Spread and stop**: spread at most 15% of the stop, and the stop between 1 and 2.5 ATR?

## ACCOUNT (the risk manager and journal check these)
10. **Risk gates**: kill switch clear, not in a loss-streak cooldown, risk within caps, no other open
    trade from the same tree, no correlated exposure, equity guard not tripped?
11. **Journal gate**: is this setup / session / pair NOT proven to lose in the journal?

## Extra slot (3rd or 4th trade at once)
Only if ALL of the above pass AND the journal's pessimistic (95%) win probability for this setup is
at least 80% over 30+ trades. At 1:3 reward-to-risk that is almost never true, so extra slots will
normally stay closed. That is intended.

## After every trade (automatic, in the journal)
Result in R, exit reason, session, setup, volatility, how stretched the entry was, spread share,
and a one-line lesson. Review weekly: `python analyze_journal.py`.
