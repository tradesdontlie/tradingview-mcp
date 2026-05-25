# Live Scan Prompt Template

Use this to scan MNQ1! or MES1! for active MTF Session Liquidity Trap setups.

---

## Step 1 — Build MTF Bias (top-down, highest to lowest)

1. `chart_set_timeframe("240")` then `data_get_ohlcv(summary:true)` → 4H macro bias (bullish / bearish / neutral)
2. `chart_set_timeframe("60")` then `data_get_ohlcv(summary:true)` → 1H session context
3. `chart_set_timeframe("15")` then `data_get_ohlcv(summary:true)` → 15m setup context
4. `chart_set_timeframe("5")` then `data_get_ohlcv(summary:true)` → 5m execution context

If 4H and 1H are in direct conflict → output WAIT immediately. Do not proceed to Step 2.

## Step 2 — Read Session Levels and Custom Indicator Output

5. `data_get_pine_labels(study_filter:"session")` → Asia/London/NY highs, lows, POC labels
6. `data_get_pine_lines` → horizontal price levels (PDH, PDL, OR high/low)
7. `data_get_pine_boxes` → FVG / iFVG zones

## Step 3 — Read Indicator Values and Live Price

8. `quote_get` → current price, OHLC, volume snapshot
9. `data_get_study_values` → RSI, volume, any visible indicator readings

## Step 4 — Visual Confirmation (always last)

10. `capture_screenshot(region:"chart")` → visual confirmation only. Never the primary signal source.

---

## Required Output Format

Every scan must produce exactly this block. Do not omit any field.

    Decision: LONG / SHORT / WAIT
    Symbol: MNQ1! / MES1!
    Timeframe: 5m execution | 15m setup | 1H/4H bias
    Bias: Bullish / Bearish / Neutral / Mixed
    Setup: MTF Session Liquidity Trap
    Entry: [price or zone, e.g. 21450–21460]
    Stop: [price, e.g. 21410]
    TP1: [price, e.g. 21530]
    TP2: [price, e.g. 21610]
    R: [calculated R to TP1, e.g. 2.0R]
    Confidence: A+ / A / B / C / Reject
    Reasons:
      - MTF bias: [4H: Bullish | 1H: Bullish | 15m: Neutral]
      - Session sweep: [e.g. Asia low swept at 21420, wick through, immediate rejection]
      - Reclaim: [e.g. reclaimed within 3 candles, strong close above]
      - MSS/CHoCH: [e.g. confirmed on 5m — higher high at 21455]
      - Volume: [e.g. displacement candle volume 2.3x average]
    Invalidation:
      - [e.g. Close back below swept level 21420]
      - [e.g. Setup expires after 3 more 5m candles]
      - [e.g. News lockout: CPI at 08:30]
    What would change decision:
      - [e.g. Currently WAIT — need 5m MSS confirmation and volume expansion]

---

## Rules for This Template

- Data-first, visual-second. Screenshot is confirmation only — never the signal source.
- If ANY hard reject condition is present → output Decision: WAIT and state the rejection reason.
- Never output LONG or SHORT without a defined Entry, Stop, TP1, and R.
- If 4H/1H conflict and Confidence is below A+ → output WAIT.
- Signal expires after 3 candles since entry trigger — do not output a stale setup as active.
- All price levels must come from MCP data tools, not from visual estimation.
- Confidence grade must match the Rejection Trigger Table in risk-rules.md.
