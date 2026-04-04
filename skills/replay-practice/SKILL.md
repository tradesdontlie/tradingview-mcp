---
name: replay-practice
description: Practice trading in TradingView replay mode — step through historical bars, take trades, track P&L. Use when the user wants to practice or backtest manually.
---

# Replay Practice Trading

You are guiding the user through replay-mode practice trading on TradingView.

## Step 1: Setup

1. `chart_set_symbol` — set the desired symbol
2. `chart_set_timeframe` — set the trading timeframe
3. `replay_start` with a date — enter replay mode at the starting point

## Step 2: Pre-Trade Analysis

Before stepping through bars:
1. `data_get_ohlcv` — get the historical context leading up to the replay point
2. Add any indicators the user wants: `chart_manage_indicator`
3. `capture_screenshot` — show the starting chart state

## Step 3: Step Through Bars

Use `replay_step` to advance one bar at a time, or `replay_autoplay` for continuous play.

After each significant move:
1. `replay_status` — check current date, position, and P&L
2. Announce what happened (breakout, support test, etc.)

## Step 4: Execute Trades

When the user identifies an entry:
- `replay_trade` with action "buy" or "sell"
- `replay_status` to confirm the position was opened

When the user wants to exit:
- `replay_trade` with action "close"
- `replay_status` to show the P&L

## Step 5: Review

After the practice session:
1. `replay_status` — final P&L summary
2. `capture_screenshot` — capture the final chart state
3. `replay_stop` — exit replay mode

Report:
- Total trades taken
- Win/loss record
- Net P&L
- Key lessons from the session

## Tips

- Step through 5-10 bars at a time to find setups, then slow down for entry timing
- Use `replay_autoplay` with speed control for faster scanning
- Add drawings with `draw` to mark entry/exit points for review
