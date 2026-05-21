# AI Chart Copilot — Strategy Layer

## Scope

Manual signal assistant for: MNQ1!, MES1! (full-size reference: NQ1!, ES1!)
Output: LONG / SHORT / WAIT — no auto-execution.
Confidence: A+ / A / B / C / Reject

---

## Strategy: MTF Session Liquidity Trap Scalper

Higher timeframes grant directional permission. Lower timeframes decide where execution is allowed.

The market routinely sweeps known session liquidity pools (Asia high/low, London high/low, prior day levels, NY open range) before reversing. This strategy catches that reversal after confirmation — not on the sweep itself.

---

## Timeframe Stack

| Timeframe | Role | What to determine |
|-----------|------|-------------------|
| 4H | Macro bias | Bullish, bearish, or neutral based on swing structure and location vs key HTF levels |
| 1H | Session directional context | Confirms whether NY should favor long, short, or no trade |
| 15m | Setup formation | Identifies sweep, reclaim quality, POC relation, and structure shift forming |
| 5m | Entry confirmation | MSS/CHoCH, displacement candle, FVG/iFVG retest, volume surge |
| 1m | Optional trigger | Only used after 5m setup is active. Never used alone. |

---

## Session Level Checklist

Mark these before any analysis session. All required levels must be visible on chart.

- [ ] Prior day high (PDH) / prior day low (PDL)
- [ ] Asia session high / Asia session low / Asia POC (if available)
- [ ] London session high / London session low / London POC (if available)
- [ ] New York open range high / NY open range low (first 30 minutes)
- [ ] Session VWAP (current day)
- [ ] Fixed range VAH / VAL / POC (if visible on chart)
- [ ] 4H last swing high and swing low
- [ ] 1H last MSS direction

---

## LONG Setup — All conditions must be true

1. **4H/1H/15m bias is bullish or neutral-bullish**
   - 4H: price above key HTF level, last swing structure bullish or at support
   - 1H: trending up or at a known demand zone with bullish bias
   - 15m: holding above recent swing low, structure intact to the upside

2. **Price sweeps a known liquidity low**
   - Targets: Asia low, London low, prior day low, NY open range low
   - A sweep is a wick through the level — not a close below
   - The sweep should be visible: sudden move through the level, then immediate rejection

3. **Price reclaims back above the swept level within ≤ 5 candles**
   - At least one 5m (or 15m) candle must close back above the swept level
   - Failure to reclaim within 5 candles → setup invalid, return to WAIT

4. **5m confirms bullish MSS or CHoCH**
   - After the sweep low, price makes a higher high on 5m
   - This higher high breaks the prior lower-high structure — confirming buyers are in control
   - CHoCH: first structural break upward after the sweep

5. **Displacement candle forms with above-average volume**
   - Strong bullish candle closing near its high
   - Body > average body of last 10 candles
   - Volume clearly above the recent average
   - This candle creates an FVG or iFVG below it

6. **Entry on retest — not on the breakout candle**
   - FVG retest: price pulls back into the Fair Value Gap left by the displacement candle
   - iFVG retest: a previously filled FVG now acting as support
   - POC reclaim: price returns to the Point of Control of a volume profile zone
   - Structure retest: price returns to the broken swing high that is now support

7. **Stop below the sweep low** (structural invalidation)
   - Stop is the point where the setup is proven wrong
   - Place stop 1–2 ticks below the wick low of the sweep candle

8. **TP1 and TP2 target next session liquidity at 1.5R minimum**
   - TP1: nearest session level above entry (Asia high, London high, OR high, PDH)
   - TP2: next major liquidity pool or session extreme
   - If TP1 is below 1.5R → reject the setup

---

## SHORT Setup — All conditions must be true

1. **4H/1H/15m bias is bearish or neutral-bearish**
   - 4H: price below key HTF level, last swing structure bearish or at resistance
   - 1H: trending down or at a known supply zone with bearish bias
   - 15m: holding below recent swing high, structure intact to the downside

2. **Price sweeps a known liquidity high**
   - Targets: Asia high, London high, prior day high, NY open range high
   - A sweep is a wick through the level, then immediate rejection back below

3. **Price reclaims back below the swept level within ≤ 5 candles**
   - At least one 5m candle must close back below the swept level
   - Failure to reclaim within 5 candles → setup invalid

4. **5m confirms bearish MSS or CHoCH**
   - After the sweep high, price makes a lower low on 5m
   - This lower low breaks prior higher-low structure — confirming sellers are in control

5. **Displacement candle forms with above-average volume**
   - Strong bearish candle closing near its low
   - Body > average body of last 10 candles
   - Volume clearly above recent average
   - Creates an FVG or iFVG above it

6. **Entry on retest — not on the breakout candle**
   - FVG retest: price pulls back up into the Fair Value Gap left by the displacement candle
   - iFVG retest: a previously filled FVG now acting as resistance
   - POC rejection: price returns to POC of a volume zone and rejects
   - Structure retest: price returns to the broken swing low now acting as resistance

7. **Stop above the sweep high** (structural invalidation)
   - Place stop 1–2 ticks above the wick high of the sweep candle

8. **TP1 and TP2 target next session liquidity at 1.5R minimum**
   - TP1: nearest session level below entry
   - TP2: next major liquidity pool or session extreme

---

## WAIT Conditions

Output WAIT when any of the following are true:

- 4H and 1H are in direct conflict — one bullish, one bearish
- All three HTF timeframes (4H/1H/15m) disagree — no directional permission
- Sweep has not yet occurred — watching, not acting
- Sweep occurred but price did not reclaim the swept level
- Reclaim window expired (> 5 candles since sweep)
- No 5m MSS or CHoCH confirmed after reclaim
- Displacement candle is absent or has below-average volume
- Setup was valid but signal expired (> 3 candles since entry trigger without fill)
- News lockout is active (5 min before any major economic release)
- Chart data is stale, scale is distorted, or key levels are not visible
- Consecutive failed setups in same session without structural reset

---

## Confluence Scoring

| Factor | Weight |
|--------|--------|
| 4H / 1H / 15m all aligned | High |
| Clean wick sweep of session level | High |
| Reclaim within candle window | High |
| 5m MSS / CHoCH confirmed | High |
| Volume expansion on displacement | Medium |
| FVG or iFVG present at entry zone | Medium |
| POC reclaim or rejection at entry | Medium |
| Session VWAP position confirms direction | Medium |
| News / macro risk absent | High negative weight if present |
| 1m microscalp trigger aligns | Low (supporting only) |

**Confidence grades:**
- **A+**: All high-weight factors present. Trade in any context.
- **A**: 4H/1H aligned, sweep + reclaim + MSS confirmed. One minor confluence missing.
- **B**: 2 of 3 HTF timeframes aligned, sweep + reclaim confirmed. Volume or FVG missing.
- **C**: Sweep confirmed, partial reclaim only. Paper trade or skip.
- **Reject**: Any hard-reject condition triggers (see risk-rules.md).

---

## Key Definitions

**Liquidity sweep**: Price wicks beyond a known session level and immediately rejects back inside. Requires a close-back confirmation — not just a touch.

**Reclaim**: Price closes back on the correct side of the swept level within the candle window (≤ 5 candles from the sweep). A close, not just a wick.

**MSS (Market Structure Shift)**: On 5m, after a sequence of lower highs (downtrend), price makes a higher high — signaling a shift in control to buyers. Mirror for bearish.

**CHoCH (Change of Character)**: The first structural break in the opposing direction after a sweep. Often the same candle as MSS. Confirms intent, not just a random bounce.

**Displacement candle**: A strong directional candle — large body, above-average volume, closing near its extreme. Creates a Fair Value Gap between its open and the prior bar's wick.

**FVG (Fair Value Gap)**: Three-candle pattern where the second candle's range does not overlap with candles 1 and 3, leaving an imbalance. Price tends to return to this zone.

**iFVG (Inverse FVG)**: A previously filled FVG that, after being reclaimed from the other side, acts as support (if bullish) or resistance (if bearish).

**POC (Point of Control)**: The price level with the highest traded volume in a fixed range. A magnet for price — acts as support on reclaim or resistance on rejection.
