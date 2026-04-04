---
name: chart-analysis
description: Analyze a chart — set up symbol/timeframe, add indicators, scroll to key dates, annotate, and screenshot. Use when the user wants technical analysis or chart review.
---

# Chart Analysis Workflow

You are performing technical analysis on a TradingView chart.

## Step 1: Set Up the Chart

1. `chart_set_symbol` — switch to the requested symbol
2. `chart_set_timeframe` — set the appropriate timeframe
3. Wait for the chart to load (the tool handles this)

## Step 2: Add Indicators

Use `chart_manage_indicator` to add studies. Common names (must use FULL names):
- "Relative Strength Index" (not RSI)
- "Moving Average Exponential" (not EMA)
- "Moving Average" (for SMA)
- "MACD"
- "Bollinger Bands"
- "Volume"
- "VWAP"
- "Average True Range"

After adding, use `indicator_set_inputs` to customize settings (e.g., change EMA length to 200).

## Step 3: Navigate to Key Areas

- `chart_scroll_to_date` — jump to a specific date of interest
- `chart_set_visible_range` — zoom to a specific date window
- `chart_get_visible_range` — check what's currently visible

## Step 4: Annotate

Use drawing tools to mark up the chart:
- `draw` with `horizontal_line` for support/resistance
- `draw` with `trend_line` for trend channels (needs two points)
- `draw` with `text` for annotations
- `draw` with `price_range` / `measure` for measurements
- `draw` with `fibonacci_retracement` for fib levels

## Step 5: Capture and Analyze

1. `capture_screenshot` — screenshot the annotated chart
2. `data_get_ohlcv` — pull recent price data for quantitative analysis
3. `quote_get` — get the current real-time price
4. `symbol_info` — get symbol metadata (exchange, type, session)

## Step 6: Report

Provide the analysis:
- Current price and recent range
- Key support/resistance levels identified
- Indicator readings (RSI overbought/oversold, MACD crossover, etc.)
- Overall bias (bullish/bearish/neutral) with reasoning

## Cleanup

If you added indicators the user didn't ask for, remove them:
- `chart_manage_indicator` with action "remove" and the entity_id
- `draw_clear` to remove all drawings if they were temporary
