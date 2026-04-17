---
name: chart-analysis-position
description: Position trading and long-term investing technical analysis on TradingView — weekly and monthly charts, long-term trend structure, major support/resistance, and macro context. Use when the user asks about a ticker's long-term trend, multi-year levels, investment thesis from a chart perspective, or whether something is in a long-term uptrend/downtrend. Examples: "is BTC still in a bull market", "long-term chart on SPY", "where's major support on AAPL", "is gold breaking out", "multi-year trend on QQQ".
---

# Chart Analysis (Position / Investing)

Technical analysis on TradingView for position-trading and investing horizons — weeks to months to years. Compose the tools below based on what the user asked for; don't march through every step.

## Timeframe defaults

- **Primary:** weekly (1W). This is where long-term trend structure is legible.
- **Context:** monthly (1M) for multi-year structure and secular trend; daily (1D) only to sanity-check the current week's action.
- **Ignore:** anything under daily. Intraday and 4h are noise at this horizon.

If the user asks about a swing setup (days to weeks), an intraday move, or "what's it doing today", this skill isn't the right fit — use `chart-analysis` (swing) or tell them this is the wrong tool.

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
- `draw_shape` — `horizontal_line` (major S/R), `trend_line` (multi-year trend channels), `text` (labels)
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

For anything not listed, try the full conventional name first. If `chart_manage_indicator` returns no match, the name is wrong — ask the user or try a likely variant. Don't retry with the acronym.

## Position/investing indicator defaults

When the user asks for "a read" without specifying indicators, use this default kit on the **weekly**:

- **200 SMA (weekly)** — the classic bull/bear dividing line. Price above = long-term uptrend, below = long-term downtrend. Use `Moving Average` with length 200.
- **50 SMA (weekly)** — intermediate trend. Crosses with the 200 are major regime signals.
- **RSI (14, weekly)** — overbought/oversold at this timeframe is meaningful, not noise. Weekly RSI divergences are high-signal.
- **Volume** — confirms breakouts from multi-year bases or breakdowns from tops.

SMA is correct at this horizon (not EMA). The 200-week SMA is the famous level — reflexivity matters because enough participants watch it. The 200-week EMA isn't a thing anyone talks about.

Don't use VWAP, MACD on daily settings, or Bollinger Bands by default — they're calibrated for shorter horizons and will mislead at this timeframe. Add them only if the user asks. VWAP specifically is intraday-oriented and not useful here.

## What matters at this horizon

Position analysis is about **regime**, not entries. The question isn't "where do I buy" but "what kind of market is this and has that changed." Focus on:

- **Price vs. 200-week SMA** — single most important level for most assets.
- **Multi-year highs and lows** — horizontal levels that have been tested multiple times over years.
- **Secular trend structure** — higher highs and higher lows on the monthly, or the opposite.
- **Major breakouts and breakdowns** — from multi-year ranges or trendlines, confirmed on weekly closes (not intraweek wicks).
- **Regime changes** — 50/200 weekly crosses, loss of a multi-year trendline, reclaim of a major level after a long absence.

What doesn't matter: daily RSI readings, short-term overbought/oversold, single-candle patterns, anything an intraday trader would care about.

## Drawing support and resistance

When the user asks for S/R at this horizon, or when a full read calls for marked levels, use these rules:

**How to pick levels**
- Prior **weekly** swing highs and swing lows — multi-year pivot points where price clearly reversed.
- Only mark levels that have been tested at least twice, ideally with tests separated by months or years. A level tested in March and then again in May isn't meaningful at this horizon; a level tested in 2021 and again in 2024 is.
- Include major round numbers if they coincide with prior structure (e.g. $100k on BTC, $500 on SPY, $20 on silver) — at this horizon they often act as psychological anchors for years.
- The 200-week SMA counts as a dynamic level in its own right — note where it is even if you don't draw it as a horizontal.

**How many to draw**
- Default to the 2–3 most important levels. The chart should show the lines that define the long-term range or trend structure, not every bounce.
- If the user asks for "all major levels" or "comprehensive", draw more — but keep the bar high. Minor weekly pivots don't qualify.

**How to label**
- Distinguish support (below current price) from resistance (above). Use `text` to label each with price and descriptor.
- Prefer descriptors that reflect the horizon: "2022 low", "all-time high", "2021-2024 range high", "prior cycle resistance". Avoid swing-trader language like "recent pivot" — at this horizon "recent" means this year.
- Flipped levels matter even more here than at swing horizons — a multi-year resistance that became support after breakout is the highest-quality level you can mark. Call it out explicitly ("2021 high, flipped to support 2024").

**What to skip**
- Don't draw daily or intraweek wicks. If a level wasn't tested on a weekly closing basis, it doesn't count.
- Don't clutter the chart with every swing high from the last decade. Ruthless about quality — if a level hasn't been relevant for years and isn't near current price, skip it.
- Don't draw trendlines as substitutes for horizontal levels unless the asset is in a clear multi-year channel (e.g. long-term commodity trends, some equity indices). Most assets don't trade in clean channels over years, and a poorly-fit trendline is worse than no trendline.

## Composition examples

**Regime check** — "Is BTC still in a bull market?"
Weekly. Add 200 SMA and 50 SMA. Check price vs. both, whether the 50 is above or below the 200, and the slope of the 200. Glance at monthly for structural context. Report: current regime, how long it's been in that regime, and what would flip it.

**Full position read** — "Long-term technical read on SPY"
Weekly primary with the default kit (50 SMA, 200 SMA, RSI, Volume). Monthly for secular context. Draw the 2–3 major horizontal levels — typically the all-time high, a major prior range high or low, and a key cycle low. Screenshot. Report: secular trend, regime (bull/bear/transition), price vs. 200w, key multi-year levels, RSI read, and the thesis with what would invalidate it.

**Major levels** — "Where's long-term support on AAPL?"
Weekly, zoomed out several years. Identify weekly swing lows that have been tested more than once across different years. Draw horizontal lines for the 2–3 most important, labeled with price, year of the pivot, and touch count. Note where the 200 SMA currently sits. Screenshot. Describe each level and which would be the "line in the sand" for the long-term thesis.

**Breakout/breakdown check** — "Is gold breaking out?"
Monthly and weekly. Identify the multi-year range or consolidation. Mark the breakout level. Check whether recent weekly closes are above it (not just wicks). Volume on the breakout candle. Report: is it a genuine breakout, a retest, or a fakeout, and what confirms or invalidates it.

**Historical regime** — "When did the last bear market in QQQ start and end?"
Weekly. Scroll to the period. Use the 200 SMA cross and price structure to mark start and end. Pull OHLCV for drawdown math. Report the regime dates, depth, and duration.

## Rules

- Default to weekly. Monthly for secular context. Daily only to check the current week's action. Nothing shorter.
- Only add indicators the user asked for or that the default kit calls for. No VWAP, no MACD, no Bollinger Bands unless requested.
- Report in position/investing language: regime (bull / bear / transition / range), secular trend, key multi-year levels, and the thesis with invalidation. Avoid short-term trading language ("setup", "entry", "stop loss") — that's not the frame.
- A thesis isn't a prediction — it's "the long-term picture is X because Y, and that thesis breaks if Z." Always include what would invalidate it.
- Weekly closes matter, intraweek wicks don't. If a level was broken on Tuesday and reclaimed by Friday, the level held. Say so.
- If a tool call fails (bad symbol, indicator not found, empty data), surface it — don't paper over it with training-data guesses about the ticker.
- Not financial advice. This is chart reading, not an investment recommendation.