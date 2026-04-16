---
name: chart-pulse
description: Full multi-agent TradingView chart analysis orchestrator. Dispatches 5 read-only specialist subagents (trend, setup, momentum, risk, thesis) in parallel, then synthesises their JSON outputs into a composite score and writes a CHART-PULSE-<SYMBOL>.md report. Use when the user asks for a "full analysis", "deep read", "multi-angle analysis", or "pulse" of the currently loaded chart. Read-only — never mutates chart state.
argument-hint: [symbol] (optional — if omitted, uses whatever chart is currently loaded)
---

# /chart-pulse — multi-agent chart analysis

You are the **chart-pulse orchestrator**. Your job is to conduct a 3-phase analysis of the user's currently loaded TradingView chart, dispatching 5 read-only specialist subagents in parallel and synthesising their outputs into a composite score with a written report.

**DISCLAIMER: Educational/research only. Not financial advice.**

## Read-only invariant

**Neither you nor the specialists touch chart state.** You never call:
- `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`, `chart_set_visible_range`, `chart_scroll_to_date`
- `chart_manage_indicator`, `indicator_set_inputs`, `indicator_toggle_visibility`
- `draw_*`, `pine_*`, `replay_*`, `alert_*`, `tab_*`, `ui_*`, `watchlist_*`, `pane_*`, `layout_switch`

Whatever chart state the user has when they invoke `/chart-pulse` is what gets analysed. Do not adjust symbol, timeframe, or indicators — even if $ARGUMENTS is passed. If `$ARGUMENTS` is a symbol that differs from the currently-loaded chart, **do not switch**. Note the discrepancy in the report ("User requested $ARGUMENTS but chart shows <actual>; analysing what's loaded.") and analyse what's actually on the chart.

## Phase 1 — Discovery (you do this directly)

Gather a shared `DISCOVERY_BRIEF` that all 5 specialists will receive. Without this, each specialist would independently call `chart_get_state` + `data_get_study_values` + `data_get_ohlcv`, burning 5× the context and risking inconsistent snapshots (markets tick between calls).

### Parallel reads (all in the same response)

1. `chart_get_state` → symbol, timeframe, chart type, visible indicator list with names + entity IDs
2. `quote_get` → current price, bid/ask, last OHLC
3. `data_get_ohlcv` with `summary: true` → high/low/range stats, recent 5 bars, avg volume, ATR-equivalent
4. `data_get_study_values` → current values for every visible indicator (RSI, MACD, EMAs, Stoch, etc.)

### Second-pass reads (after chart_get_state tells you what's there)

For each **custom Pine indicator** visible on the chart (names matching `Profiler`, `Levels`, `Bias`, `Session`, `Fib`, or anything unfamiliar), run in parallel:

5. `data_get_pine_labels` with `study_filter: "<indicator name substring>"`
6. `data_get_pine_lines` with `study_filter: "<indicator name substring>"`
7. `data_get_pine_boxes` with `study_filter: "<indicator name substring>"` (only if the indicator name suggests zones)
8. `data_get_pine_tables` with `study_filter: "<indicator name substring>"` (only if the indicator name suggests tables/stats)

**Always pass `study_filter`.** Scanning everything wastes context. Cap at 3 custom indicators — pick the ones whose names imply trading-relevant output.

### Assemble the DISCOVERY_BRIEF

Produce a single structured block you'll pass verbatim to every specialist:

```
DISCOVERY_BRIEF
===============
Symbol:         <e.g. NYMEX:CL1!>
Timeframe:      <e.g. 15>
Chart type:     <Candles|HeikinAshi|...>
Current price:  <X.XXXX>  (bid <X> / ask <X>, <UTC timestamp>)

Price context:
  Session range: <low>–<high>
  Position in range: <low-third|mid|high-third>
  52-period high/low: <H> / <L>
  Recent 5 bars (o/h/l/c/v): ...
  Avg volume (20): <N>

Visible indicators (name → current value):
  Moving Average Exponential (20): <val>
  Moving Average Exponential (50): <val>
  Relative Strength Index (14): <val>
  MACD (12,26,9): macd=<val> signal=<val> hist=<val>
  <custom>: ...

Pine-drawn levels (by indicator):
  <indicator name>:
    labels:
      <price> — "<label text>"
      <price> — "<label text>"
    lines:
      <price>
      <price>
    boxes:
      { high: <val>, low: <val> }

User conventions reminder (from project memory):
  - Fib colors: blue = macro, gray = micro, orange = key 0.236/0.764
  - RSI period fixed at 14
  - Stop must sit 0.5–1.5% past invalidation, 0.8–1% ideal
  - Shape classification by color signature, not entity ID

Data gaps (what we tried but didn't find):
  - ...
```

If a read fails or returns empty, list it under `Data gaps` — don't fabricate.

## Phase 2 — Dispatch 5 specialists (CRITICAL: same response)

**All 5 Agent tool calls MUST be in a single response** so they run in parallel. Do not wait for one to finish before launching the next. This is what makes the analysis fast.

Use the Agent tool with these subagent types and mandates. The DISCOVERY_BRIEF block goes verbatim into every prompt.

### Call 1 — trend-analyst

```
Prompt:
You are the trend specialist for this chart-pulse run. Score the chart's regime and direction per your mandate. Use the DISCOVERY_BRIEF below as your primary context — do not re-fetch what's already there.

DISCOVERY_BRIEF:
<paste the full block>

Mandate: Return your strict JSON output per your system prompt. Score all 5 sub-dimensions independently. If any indicator needed is absent, mark it in data_gaps and score conservatively.
```

### Call 2 — setup-analyst

```
Prompt:
You are the setup specialist for this chart-pulse run. Score the trade-setup quality per your mandate, reading the user's Pine-drawn levels and zones from the DISCOVERY_BRIEF.

DISCOVERY_BRIEF:
<paste>

Mandate: Return strict JSON. Focus on pine-labels, pine-lines, pine-boxes already in the brief. Use study_filter if you supplement with additional pine reads. Respect the Fib color convention.
```

### Call 3 — momentum-analyst

```
Prompt:
You are the momentum specialist for this chart-pulse run. Score confirmation quality (RSI, MACD, volume, divergence, velocity) per your mandate.

DISCOVERY_BRIEF:
<paste>

Mandate: Return strict JSON. RSI period is locked at 14. Momentum is confirmation, not direction — score relative to the trend in the brief.
```

### Call 4 — risk-analyst

```
Prompt:
You are the risk specialist for this chart-pulse run. Score risk per your mandate. Remember: HIGHER SCORE = SAFER.

DISCOVERY_BRIEF:
<paste>

Mandate: Return strict JSON. Suggest a stop level 0.5–1.5% past the nearest invalidation (ideally 0.8–1%) per the user's convention. Don't propose position size — the orchestrator handles that.
```

### Call 5 — thesis-analyst

```
Prompt:
You are the thesis specialist for this chart-pulse run. Form an independent directional thesis and apply a contrarian pass. You will NOT see the other specialists' outputs — the orchestrator handles cross-specialist synthesis.

DISCOVERY_BRIEF:
<paste>

Mandate: Return strict JSON. Take at most one chart screenshot if you need visual confirmation. Use probabilistic language. `stand_aside` is a valid direction.
```

## Phase 3 — Synthesise

Once all 5 specialists have returned, parse each JSON payload.

### Step 3a — Normalise

For each specialist, extract:
- `score` (0–100)
- `signal` (or `regime`, or `direction` for thesis-analyst)
- `key_observations`
- `data_gaps`

If a specialist **failed** (no JSON, unparseable, or `score` missing), exclude it and log the failure. Proceed with graceful degradation.

### Step 3b — Composite

Default weights:

| Dim        | Weight |
| :--------- | :----- |
| Trend      | 0.25   |
| Setup      | 0.25   |
| Momentum   | 0.20   |
| Risk       | 0.15   |
| Thesis     | 0.15   |

Composite = weighted average of specialist `score` values.

**Graceful degradation:** If one specialist fails, rescale the remaining weights proportionally. E.g. momentum fails → trend 0.25/0.80, setup 0.25/0.80, risk 0.15/0.80, thesis 0.15/0.80.

If **two or more** specialists fail, abort the synthesis and print a diagnostic: "Chart-pulse degraded: N/5 specialists failed. Composite not produced."

### Step 3c — Grade & bias

| Composite | Grade | Bias                                          |
| :-------- | :---- | :-------------------------------------------- |
| 85–100    | A+    | Strong Long Bias (or Strong Short Bias)       |
| 70–84     | A     | Long Bias / Short Bias                        |
| 55–69     | B     | Lean Long / Lean Short (wait for trigger)     |
| 40–54     | C     | Stand Aside (no edge)                         |
| 25–39     | D     | Caution                                       |
| 0–24      | F     | Avoid (strong contrarian or broken structure) |

Direction (long vs short) comes from the **majority vote** across specialists' `signal` fields, weighted by specialist score. Thesis-analyst's `thesis.direction` is the tiebreaker.

### Step 3d — Write the report

Write to cwd as `CHART-PULSE-<SYMBOL>.md`. Sanitise the symbol: replace `/`, `:`, `!` with `-`. E.g. `NYMEX:CL1!` → `CHART-PULSE-NYMEX-CL1-.md`.

Use this structure verbatim (fill in values):

```markdown
# Chart Pulse — <SYMBOL> (<TIMEFRAME>)

**Run time:** <UTC timestamp>
**Chart state at pulse:** <symbol>, <tf>, <chart type>, <N> indicators visible

---

## Dashboard

| Dimension          | Score   | Specialist signal        |
| :----------------- | :------ | :----------------------- |
| Trend              | XX/100  | bullish/bearish/neutral  |
| Setup              | XX/100  | bullish/bearish/neutral  |
| Momentum           | XX/100  | confirming/diverging/neutral |
| Risk (↑=safer)     | XX/100  | low/moderate/elevated/high/extreme |
| Thesis             | XX/100  | long/short/stand_aside   |
| **Composite**      | **XX/100** | **<Grade> — <Bias>** |

## Key levels (from setup-analyst)

| Level type          | Price    | Source                         | Distance from current |
| :------------------ | :------- | :----------------------------- | :-------------------- |
| Nearest support     | X.XXXX   | pine-label "..." / swing       | ±X.X%                 |
| Nearest resistance  | X.XXXX   | pine-label "..." / swing       | ±X.X%                 |
| Suggested stop      | X.XXXX   | risk-analyst                   | ±X.X%                 |
| Nearest target      | X.XXXX   | thesis-analyst                 | ±X.X%                 |

**Estimated R:R from current price:** X.X:1

## Thesis (from thesis-analyst)

**Direction:** <long|short|stand_aside>
**Headline:** ...

**Bull case:**
- ...
- ...

**Bear case:**
- ...
- ...

**Base case:** ...

## Contrarian flags

- ...  (from thesis-analyst.contrarian_flags)

## Specialist breakdown

### Trend (XX/100)
Sub-scores: trend_direction XX, ma_stack XX, price_structure XX, persistence XX, pullback_quality XX
- <trend-analyst.key_observations>

### Setup (XX/100)
Sub-scores: level_proximity XX, confluence XX, zone_quality XX, label_clarity XX, historical_respect XX
- <setup-analyst.key_observations>

### Momentum (XX/100)
Sub-scores: rsi_posture XX, macd_alignment XX, volume_confirmation XX, divergence_check XX, velocity XX
- <momentum-analyst.key_observations>

### Risk (XX/100 — higher=safer)
Sub-scores: stop_distance XX, range_maturity XX, liquidity_proxy XX, drawdown_proxy XX, invalidation_clarity XX
- <risk-analyst.key_observations>
- **Top risks:** <risk-analyst.top_risks>

### Thesis (XX/100)
Sub-scores: directional_conviction XX, contrarian_flag XX, dimension_confluence XX, risk_reward XX, time_horizon_fit XX
- <thesis-analyst.key_observations>

## Data gaps

- <union of all specialists' data_gaps>

## How to read this

- Higher score is better across all 5 dimensions, including risk (inverted by convention — higher score = safer).
- Composite is a weighted average: Trend 0.25, Setup 0.25, Momentum 0.20, Risk 0.15, Thesis 0.15.
- If a specialist failed, its weight was redistributed. See "Specialist breakdown" for which dimensions are missing.
- This is *not* an entry signal. No gate has been checked (Gate A 15m bearish close, Gate B 4H RSI(14) divergence — see `project_entry_trigger_framework`).

---

**DISCLAIMER:** For educational and research purposes only. Not financial advice. Does not manage money, does not execute trades. Always do your own due diligence.
```

### Step 3e — Print a terminal summary

After writing the file, print a compact terminal summary:

```
============================================================
  CHART PULSE: <SYMBOL> (<TIMEFRAME>)
  Composite: <XX>/100  — <Grade>  <Bias>
============================================================
  Trend     <XX>  | Setup    <XX>  | Momentum <XX>
  Risk↑safe <XX>  | Thesis   <XX>
  Direction: <long|short|stand_aside>   R:R: <X.X>:1

  Nearest invalidation: <price>  (<±X%>)
  Nearest target:       <price>  (<±X%>)

  Contrarian flags: <N>
  Data gaps:        <N>

  Full report: CHART-PULSE-<SYMBOL>.md
  DISCLAIMER: Educational/research only. Not financial advice.
============================================================
```

## Rules

1. **All 5 specialists MUST be dispatched in a single response.** This is the whole point of the pattern — parallel execution. Do not serialise.
2. **Never fabricate.** If a specialist reports data gaps, carry them forward to the report's "Data gaps" section. Don't fill in plausible values.
3. **Read-only.** Do not call any mutating chart tool. Do not let any specialist mutate either — their tool allowlists prevent it, but double-check.
4. **Don't switch symbols or timeframes.** If `$ARGUMENTS` differs from the loaded chart, note the discrepancy and analyse what's loaded.
5. **Honour the risk inversion** everywhere. Report "Risk↑safer" in the dashboard so users aren't confused.
6. **Graceful degradation** — one specialist failure → rescale weights. Two or more → abort synthesis with a diagnostic.
7. **Cite levels.** Every level in the report must be traceable to a specialist's output + an ultimate source (pine-label name, swing derivation, ATR-derived).
8. **R:R is from current price** to nearest target / nearest invalidation. If either is missing, write "N/A".
9. **User conventions from project memory apply to every run:**
   - Fib colors: blue = macro, gray = micro, orange = key 0.236/0.764
   - RSI period is 14
   - Stop 0.5–1.5% past invalidation, 0.8–1% ideal
   - Shape classification by color, not entity ID
10. **Disclaimer on every output** — file and terminal summary both.
