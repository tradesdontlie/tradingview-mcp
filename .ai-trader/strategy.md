# AI Chart Copilot — Strategy Layer

## Scope
Manual signal assistant for: MNQ1!, NQ1!, ES1!, MES1!, MGC1!, GC1!
Output: LONG / SHORT / WAIT — no auto-execution.

## Data Hierarchy
1. Raw OHLCV (primary truth)
2. Structured indicator values (supporting)
3. Pine labels / lines / boxes / tables (key levels, bias, session stats)
4. Screenshot (visual confirmation only — never primary signal source)

## Playbooks

### 1. Opening Range Breakout Retest Continuation
- Mark OR high/low from first 30m (or 15m on micro contracts)
- Wait for clean breakout beyond OR level with momentum
- Look for retest of broken level holding as S/R
- Entry on retest confirmation candle (1m)
- Stop below/above retest wick
- TP1: next structure level; TP2: session extreme or HTF target

### 2. HTF Liquidity Sweep + FVG Reversal
- Identify prior day high/low or session extreme as liquidity pool
- Watch for sweep (wick through level) that immediately rejects
- Confirm FVG or iFVG on 5m within sweep zone
- Entry inside FVG on 1m confirmation
- Stop beyond sweep wick
- TP1: opposing session level; TP2: VWAP or HTF FVG fill

## Market Context Checklist
- [ ] Prior day high / prior day low
- [ ] Asia session high/low
- [ ] London session high/low
- [ ] New York session high/low
- [ ] VWAP (current day)
- [ ] Opening range high/low
- [ ] HTF FVG / iFVG / ERL from OLDTBPo3 or equivalent
- [ ] 15m trend direction
- [ ] 5m trend direction
- [ ] 1m execution confirmation
- [ ] Fixed range volume profile (if visible)

## Execution Timeframes
| Purpose | Timeframe |
|---------|-----------|
| HTF Bias | 15m |
| Setup | 5m |
| Entry trigger | 1m |

## Scoring (not a gate — a weight)
| Factor | Weight |
|--------|--------|
| HTF alignment | High |
| FVG / structural confluence | High |
| Liquidity swept | High |
| VWAP position | Medium |
| Volume confirmation | Medium |
| Orderflow direction | Medium (conflict lowers confidence, does not block) |
| OR context | Medium |
| News / macro risk | High negative weight |

Confidence: HIGH / MEDIUM / LOW — based on total weight sum.
WAIT is valid when setup is forming but trigger is not yet met.
