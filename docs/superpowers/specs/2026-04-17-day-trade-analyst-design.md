# Day-Trade Analyst — Design Spec

**Date:** 2026-04-17
**Topic:** Refactor `/chart-pulse` into a top-down day-trading analyst pipeline
**Status:** Approved for implementation planning
**Supersedes:** Current `/chart-pulse` implementation (same-day, earlier session)
**Related memories:** `project_bot_design`, `project_bot_architecture_direction`, `user_chart_conventions`, `feedback_stop_outside_sweep_zone`, `project_entry_trigger_framework`, `feedback_rr_decay_pattern`, `project_instrument_stack`, `project_fib_research_findings`

---

## 1. Summary

`/chart-pulse` is refactored from a horizontal 5-dimension analyst (trend / setup / momentum / risk / thesis) into a top-down day-trading pipeline: **one orchestrator skill** (acting as both W/D macro specialist and coordinator) cascades constraints down to **two read-only specialist subagents** (4H structure, 15m trigger). Output: a human-readable markdown report and a JSON sidecar the bot consumes on its own loop.

Key design axes (locked during the brainstorm that produced this spec):

- Replace `/chart-pulse` in place (not a sibling skill)
- Two specialists at 4H and 15m; orchestrator carries the W/D macro role with Elliott as advisory
- Strictly serial cascade: W/D → 4H → 15m
- On-demand invocation only (no scheduler in this iteration)
- Output: regions + 15m setup hints (entry, stop, target, conditions)
- Always emit full output with `composite_confidence` 0–100 — downstream gates deterministically
- Single-symbol per run

The new invariant: the orchestrator *may* mutate chart state during analysis (add MAs, draw Fibs, switch TF) but **must** restore original chart state on return, success or fail.

---

## 2. Motivation

The first `/chart-pulse` was built in hours and patterned after fibwise-trading-claude's horizontal fundamental-analysis decomposition. It doesn't match this project's day-trading focus:

- Elliott / Fibonacci / Price Action are central; "fundamental" dimensions are irrelevant.
- Day-trading is top-down by nature — you establish W/D macro, then find 4H structure, then trigger on 15m.
- The downstream bot needs a per-session playbook, not a general-purpose multi-dimensional read.

The refactor mirrors how professional day-traders actually reason: macro-first constraint propagation, with the 15m trigger layer producing cheap-stop setups ready for the bot's gate engine.

---

## 3. Architecture at a glance

```
   /chart-pulse  (user invokes against the loaded chart)
                     │
   ┌─────────────────▼─────────────────────────────┐
   │  ORCHESTRATOR — macro specialist + coordinator │
   │  Methods:  Price Action + Fibonacci +          │
   │            Elliott (advisory)                  │
   │  TFs:      Weekly + Daily                      │
   │  Mutation: YES (add/remove indicators, draw,   │
   │            switch TF; must restore on return)  │
   └─────────────────┬─────────────────────────────┘
                     │  MACRO_BRIEF
                     ▼
   ┌───────────────────────────────────────────────┐
   │  4H STRUCTURE SPECIALIST                       │
   │  Methods:  Price Action + Fibonacci            │
   │  TF:       4H only                             │
   │  Mutation: NONE (read-only tool allowlist)     │
   │  Emits:    watch zones for 15m                 │
   └─────────────────┬─────────────────────────────┘
                     │  MACRO_BRIEF + 4H_BRIEF
                     ▼
   ┌───────────────────────────────────────────────┐
   │  15m TRIGGER SPECIALIST                        │
   │  Methods:  Price Action + momentum             │
   │  TF:       15m only                            │
   │  Mutation: NONE (read-only tool allowlist)     │
   │  Emits:    setup hints per watch zone          │
   └─────────────────┬─────────────────────────────┘
                     │
                     ▼
   ┌───────────────────────────────────────────────┐
   │  ORCHESTRATOR — synthesis + restore            │
   │  Writes:   CHART-PULSE-<SYMBOL>.md             │
   │            pulse-<SYMBOL>.json                 │
   │  Restores: chart state to snapshot             │
   └───────────────────────────────────────────────┘
                     │
                     ▼
           (bot consumes JSON sidecar
            on its own fast loop)
```

---

## 4. Invariants

### 4.1 Snapshot → analyze → restore

The orchestrator can mutate chart state during analysis; the two specialists cannot. On return (success OR error), the chart must match its pre-run state.

Four-phase contract:

| Phase | Actor | Permitted operations |
| :--- | :--- | :--- |
| 0 — Snapshot | Orchestrator | `chart_get_state`, `draw_list`. Store symbol, timeframe, chartType, study_ids[], drawing_ids[]. |
| 1 — Analyze (macro) | Orchestrator | All reads + mutations. Switch TF, add indicators/drawings, read, analyze W/D. Track every added entity in `ADDITIONS`. |
| 2 — Dispatch cascade | Orchestrator → specialists | Orchestrator switches TF (4H, then 15m) and dispatches. Specialists read-only only. |
| 3 — Synthesis | Orchestrator | Parse specialist JSONs, compute composite, write artifacts. No chart mutation. |
| 4 — Restore | Orchestrator | **ALWAYS runs, even on error in 1–3.** Remove every entity in `ADDITIONS`. Restore symbol, timeframe, chartType. Re-read state; diff against snapshot; flag drift in output. |

### 4.2 Cascade strictly serial

4H cannot start until the macro read is complete. 15m cannot start until 4H returns. This is the whole point of top-down: each downstream stage operates inside constraints its parent established.

Wall-clock budget: ~60–90s end-to-end (up from the old ~30–40s because of mutation+restore cost).

### 4.3 Single-symbol, single-run

One invocation analyses one symbol. Multi-symbol is a future wrapper skill concern.

### 4.4 Player-coach orchestrator

W/D macro analysis happens inside the orchestrator turn, not as a separate subagent. Elliott context stays unified.

### 4.5 Horizontal → vertical

Old trend/setup/momentum/risk/thesis dimensions don't vanish — they fold into each TF specialist's single mandate (4H specialist does 4H trend + 4H structure + 4H momentum + 4H invalidation within one return).

---

## 5. The three roles

### 5.1 Orchestrator

**File:** `.claude/skills/chart-pulse/SKILL.md` (rewrite in place)
**Form:** Skill body (not a subagent). Player-coach.

**Methods:** Price Action + Fibonacci + Elliott (advisory).
**Timeframes:** Weekly + Daily.
**Tool surface:** Full. All MCP reads + `chart_set_*`, `chart_manage_indicator`, `indicator_set_inputs`, `draw_*`.

**Responsibilities:**

- Phase 0: snapshot chart state.
- Phase 1: switch to W, read; switch to D, read. Add MAs and Fib retracement if not already on chart (track every addition for restore). Assess W regime, D regime, directional bias, key macro levels, Fib anchors.
- Identify **stronger trend** — long bias / short bias / stand_aside — with `macro_confidence` 0–100.
- Note Elliott wave position as **advisory narrative** (markdown only, not JSON).
- Build `MACRO_BRIEF` (see §6.1).
- Phase 2 dispatch cascade: switch to 4H → dispatch 4H specialist → await JSON. Switch to 15m → dispatch 15m specialist → await JSON.
- Phase 3 synthesis: compute composite confidence, write artifacts.
- Phase 4 restore.

**What the orchestrator does NOT do:**

- Compute 15m-specific entries, stops, or R:R.
- Score momentum / risk / thesis as separate numeric axes.
- Generate watch zones or setup hints itself.

### 5.2 4H Structure Specialist

**File:** `.claude/agents/structure-4h.md`
**Form:** Subagent.

**Methods:** Price Action + Fibonacci.
**Timeframe:** 4H only.
**Tool surface:** read-only — `chart_get_state`, `data_get_ohlcv`, `data_get_study_values`, `data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_boxes`, `data_get_pine_tables`, `quote_get`. **No mutation tools.**
**Model:** sonnet.

**Responsibilities:**

- Receive `MACRO_BRIEF` verbatim. Never re-derive macro data.
- Read 4H chart state. The orchestrator has already switched the chart's timeframe to 4H and added any indicators needed for macro analysis (which remain visible, carrying into 4H); no preparation step is the specialist's responsibility.
- Identify 4H structure: HH/HL/LH/LL sequence, trend strength, key swing levels.
- Pull 4H-specific levels: swing highs/lows, Fib retracement/extension on most recent 4H impulse, visible Pine-drawn levels.
- **Primary output:** a list of 2–4 **watch zones** (see §6.2).
- Assign `4h_confidence` 0–100 — strength of 4H structure's agreement with macro direction.

**What it does NOT do:**

- Any chart mutation.
- TF switching.
- Entry / stop / target / R:R computation.
- Elliott wave counting.
- Setups against macro direction (unless an explicit contrarian flag is warranted).

### 5.3 15m Trigger Specialist

**File:** `.claude/agents/trigger-15m.md`
**Form:** Subagent.

**Methods:** Price Action + momentum (RSI, MACD, volume).
**Timeframe:** 15m only.
**Tool surface:** read-only — same allowlist as 5.2.
**Model:** sonnet.

**Responsibilities:**

- Receive `MACRO_BRIEF` + `4H_BRIEF` verbatim.
- Read 15m chart state. The orchestrator has already switched the chart's timeframe to 15m.
- For each watch zone from 4H, produce a **setup hint** (see §6.3) with entry zone, stop, target, R:R, explicit trigger conditions, invalidation.
- Assign `15m_confidence` 0–100 overall.
- If no watch zone has a tradable setup right now, emit `setup_hints: []` with a reason.

**What it does NOT do:**

- Invent new levels (only triggers within 4H's watch zones).
- Chart mutation.
- Generate setups against macro direction (contrarian flags only).
- Make the entry decision — emits *hints*; the bot's gates decide.

### 5.4 Constraints and cascade discipline

Each downstream stage is given a constrained problem by the stage above it. This is the whole point of top-down:

- Orchestrator hands 4H a direction. 4H only generates watch zones consistent with it.
- 4H hands 15m a list of zones. 15m only produces triggers within those zones.

Stages that want to contradict their parent must use `contrarian_flags` (see §7.2), not override silently.

---

## 6. Handoff contracts

### 6.1 MACRO_BRIEF (orchestrator → 4H specialist)

Passed as a verbatim text block in the 4H specialist's dispatch prompt.

```
MACRO_BRIEF
===========
Symbol:        <SYMBOL>
Generated:     <ISO UTC>

Direction:     long | short | stand_aside
Macro confidence: 0-100

Regime:
  W: trending_up | trending_down | ranging | transitional
  D: trending_up | trending_down | ranging | transitional

Key macro levels:
  - W swing high: <price>
  - W swing low:  <price>
  - D swing high: <price>
  - D swing low:  <price>
  - D 200 EMA:    <price>  (if present)
  - Other:        ...

Fib anchors:
  - D: high <price>, low <price>, current retrace <ratio>
       levels: 0.236 <p>, 0.382 <p>, 0.5 <p>, 0.618 <p>, 0.786 <p>
       extensions: 1.272 <p>, 1.618 <p>

Elliott advisory:
  <free-text narrative — orchestrator's read of wave position on W/D,
   may be empty. Not bot-consumable.>

Constraints for 4H:
  - Watch zones must align with macro direction.
  - Contrarian setups require explicit contrarian_flag.

Data gaps:
  - ...
```

### 6.2 Watch zone (4H → 15m)

Element of `4H_BRIEF.watch_zones[]`:

```
{
  "id":            "zone_1",          // stable identifier within this pulse
  "center_price":  76045,
  "kind":          "pullback" | "breakout" | "reversal",
  "direction":     "long" | "short",
  "source":        "4H Fib 0.382 @ 76045 + prior swing low confluence",
  "priority":      0-100               // 4H's own quality score for this zone
}
```

Plus the full 4H_BRIEF payload with 4h_regime, 4h_confidence, 4H key_levels, Fib analysis. 15m specialist receives the full 4H_BRIEF verbatim.

### 6.3 Setup hint (15m output element)

Element of `trigger_15m.setup_hints[]`:

```
{
  "watch_zone_ref":     "zone_1",     // links back to 4H
  "direction":          "long" | "short",
  "entry_zone":         { "low": 75950, "high": 76100 },
  "stop":               75545,
  "stop_distance_pct":  0.66,
  "target_primary":     76900,
  "target_stretch":     77500,
  "rr_primary":         1.76,
  "rr_stretch":         2.96,
  "trigger_conditions": [ "15m close above 76100",
                          "RSI(14) > 50",
                          "volume > 1.1x 20-bar avg" ],
  "invalidation":       "15m close below 75700",
  "quality":            0-100
}
```

Stop placement follows `feedback_stop_outside_sweep_zone`: 0.5–1.5% past invalidation, ideally 0.8–1%. R:R_primary must be ≥ 2.0 per `feedback_rr_decay_pattern` or the setup is auto-flagged `contrarian_flags: rr_below_floor` with `severity: block`.

`trigger_conditions` follow a small parseable grammar so the bot evaluates them deterministically:

- `<TF> close above|below <PRICE>` (e.g., `"15m close above 76100"`)
- `RSI(<PERIOD>) <op> <NUMBER>` where op ∈ `>`, `<`, `>=`, `<=` (PERIOD defaults to 14 per `project_entry_trigger_framework`)
- `MACD <op> signal` where op ∈ `>`, `<`, `crosses`
- `volume <op> <MULTIPLIER>x <WINDOW>-bar avg` (e.g., `"volume > 1.1x 20-bar avg"`)
- `divergence on <OSCILLATOR> <direction>` where OSCILLATOR ∈ `RSI`, `MACD`, `Stochastic` and direction ∈ `bullish`, `bearish` (e.g., `"divergence on RSI bullish"`)

Any condition the bot's parser cannot handle → setup is vetoed. Grammar evolves in lockstep with the bot's parser; grammar version tracked in `schema`.

---

## 7. Artifact contract

### 7.1 Files

- **Location:** `./pulses/` (under project cwd, which is `tradingview-mcp`).
- **Markdown:** `CHART-PULSE-<SANITIZED_SYMBOL>.md`
- **JSON sidecar:** `pulse-<SANITIZED_SYMBOL>.json`
- Symbol sanitisation: replace `/`, `:`, `!`, `.` with `-`. `BITGET:BTCUSDT.P` → `BITGET-BTCUSDT-P`.
- Each run overwrites the previous pair for that symbol.
- `.gitignore` gets `pulses/` (remove earlier `CHART-PULSE-*.md` line).

### 7.2 JSON schema (`chart-pulse.v1`)

```jsonc
{
  "schema":        "chart-pulse.v1",
  "symbol":        "BITGET:BTCUSDT.P",
  "generated_at":  "2026-04-17T14:30:00Z",   // ISO UTC
  "valid_until":   "2026-04-18T14:30:00Z",   // 24h TTL

  "composite": {
    "direction":            "long" | "short" | "stand_aside",
    "composite_confidence": 0-100,            // bot's primary gate
    "summary":              "one-sentence read"
  },

  "macro": {
    "direction":        "long" | "short" | "stand_aside",
    "macro_confidence": 0-100,
    "w_regime":         "trending_up|trending_down|ranging|transitional",
    "d_regime":         "trending_up|trending_down|ranging|transitional",
    "key_levels":       [{ "price": number, "kind": string, "strength": 0-100 }],
    "fib_anchors":      [{ "tf": "W"|"D", "high": number, "low": number,
                           "levels": { "0.236": number, ... } }]
    // elliott narrative is NOT in JSON — markdown only
  },

  "structure_4h": {
    "regime":         "trending_up|trending_down|ranging",
    "4h_confidence":  0-100,                  // null if stage failed
    "key_levels":     [{ "price": number, "kind": string, "source": string, "strength": 0-100 }],
    "fib_analysis":   { "anchor_high": number, "anchor_low": number,
                        "current_retrace": number,
                        "key_ratios": { "0.236": number, ... } },
    "watch_zones":    [ { ...§6.2... } ]
  },

  "trigger_15m": {
    "15m_confidence": 0-100,                  // null if stage failed
    "setup_hints":    [ { ...§6.3... } ]
  },

  "contrarian_flags": [
    { "flag": string, "source": string, "severity": "warn"|"block" }
  ],

  "data_gaps": [ "string description", ... ],

  "restore": {
    "performed":      true|false,
    "drift_detected": true|false,
    "notes":          ""                       // populated if drift_detected
  },

  "disclaimer": "Educational/research only. Not financial advice."
}
```

**Gating rules the bot must honour:**

- `composite_confidence >= 60` → fire eligible; `>= 75` → size up eligible.
- Any `contrarian_flags[].severity == "block"` → skip setup entirely.
- `restore.drift_detected == true` → treat pulse as degraded; skip session.
- `now > valid_until` → stale; skip and request re-run.

### 7.3 Confidence formula

```
if macro, 4h, 15m all present:
    composite = 0.5 * macro_confidence
              + 0.3 * 4h_confidence
              + 0.2 * 15m_confidence
    penalty   = 1.0

elif macro + 4h present (15m failed):
    composite = 0.625 * macro_confidence + 0.375 * 4h_confidence
    penalty   = 0.85   // incomplete analysis

elif only macro present (4h failed):
    composite = macro_confidence
    penalty   = 0.7    // heavily penalised

composite_confidence = round(composite * penalty)
```

### 7.4 TTL — `valid_until`

- Default: **24 hours from `generated_at`**. Day-trading session window for 24/7 crypto markets.
- Bot rule: `now > valid_until` → pulse is stale, bot refuses to act.
- Human re-runs `/chart-pulse` if macro shifts mid-session or after TTL expires.

### 7.5 Markdown structure

```
# Chart Pulse — <SYMBOL> (<YYYY-MM-DD> UTC)

**Generated:** <ISO UTC>    **Valid until:** <ISO UTC>
**Composite:** <N>/100      **Direction:** <bias>

## Dashboard
| Stage          | Confidence | Signal            |
| Macro (W/D)    | N/100      | ...               |
| 4H Structure   | N/100      | ...               |
| 15m Triggers   | N/100      | ...               |
| Composite      | N/100      | ...               |

## Macro read (W/D)
[narrative — PA + Fib + Elliott advisory]

## 4H structure
[narrative + key levels table + watch zones list]

## 15m setup hints
### Setup 1 — <direction> @ <zone_id>
[entry, stop, target, R:R, conditions, invalidation, quality]
### Setup 2 ...

## Contrarian flags
[list with severity, or "(none)"]

## Data gaps
[list, or "(none)"]

## Chart-state restore
- Performed: yes
- Drift detected: no
[if drift: explicit description]

---
**DISCLAIMER:** Educational/research only. Not financial advice.
```

Elliott narrative appears in the "Macro read" section and nowhere in the JSON.

---

## 8. Confidence, fallback, vetoes

Always-emit policy: the orchestrator always writes both artifacts, even on degraded or stand-aside outcomes. Consumers (human and bot) get the full picture with explicit quality signals.

Three layers of gating downstream:

1. **`composite_confidence`** — smooth gate, bot rules thresholded on it.
2. **`contrarian_flags`** — hard vetoes, bot must respect `block` severity.
3. **`restore.drift_detected`** — pulse-level degradation, bot skips session.

Contrarian flags to always check in 15m specialist:

- `rr_below_floor` — R:R primary < 2.0 (per `feedback_rr_decay_pattern`)
- `stop_too_tight` — stop_distance_pct < 0.5% (per `feedback_stop_outside_sweep_zone`)
- `against_macro` — setup direction contradicts macro direction
- `crowded_trade` — extreme social/analyst consensus reported (advisory, severity warn)

---

## 9. Error handling

### 9.1 Specialist failure

Failure modes: specialist returns no JSON at all (crash), returns unparseable JSON, exceeds timeout, or returns JSON that fails schema validation. All are treated identically — as a stage failure.

| Failure | Orchestrator response |
| :--- | :--- |
| 4H specialist fails | Skip 15m dispatch. Emit macro-only pulse. `4h_confidence: null`, `structure_4h.watch_zones: []`, `trigger_15m: null`. Composite penalty 0.7. |
| 15m specialist fails | Emit macro + 4H. `15m_confidence: 0`, `setup_hints: []`. Composite penalty 0.85. |
| Both fail | Emit macro-only. Composite penalty 0.7. `data_gaps` notes both failures. |

No automatic retries. LLM variance makes retries expensive and rarely helpful.

### 9.2 MCP tool failure

- **Phase 1 critical read** (e.g., `chart_get_state` errors): abort → Phase 4 restore → emit error pulse (`composite_confidence: 0`).
- **Phase 1 non-critical** (e.g., specific pine-label read fails): log in `data_gaps`, continue.
- **Phase 2–3 specialist-scoped MCP errors**: propagate as that specialist's `data_gaps`, not an orchestrator abort.

### 9.3 Restore failure

- Set `restore.performed: false` **or** `restore.drift_detected: true` with explicit `notes`.
- Do **not** retry the restore. Flag loudly.
- Bot treats any drift as pulse-degraded → skip.

### 9.4 Timeouts

- Soft target: 90s end-to-end.
- Hard ceiling: 180s. Orchestrator aborts current phase and forces Phase 4 restore.
- Individual MCP tool calls: no custom timeout beyond MCP's own defaults.

---

## 10. Testing

Three layers:

### 10.1 Schema validation (cheap)

- JSON schema file for `chart-pulse.v1`.
- Fixture-based unit tests: feed known-good and known-malformed JSONs, assert validator behavior.
- CI on every change.

### 10.2 Specialist isolation (medium)

- `@structure-4h` invoked manually with a canned `MACRO_BRIEF`. Verify:
  - Returns strict JSON matching specialist schema.
  - No mutation tools attempted (check transcript — tool allowlist blocks, but verify).
  - `data_gaps` populated when inputs incomplete.
- Same for `@trigger-15m` with canned MACRO + 4H briefs.

### 10.3 End-to-end chart runs (expensive, manual at first)

- **Golden path:** clean BTC 4H chart with 3–4 standard indicators. Run `/chart-pulse`. Verify:
  - Both artifacts written to `pulses/`.
  - JSON validates.
  - Markdown has all required sections.
  - `restore.performed: true`, `drift_detected: false`.
  - `chart_get_state` post-run identical to snapshot.
- **Degraded path:** chart with only 1 indicator. Verify graceful degradation — composite reflects data gaps, pulse still emits.
- **Failure path:** deliberately break (kill CDP mid-run, switch to invalid symbol). Verify Phase 4 restore runs, drift flagged correctly.

---

## 11. Out of scope

- **The bot** (sub-project #1 paper-trade reader). This spec is the analyst refactor only.
- **Scheduling** (cron, launchd, plugin). On-demand only in this iteration.
- **Multi-symbol batch.** Future wrapper skill.
- **Agent teams** (experimental separate sessions). We use subagents.
- **Fundamental data** (news, earnings, macro econ).
- **Elliott as JSON field.** Markdown narrative only.
- **Position sizing / portfolio heat.** Bot concern.

---

## 12. Unchanged

- `.claude/skills/chart-quick/` — 60s no-subagent triage. Orthogonal.
- `.claude/agents/performance-analyst.md` — backtest reviewer. Different concern.
- `.claude/skills/{chart-analysis,multi-symbol-scan,pine-develop,replay-practice,strategy-report}/` — pre-existing, untouched.
- MCP server code — no new tools required.
- Project memories (`user_chart_conventions`, `feedback_stop_outside_sweep_zone`, etc.) — all continue to apply.
- `docs/REFERENCE-skills-and-agent-teams.md` — still canonical reference.

---

## 13. File changes (implementation hints)

Implementation planning will detail the order; this section enumerates what changes.

### 13.1 Rewrite

- `.claude/skills/chart-pulse/SKILL.md`
  - Body replaced with new orchestrator structure (Phases 0–4, mutation rights, W/D macro mandate, cascade dispatch).
  - Frontmatter: update `description` to reflect day-trading focus and mutation-with-restore invariant.
  - Add `allowed-tools:` entries for mutation tools (`chart_set_*`, `chart_manage_indicator`, `draw_*`, `indicator_set_inputs`).

### 13.2 Delete

- `.claude/agents/trend-analyst.md`
- `.claude/agents/setup-analyst.md`
- `.claude/agents/momentum-analyst.md`
- `.claude/agents/risk-analyst.md`
- `.claude/agents/thesis-analyst.md`

The horizontal-dimension specialists are incompatible with the new TF-hierarchy. Delete rather than refactor; the new specialists have different mandates.

### 13.3 Add

- `.claude/agents/structure-4h.md` — 4H specialist per §5.2.
- `.claude/agents/trigger-15m.md` — 15m specialist per §5.3.
- `schemas/chart-pulse.v1.json` — JSON Schema for the JSON sidecar (used by validator tests, future bot-side parser).

### 13.4 Touch-ups

- `.gitignore`: replace `CHART-PULSE-*.md` line with `pulses/`.
- `CLAUDE.md`: update the `/chart-pulse` decision-tree entry to reflect the new day-trading focus and the snapshot-analyze-restore behavior.
- `README.md`: update the "Multi-agent chart analysis" bullet.

---

## 14. Open questions / future work

Not blockers for this spec — listed so they aren't forgotten.

- **Snapshot fidelity.** Indicator *settings* (length, source, color) are part of the snapshot in principle. MCP's `chart_get_state` returns indicator names and IDs but not full settings; verifying full restore fidelity may require `indicator_set_inputs`-style queries. First pass: track IDs only, accept that indicator setting changes made pre-run aren't detected.
- **Grammar evolution.** `trigger_conditions` grammar will need to grow as the bot's parser learns more patterns. Bumping `schema` version (`chart-pulse.v1` → `v2`) is the forward-compat path.
- **Cache of last-successful pulse.** If a run fails before Phase 3, we emit nothing — the bot has no fresh pulse. Future: keep the previous successful pulse until a new one completes cleanly.
- **Instrument-specific heuristics.** `project_instrument_stack` notes a 3-layer instrument stack (spot 1D/1W for regime; perp intraday). This spec assumes the user has the "right" TF loaded. Future: validate that the loaded symbol is appropriate for the pipeline (e.g., don't run on a spot-only chart when macro is supposed to come from perp).

---

## 15. Acceptance

This spec is approved for implementation planning when:

- Sections 1–14 are reviewed by the user.
- No ambiguity in the JSON schema or cascade semantics.
- Test plan is realistic.
- Handoff to `writing-plans` skill produces a build order that respects the phased dependency (specialists first, then orchestrator).
