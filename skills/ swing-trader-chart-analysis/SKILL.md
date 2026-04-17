---
name: swing-trader-chart-analysis
description: Swing-trading technical analysis on TradingView — set symbol and timeframe, add indicators, navigate to dates, annotate with drawings, screenshot, and pull OHLCV data. Use when the user asks about a ticker's chart, trend, support/resistance, or indicator readings on a swing-trading horizon (days to weeks). Examples: "what's RSI on BTC", "is AAPL overbought", "pull up ETH daily", "where's support on SPY", "read the chart on NVDA".
---

# Chart Analysis (Swing Trading)

Technical analysis on TradingView for swing-trading horizons — days to weeks. Compose the tools below based on what the user asked for; don't march through every step.

## Timeframe defaults

- **Primary:** daily (1D). This is where swing setups live.
- **Context:** weekly (1W) for trend structure, 4h for entry timing.
- **Ignore:** anything under 1h unless the user explicitly asks. Intraday noise is irrelevant to swing decisions.

If the user says "scalp", "intraday", "today", or names a sub-hour timeframe, this skill isn't the right fit — tell them and stop.

## Tools

**Setup**
- `chart_set_symbol` — switch ticker
- `chart_set_timeframe` — switch timeframe
- `symbol_info` — exchange, type, session metadata

**Data**
- `quote_get` — current real-time price
- `data_get_ohlcv` — historical OHLCV for quantitative work

**Indicators**
- `chart_manage_indicator` — add or remove studies
- `indicator_set_inputs` — customize settings

**Navigation**
- `chart_scroll_to_date` — jump to a date
- `chart_set_visible_range` — zoom to a window
- `chart_get_visible_range` — check current view

**Annotation**
- `draw_shape` — `horizontal_line` (support/resistance), `trend_line` (two points), `text` (labels)
- `draw_clear` — wipe all drawings

**Capture**
- `capture_screenshot` — image of current chart state

## Indicator names

TradingView's indicator search requires the exact display name. Acronyms and reordered names usually fail. Known mappings:

- RSI → `Relative Strength Index`
- EMA → `Moving Average Exponential`
- SMA → `Moving Average`
- ATR → `Average True Range`
- MACD → `MACD`
- Bollinger Bands → `Bollinger Bands`
- Volume → `Volume`
- VWAP → `VWAP`

For anything not listed, try the full conventional name first (e.g. "Ichimoku Cloud", "Parabolic SAR", "Stochastic RSI"). If `chart_manage_indicator` returns no match, the name is wrong — don't retry with the acronym, ask the user or try a likely variant.

## Swing-trading indicator defaults

When the user asks for "analysis" or "a read" without specifying indicators, use this as the default kit on the daily:

- **50 SMA and 200 SMA** — the key dynamic levels the market watches at this timeframe. "Golden cross" / "death cross" and "200-day" all refer to SMAs. Use `Moving Average` with length 50 and 200.
- **21 EMA** — shorter trend filter and pullback entry reference. Use `Moving Average Exponential` with length 21.
- **RSI (14)** — overbought/oversold and divergence. Default length 14 is fine.
- **Volume** — confirm or reject moves at key levels.

Why SMA for 50/200 and EMA for 21: reflexivity. The daily 50/200 SMAs are what financial media, bank research, and most platforms reference, so they get more reactions. The shorter 21 is used more often as an EMA in swing trader practice for faster response on pullback entries.

Add MACD or Bollinger Bands only if the user asks or if the setup specifically calls for them (momentum shift, volatility squeeze). Don't clutter the chart.

## Drawing support and resistance

When the user asks for S/R, or when a full analysis calls for marked levels, use these rules:

**How to pick levels** *(default — confirm with me if you want to change this)*
- Prior swing highs and swing lows visible in the current view — pivot points where price clearly reversed.
- Only mark levels that have been tested at least twice. A single touch is a pivot, not a level.
- Include obvious round numbers if they coincide with prior structure (e.g. $100, $50k on BTC) — they often act as levels because participants watch them.

**How many to draw**
- Default to the 2–3 most important levels. A clean chart with the key lines beats a cluttered one. If the user asks for "all major levels" or "comprehensive", draw more.

**How to label**
- Distinguish support (below current price) from resistance (above). Use the `text` shape to label each line with its price and a quick descriptor ("major support — tested 4x" or "prior resistance, now support").
- If a level has been broken and retested from the other side, say so — flipped levels are the highest-quality S/R.

**What to skip**
- Don't draw minor intraday wicks that haven't been retested.
- Don't draw lines on the 4h or lower unless the user specifically asked for shorter-timeframe levels.
- Don't fill the chart with every touch — ruthless about quality.

## Composition examples

**Quick reading** — "What's RSI on BTC?"
Daily, add Relative Strength Index, read the value, report. No moving averages, no drawings.

**Full swing read** — "Give me a technical read on SPY"
Daily primary. Add 50 SMA, 200 SMA, 21 EMA, RSI, Volume. Draw the 2–3 most important horizontal levels in view. Check the weekly briefly for higher-timeframe trend. Screenshot. Report: price vs. the MAs, RSI reading, recent volume behavior, key horizontal levels, and a clear swing bias (bullish / bearish / neutral / range) with reasoning and what would invalidate it.

**Level marking** — "Mark support and resistance on ETH"
Daily. Identify swing highs and lows that have been tested 2+ times. Draw horizontal lines for the 2–3 most important, labeled with price and touch count. Screenshot. Describe each level.

**Historical context** — "What happened to TSLA around Q3 2023 earnings?"
Daily. Scroll to the window. Pull OHLCV for the range. Screenshot. Describe the move in terms a swing trader cares about — gap, follow-through, where it closed relative to prior structure.

**Multi-timeframe check** — "Is NVDA setting up for a swing long?"
Weekly first for trend, then daily for the setup, then 4h for entry timing. Same indicator kit on each. Report what each timeframe says and whether they agree — conflicting timeframes is itself the answer.

## Rules

- Default to daily. Use weekly for trend context and 4h for entry timing. Skip anything shorter.
- Only add indicators the user asked for or that the default kit calls for. Don't add speculative studies.
- Report in swing-trading language: trend direction, key levels, where price sits in the range, indicator readings, bias, and invalidation level. Avoid hedged non-answers.
- A bias isn't a prediction — it's "if I had to lean, I'd lean X because Y, and I'd be wrong if Z." Always include the invalidation.
- If a tool call fails (bad symbol, indicator not found, empty data), surface it — don't paper over it with training-data guesses about the ticker.
- Not financial advice. This is chart reading, not a recommendation to trade.