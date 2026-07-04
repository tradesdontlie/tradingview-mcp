# Trading Session Context
_Last updated: 2026-05-08_

## Environment
- TradingView MCP integration via CDP (port 9222)
- All tools confirmed working: `tv_health_check`, `chart_get_state`, `data_get_study_values`, `data_get_ohlcv`, `data_get_pine_lines/labels/boxes/tables`, `capture_screenshot`, `chart_set_symbol/timeframe`
- Screenshots saved to `screenshots/`

## Active Indicators (per chart)
Two indicator setups observed depending on symbol:

**Setup A (TSLA, QQQ):**
- 20 EMA Daytrading Strategy (plots EMA 20, Long/Short signals)
- Order Blocks & Breaker Blocks [LuxAlgo]
- Leledc Exhaustion Bar (fires at exhaustion highs/lows)
- Volume Weighted Average Price (VWAP)
- CPR Indicator → outputs **Weekly** levels: Pivot, BC, TC, R1–R4, S1–S4, Prev Week High/Low
- Volume

**Setup B (MSFT, CRWV):**
- 3MA's + KAMA Cross: EMA(20), MA(50), MA(200), Fast KAMA, Slow KAMA
- CPR Breakout DEBUG: outputs **Daily** levels: PDH, PDL, TC, BC, R1, S1 + CALL/PUT Final signals
- Average True Range (ATR)
- Volume

## Trading Rules (rules.md — CPR-based)
| Condition | Action | Key Confirmation |
|---|---|---|
| PDH/R1 broken with volume | Call | Price > rising EMA 20 |
| PDL/S1 broken with volume | Put | Price < falling EMA 20 |
| Opens above CPR | Bullish bias | Long near VWAP/TC/R1 |
| Opens below CPR | Bearish bias | Short near VWAP/BC/S1 |
| Opens inside CPR | Wait | Trade breakout of CPR + EMA confirm |
| Rejects TC (wick/pin) | Put | EMA above price |
| Rejects BC (wick/pin) | Call | EMA below price |
| Breaks CPR from below | Call | Entry above TC, SL below CPR |
| Breaks CPR from above | Put | Entry below BC, SL above CPR |
| Narrow CPR + break R1 | Call | Trail with R2/R3 |
| Narrow CPR + break S1 | Put | Add RSI/MACD confluence |
| Price re-enters CPR post-breakout | Reverse (fakeout) | EMA slope flip |
| CPR + VWAP aligned | Trade with trend | Strongest signal |

**EMA 20 is required for every rule. No EMA = reduced conviction.**

## Strategy Fit
**0DTE works best** with this integration:
- CPR/VWAP reset daily → intraday tools, not swing
- 5m signal timing matches 0DTE gamma windows
- Use MCP for direction + timing; execute in broker (need options chain separately for strike/IV)

## Analyses Completed (2026-05-07/08)

### TSLA (2026-05-07) — SHORT BIAS ✅
- ATH area $415.83 rejected; Leledc Exhaustion fired on **Daily** at exact high
- Weekly R1 ($404.42) rejected → flipped resistance
- 1H EMA crossed bearish in real time
- Distribution volume: 3.9M on 4H spike (2.3× avg)
- **Setup:** Short $404–$406 retest | Stop $408.50 | TP1 $398 | TP2 $393.59 | RR 2:1–3.3:1
- **Invalidation:** 1H close above $409.62

### MSFT (2026-05-07) — NO TRADE
- Missing EMA 20 on chart (Setup A not active for MSFT at that time)
- Price below VWAP, consolidating after big intraday move
- No clean CPR signal in either direction
- **Wait for:** Dip to Daily R1 ($419.89) with bounce confirmation for long

### MSFT $430 Call 05/15 (2026-05-08) — AVOID
- Price: $416.70 (gapped below PDL $418.76)
- Strike $430 = $13.30 away (3.2%) with 5 trading days
- 7 resistance layers between price and strike: EMA 20 → PDL → CPR → R1 → PDH
- Daily ATR: $10.93 (capacity exists but direction is wrong)
- **Only valid if:** MSFT reclaims BC ($421.64) on 1H close with volume
- **Stop if holding:** Break below today's low $414.36

### QQQ (2026-05-07) — NO TRADE
- Price $694.60, barely above Daily TC ($694.25), below VWAP ($696.06)
- Last 5m bar: 220K volume (4.2× avg) bearish rejection at PDH/VWAP
- EMA 20 not active on chart → can't confirm any rule
- **Wait for:** 5m close below $694.25 (Put) OR reclaim $696.06 VWAP with volume (Call)

### CRWV (2026-05-08) — PUT ✅ (active analysis)
- **Context:** Recent IPO, rallied $63.80 → $138.25 ATH (116%)
- **Blow-off top confirmed:** ATH $138.25 (May 7), then:
  - Thu May 7: Distribution candle, 41.4M vol (highest), closed $128.84
  - Today May 8: Gapped -$10.38, crashed to $111.68, sitting ~$112.67
- **All EMAs bearish:** 5m EMA $114.48, 1H EMA $125.29, Daily EMA $115.04 — all above price
- **ATR:** Daily $9.43, 1H $3.52
- **Key levels:**
  - Resistance: $114.48 (5m EMA) → $115.04 (daily EMA) → $124.98 (S1) → $125.43 (PDL)
  - Support: $111.68 (today's low) → $107.18 (1H MA200) → $100.35 (Daily MA200) → $101 (50% retrace)
- **Recommended contract:** CRWV May 16 $110 Put
  - Entry: Bounce toward $114–$115 (5m/daily EMA)
  - Stop: 1H close above $117
  - TP1: $107.18 (1H MA200) — take 60%
  - TP2: $100–$103 (daily MA200 / 50% retrace)
  - Invalidation: Price reclaims $117 on 1H

## Key Reusable Levels (as of 2026-05-08)
| Symbol | Critical Level | Role |
|---|---|---|
| TSLA | $404.42 | Weekly R1 (resistance) |
| TSLA | $397.82–$397.90 | VWAP cluster / PDH (major support target) |
| TSLA | $393.59 | 4H EMA 20 |
| MSFT | $421.64 | CPR BC (reclaim = bullish flip) |
| MSFT | $414.36 | Today's low (stop anchor) |
| QQQ | $694.25 | Daily TC (break = put signal) |
| QQQ | $696.06 | VWAP (reclaim = call signal) |
| QQQ | $698.97 | Daily R1 (call target) |
| CRWV | $114.48 | 5m EMA (short entry on bounce) |
| CRWV | $111.68 | Today's low |
| CRWV | $107.18 | 1H MA200 (put target 1) |
| CRWV | $100.35 | Daily MA200 (put target 2) |

## Workflow for New Session
1. `tv_health_check` → confirm connection
2. `chart_get_state` → get active indicators + entity IDs
3. `chart_set_symbol` → target asset
4. 1H: `data_get_study_values` → CPR levels, EMA, VWAP (bias)
5. 5m: `data_get_study_values` + `data_get_ohlcv summary:true` → entry signal
6. Check price vs TC/BC/PDH/PDL/EMA → apply rules.md
7. `capture_screenshot` for visual confirmation
8. If Setup A missing EMA → reduced confidence, wait for cleaner signal
