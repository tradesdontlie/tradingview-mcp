# Implementation Plan — Futures AI Chart Copilot

MTF Session Liquidity Trap Scalper for MNQ1! / MES1!
Workflow: Research → Backtest → Incubate → Paper Trade → (optional) Live

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 0 — Audit | Complete | Repo structure mapped, existing files understood |
| 1 — Foundations | Complete | rules.json, strategy.md, risk-rules.md, prompt templates updated |
| 2 — Engine Skeleton | Pending | Individual engine modules, no live connection required |
| 3 — Strategy + Risk Layer | Pending | Orchestrator, risk manager, signal journal |
| 4 — Unit Tests | Pending | Five required test cases from brief |
| 5 — Backtest | Pending | No-lookahead simulator + metrics |
| 6 — Paper Journal | Pending | 2–4 weeks replay/paper before any live consideration |

---

## Phase 2 — Engine Skeleton

Do not modify `src/`. Create new `engines/` directory at repo root.

### engines/biasEngine.js

**Input**: OHLCV arrays per timeframe (4H, 1H, 15m, 5m)
**Output**: `{ "4H": "bullish"|"bearish"|"neutral", "1H": ..., "15m": ..., "5m": ..., "permission": "long"|"short"|"none" }`

Logic:
- Determine swing highs and swing lows using a rolling N-bar pivot
- Bullish: higher highs and higher lows on that timeframe
- Bearish: lower highs and lower lows
- Neutral: no clean sequence
- Permission: long only if 4H+1H both bullish or neutral-bullish; short if both bearish or neutral-bearish; none if conflict

### engines/sessionEngine.js

**Input**: OHLCV with timestamps, session timezone config
**Output**: `{ asia: { high, low, poc }, london: { high, low, poc }, ny: { open_range_high, open_range_low }, prior_day: { high, low } }`

Logic:
- Asia: 18:00–00:00 ET (or per CME Globex schedule)
- London: 02:00–08:00 ET
- NY open range: 09:30–10:00 ET (first 30 bars on 1m)
- Prior day: previous RTH session high and low
- POC: volume-weighted most-traded price within session candles (approximate)

### engines/liquidityEngine.js

**Input**: OHLCV + session levels from sessionEngine
**Output**: `{ sweep_detected: bool, sweep_type: "low"|"high"|null, swept_level: price|null, sweep_candle_index: int|null, reclaim_detected: bool, reclaim_candle_count: int|null }`

Logic:
- Sweep: a candle's low wicks below a session level AND closes back above it, OR the next candle closes back above
- Reclaim: within `signal_expiry_candles` of sweep, a close back on the correct side
- Track which specific level was swept (Asia low, London low, etc.)

### engines/structureEngine.js

**Input**: OHLCV (5m focus, with 15m context)
**Output**: `{ swing_highs: [price, ...], swing_lows: [price, ...], mss_detected: bool, mss_direction: "bullish"|"bearish"|null, choch_detected: bool, displacement_candle: { index, body_size, volume, direction }|null }`

Logic:
- Swing pivots: N-bar lookback (default 5)
- Bullish MSS: after sweep low, price makes a higher high breaking prior lower-high structure
- Bearish MSS: after sweep high, price makes a lower low breaking prior higher-low structure
- CHoCH: first bar that breaks the opposing structural point after the sweep
- Displacement: candle body > 1.5x average body of last 10 candles AND volume > 1.5x average volume

### engines/volumeEngine.js

**Input**: OHLCV with volume
**Output**: `{ volume_surge: bool, surge_ratio: float, poc: price|null, vah: price|null, val: price|null, delta_approx: "positive"|"negative"|"neutral" }`

Logic:
- Volume surge: current bar volume > N-bar average * surge_threshold (default 1.5x)
- POC: bar with highest volume in a rolling fixed-range window (approximate, not true market profile)
- VAH/VAL: price levels enclosing 70% of volume above/below POC
- Delta approximation: tick-rule (up-close bar = buy delta, down-close bar = sell delta) — note this is an approximation, not true order flow

### engines/regimeEngine.js (Phase 5+, placeholder only)

**Input**: OHLCV history (200+ bars)
**Output**: `{ regime: "trending"|"ranging"|"volatile"|"unknown" }`

Logic: Markov/HMM-style classification based on ATR, ADX, and return autocorrelation. Do not build in Phase 2. Stub only.

---

## Phase 3 — Strategy + Risk Layer

### strategies/mtfSessionLiquidityTrap.js

**Input**: Output objects from all five engines
**Output**: Full signal object (see signal schema below)

Logic:
1. Check biasEngine permission — if "none", return WAIT
2. Check liquidityEngine sweep_detected — if false, return WAIT
3. Check liquidityEngine reclaim_detected — if false, return WAIT
4. Check structureEngine mss_detected — if false, return WAIT
5. Check structureEngine displacement_candle — if null, return WAIT
6. Score confluence using confluenceScorer (see below)
7. Pass to riskManager — if rejected, return WAIT with rejection reason
8. Return full signal object

### strategies/confluenceScorer.js

**Input**: All engine outputs
**Output**: `{ grade: "A+"|"A"|"B"|"C"|"Reject", score: int, factors: [...] }`

Logic: Weighted factor sum based on rules.json confidence_grades conditions. Returns grade that maps to rules.json.

### risk/riskManager.js

**Input**: Proposed signal object
**Output**: `{ approved: bool, rejection_reason: string|null, adjusted_signal: signal|null }`

Logic: Checks every rejection trigger in rules.json confidence_grades Reject conditions. Also validates: stop width, R:R floor, news lockout, daily trade count, daily loss limit, duplicate check.

### journal/signalJournal.js

**Input**: Signal object (approved or rejected)
**Output**: Writes one line to `.ai-trader/signal-log.jsonl`

Logic: Append-only JSONL. Never delete entries. Log both approved signals and rejections with reason. Accepted signals get status "pending"; update to "filled"/"stopped"/"expired" on resolution.

---

## Phase 4 — Unit Tests

Required test cases (minimum). Add to `tests/strategy.test.js`:

1. **Bullish sweep + reclaim + MSS = LONG candidate**
   - 4H bullish, 1H bullish, Asia low swept, reclaim within 3 candles, 5m bullish MSS confirmed
   - Expected: Decision = LONG, Confidence ≥ A

2. **Bearish sweep + reclaim + MSS = SHORT candidate**
   - 4H bearish, 1H bearish, London high swept, reclaim within 3 candles, 5m bearish MSS confirmed
   - Expected: Decision = SHORT, Confidence ≥ A

3. **Mixed MTF bias = WAIT unless A+**
   - 4H bullish, 1H bearish — conflict
   - Expected: Decision = WAIT, rejection reason includes "HTF conflict"

4. **Risk manager rejects wide stop**
   - Valid sweep + reclaim + MSS, but stop width exceeds max_stop_ticks
   - Expected: approved = false, rejection_reason includes "stop_too_wide"

5. **Signal expires after 3 candles**
   - Valid setup at candle 0, no entry fill by candle 4
   - Expected: status updated to "expired", no new signal issued

---

## Phase 5 — Backtest Validation Requirements

Do not paper trade until all of these pass:

- At least 100 trades per tested variant where possible
- No lookahead bias (evaluate only information available at signal bar close)
- No same-bar impossible fills (entry fill uses next bar open, not signal bar close)
- Commission + slippage per side per MNQ/MES specification
- Out-of-sample / walk-forward split (train on 2021–2023, test on 2024–2025)
- Metrics reported by: setup grade, hour of day, session (Asia/London/NY), direction, market regime
- No single day or single event creates majority of profit
- Primary instrument: MNQ1! — validate first before touching MES1!
- Compare RTH first 2 hours vs full session performance separately

---

## Signal Schema (JSONL)

Every logged signal must include all of these fields:

```
{
  "id": "ISO timestamp + symbol",
  "timestamp": "ISO 8601",
  "date": "YYYY-MM-DD",
  "time": "HH:MM ET",
  "symbol": "MNQ1! | MES1!",
  "decision": "LONG | SHORT | WAIT",
  "bias": { "4H": "Bullish|Bearish|Neutral", "1H": "...", "15m": "..." },
  "setup": "MTF Session Liquidity Trap",
  "entry": null | price,
  "stop": null | price,
  "tp1": null | price,
  "tp2": null | price,
  "r": null | float,
  "confidence": "A+ | A | B | C | Reject",
  "reasons": ["..."],
  "invalidation": ["..."],
  "what_would_change": "...",
  "status": "pending | filled | stopped | expired | target1 | target2",
  "outcome_r": null | float
}
```

---

## What Must Never Happen

- No live order execution in v0.1 — manual execution only
- No editing `src/` without explicit user permission
- No lookahead bias in the backtester
- No same-bar impossible fills
- No trusting a backtest result before independent walk-forward validation
- No averaging down
- No signals without defined stop and target
- No live trading before 4+ weeks of paper journal with positive expectancy
