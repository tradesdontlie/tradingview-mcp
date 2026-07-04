# Curriculum Chart-Annotation Conventions (EmperorBTC Ch 1-18)

How the trading curriculum draws setups on a chart. Use this when annotating a
TradingView chart (via the `draw_*` / `tv draw` tools) so the markup matches the
course's house style. Distilled from reading every chart screenshot in Chapters
1-18. Source digest: `trading_notes/_chart_annotation_digest_WIP.md`.

> One-line summary: **light/cream background; horizontal lines for levels
> (red = resistance/supply, green = support/demand, blue = secondary, dashed =
> stop/minor); shaded rectangles for zones; the TradingView Long/Short Position
> tool for the actual trade (green reward box up, red/orange risk box for the
> stop); short text labels naming the level + role; black arrows on reaction
> bars; circles/ellipses to ring a trigger candle. Frame the screenshot zoomed
> out enough to show the whole swing sequence (~60-120 bars).**

---

## 1. Global chart setup (before annotating)

| Property | Convention |
|---|---|
| Background / theme | **Light** (white or cream/pale-yellow). All EmperorBTC charts are light-theme. |
| Chart type | Candlesticks. Green = bullish, red = bearish. |
| Symbol header | Leave the TV header line visible (`BTC/USDT, 1D, BINANCE  O.. H.. L.. C.. ±chg%`) — it documents symbol/TF/OHLC. |
| Price scale | Right side, autoscaled (expand margins to show stop/targets that sit off the data — see workflow memo). |
| Date axis | Keep visible; setups reference specific dates. |
| **Framing / zoom** | **Zoom OUT** so the whole relevant swing sequence is visible — not a tight crop. Market-structure & SFP examples show ~60-120 bars; the full HH/HL/LH/LL progression + the BOS/CHoCH + the sweep + the target must all fit in one view. Use the zoomed-in/zoomed-out *pair* (same chart, two scales) when demonstrating a level holding across timeframes. |

## 2. Levels (horizontal S/R) — Ch 2, 6

- Draw as **full-width horizontal lines**, color-coded by importance:
  - **Red** = major resistance (and supply).
  - **Green** = major support (and demand).
  - **Blue** = secondary level.
  - **Faint dashed** = minor/weak level.
- **Label** each line with a short text naming the level + role, including the
  TF that produced it: e.g. `Monthly Close Resistance`, `Weekly level → becomes support`,
  `Key High`, `Key Low`, `Range High`, `Range Low`. Anchor labels at the **left edge**.
- **Rank** levels `L1`, `L2`, `L3`… by importance when several are in play; prune
  minor ones to keep the chart clean (mark **right-to-left**).
- **Touch-count** worth annotating: `3 touch level`, `Important level with 4 taps`,
  `Large bounces from support every time`.
- **S/R flip**: keep the same line; add arrows + text `Support` → `Flip to resistance`
  (or vice-versa) at the before/after points.
- Use HTF candle opens/closes/highs/lows (yearly/monthly/weekly/daily) as level sources.

## 3. Zones (S/R, supply/demand, value area) — Ch 8, 14-16

- Draw as a **shaded rectangle** covering the origin candles, **extended to the right**.
  - **Red/salmon rectangle** = supply / resistance zone.
  - **Green rectangle** = demand / support zone.
  - **Gray/neutral rectangle** = a zone of repeated reaction (importance shown by touches).
- Ladder limit orders *into* the zone rather than at a single price.

## 4. Market structure — Ch 4, 5 (the densest annotation)

- **Tag every swing pivot** with a small **bordered text box**: `HH`, `HL`, `LH`, `LL`.
- **BOS**: short horizontal line at the broken swing level + label `4H BOS` (prefix the TF).
  **Green line = bullish BOS, red line = bearish BOS.**
- **CHoCH**: short colored line at the break candle + label `Bullish CHoCH` / `Bearish CHoCH`
  (CHoCH text usually orange/blue).
- **Deep swing high/low**: label the two extremes of the active swing (`4H Deep swing high/low`);
  everything between them is "noise/substructure."
- **Pullback/entry zone** = green shaded rectangle into the demand; callouts like `Adding to the position size`.
- **Teaching callouts**: bordered text box + black leader arrow, e.g.
  `This can't be called a HL until price breaks HH`, `after BOS we didn't get a significant pullback here`.
- When writing prose, color-code the acronyms: BOS (orange/red), CHoCH (orange), HH (green), LL (red).

## 5. Fibonacci — Ch 7, 9

- Use the **native Fib Retracement tool**, anchored swing-to-swing (`0` and `1` at the swing
  extremes; "always pull left → right"). Enable the **Prices** option so each line shows
  **ratio + price**: `0.618(0.5245)`.
- Levels to show: **0, 0.236, 0.382, 0.5, 0.618, 0.702, 0.786, 1**.
- Color: 0 & 1 gray; 0.236 red; 0.382/0.5 green; **0.618 / 0.702 / 0.786 orange** (the
  **golden pocket / OTE** cluster). The author **stacks limit orders at 0.702 ("70.2%")**.
- Add a **big black diagonal arrow** along the impulse the fib measures; a bottom text label
  states the plan (`Uptrend → short-term range = look for longs`).
- Confluence: golden pocket landing inside a S/R zone → highlight with a red/green shaded zone.

## 6. Candle patterns / triggers — Ch 1, 3, 12, 13

- **Ring the trigger candle** with a **circle/ellipse**: green = bullish (pinbar/engulfing),
  red = bearish; or a **dashed black ellipse** for a neutral "look here" (`Long upper wick candle`,
  `Long lower wick candle`, `Ideal Pinbar`, `Doji`).
- Name the pattern + action in a short callout: `Bullish Engulfing`, `Break above and retest → Long Entry`,
  `Supply absorption candle`.

## 7. The trade itself (entry / stop / targets) — Ch 3, 13

- Draw with **TradingView's Long/Short Position tool**:
  - **Green box = reward/position zone** (entry → target).
  - **Red/orange box = risk/stop zone** (entry → stop).
- **Laddered entries** + **scaled targets** as **labeled horizontal dashed lines on the right edge**:
  `Entry 1`, `Entry 2`, `Target 1`, `Target 2`, `Target 3`.
- Embed the rules in the labels:
  - **Entry = candle CLOSE after the trigger** (close-based confirmation — never the wick).
  - **SL = wick of the sweep/signal candle + a little room** (`Stop: giving some room above the sweep`).
  - **Targets = last swing low/high, range low/high, or fib/VA levels.**
- Mark the SFP sweep itself with a **vertical ellipse over the wick** labeled `Sweep`,
  and the swept level with a black horizontal line (`Key High`/`Key Low`).

## 8. Divergence — Ch 10, 11, 18

- **Oscillator in a lower pane** (RSI for Ch10/11; CVD line for Ch18).
- Draw **trendlines connecting the two price pivots and the two oscillator pivots**; the
  divergence is the disagreement between those two lines.
- Bullish → compare the **lows** only; bearish → the **highs** only.
- Classify: **strong / medium / weak / hidden** (author skips hidden).
- CVD: HH price + LH CVD = **exhaustion**; CVD new high while price stalls = **absorption** — both reversal signs, short-term only.

## 9. Volume profile lines — Ch 14-17

- Histogram at the left of the profiled range; **value-area bins colored vs out-of-VA tails**.
- Horizontal labeled lines `VaH`, `VaL`, `POC`, **`nPOC`** (naked POC, red, extended right).
- **Vertical dashed day/session separators** labeled `Day 1`, `Day 2` (VPSV/VWAP).
- **VWAP** = wavy line resetting each UTC day.
- Bias color rule: **above VaH = red (shorts), below VaL = green (longs), inside = range.**

---

## 10. Quick palette / glyph legend

| Glyph | Meaning |
|---|---|
| Red horizontal line | Major resistance / supply / bearish BOS |
| Green horizontal line | Major support / demand / bullish BOS |
| Blue horizontal line | Secondary level |
| Dashed faint line | Minor level / stop |
| Red/salmon box | Supply / resistance zone / **risk-stop zone** |
| Green box | Demand / support zone / **reward-position zone** |
| Gray box | Repeated-reaction zone |
| Orange lines (fib) | Golden pocket 0.618-0.786 (order at 0.702) |
| Green circle / red circle | Bullish / bearish trigger candle |
| Dashed black ellipse | "Look at this candle" (wick/doji) |
| Vertical ellipse over a wick | SFP `Sweep` |
| Black arrow | Reaction at a level / leader for a callout |
| Big diagonal arrow | The impulse/trend being measured |
| Bordered text box (`HH`,`BOS`,…) | Structure label |
| Vertical dashed line | Day/session separator |

## 11. Mapping to this repo's `draw_*` tools

- `draw_shape horizontal_line` → levels (set color per §2), VaH/VaL/POC, fib lines if drawn manually.
- `draw_shape rectangle` → zones (§3) and the position/risk boxes (§7).
- `draw_shape trend_line` → BOS/CHoCH connectors, divergence trendlines, the impulse arrow leg.
- `draw_shape text` → every label (`HH`, `Key High`, `Sweep`, `Entry`, `Target N`, callouts).
- Native Fib tool isn't a `draw_shape` type — approximate with horizontal_lines at the ratios,
  or add the Fib via the UI. The live tiered-setup exercise's color map already aligns with this
  (🟥 red resistance/SL, 🟩 green support/entry, 🟦 blue TPs, 🟧 orange trend arrow, yellow callout) —
  see the chart-annotation-workflow memory.
