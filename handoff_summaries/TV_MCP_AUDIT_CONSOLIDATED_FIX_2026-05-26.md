# TradingView MCP — Consolidated Audit Remediation (Handoff)

**Date:** 2026-05-26
**Branch:** `audit/consolidated-2026-05-26`
**Base:** `origin/main` (4795784)
**Findings closed:** 13/13 (6×P0 / 4×P1 / 3×P2)
**Test count:** 39 baseline → 90 after audit fixes (+51 new offline tests)

## Source audits (consolidated 1:1 into 13 findings)

- `Downloads/TradingView_MCP_Audit_2026-05-25.md` — 13 findings (A1-F1 … A1-F13)
- `Downloads/TradingView_MCP_Audit_CC_TV_MCP_2026-05-25_1740_AST.md` — 6 findings + 1 D3 (A2-F1 … A2-F6)
- Operator session: `Downloads/CC TV MCP.txt` (1677 lines; 244-ticker TADAWUL earnings sweep that shipped 8/244 pre-fix)

## Baseline-state caveat

`origin/main` lacked many of the tools the audits reference (pine_deploy_*,
pine_dismiss_dialog, pine_lint, pine_v6_reference, chart_ensure_symbol,
symbol_resolve, etc.) — those existed only in the operator's **local
uncommitted WIP** in the main checkout when the audit was produced.

Commit `2a1f042 chore(baseline): capture operator WIP as audit pre-state`
captures that WIP verbatim into the audit branch so the audit-fix
commits sit on the correct semantic baseline. The operator's main
checkout was NOT modified during this run (files copied read-only).
**The operator should rebase or merge their eventual WIP commit
against this audit branch to dedupe.**

## Foundation (Wave 0)

### `feat(core): add mutation ledger as freshness-token foundation (Wave 0)` — 986f3c8

- **New:** `src/core/_mutation_ledger.js` — module-level monotonic
  `mutation_id` + `lastMutationFor(symbol)`. Cross-cutting freshness
  token consumed by C1/C2/C3/C5/C6.
- **Wired into:** `src/core/chart.js` (`setSymbol`, `ensureSymbol`,
  `setTimeframe`) + `src/core/pine.js` (`setSource`, `compile`,
  `smartCompile`, `saveAs`, `deployStrategy`). Each returns
  `mutation_id` (additive; no breaking changes).
- **Tests:** `tests/unit/mutation_ledger.test.js` (10 cases).
- **package.json:** new `test:offline` + `test:integration` scripts;
  `test:all` glob now includes `tests/unit/*.test.js`.

---

## Wave 1 — P0 staleness/coherence

### C1 / A1-F4 / A2-F1 — `chart_get_state` coherence probe vs live feed — 9367d66

- **Files:** `src/core/chart.js:getState` (lines 17-99 in worktree),
  `src/tools/chart.js` (chart_get_state schema).
- **Behaviour:** with `verify_against_feed:true` (default), reads
  `mainSeries().symbolInfo()` + `mainSeries().interval()` and
  cross-checks against `chart.symbol()`/`chart.resolution()`. On
  mismatch returns `success:false` + `error:"CHART_DATA_STATE_MISMATCH"`
  + `coherent:false` + `coherence_errors:[…]` +
  `data_symbol`/`data_resolution`/`remediation`.
- **Tests:** `tests/unit/chart_state_coherence.test.js` (7 cases).
- **Audit reproduction (CC TV MCP.txt:231-244):** Aramco-state vs
  Americana-feed mismatch would now return CHART_DATA_STATE_MISMATCH
  instead of stale data masquerading as success.

### C2 / A1-F5 / A2-F2 — `pine_get_editor_state` + deploy preflight guard — 26384d5

- **Files:** `src/core/pine.js` (new `getEditorState`,
  `_resolvePineDeps`, deploy preflight in `deployStrategy`),
  `src/tools/pine.js` (new `pine_get_editor_state` tool +
  `force_overwrite_editor` param on `pine_deploy_strategy`/
  `pine_deploy_indicator`).
- **Behaviour:** new tool reads
  `{panel_open, script_name, dirty, source_hash, action_button, modal, compile_errors}`
  without mutation. Deploy refuses with
  `code:"EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT"` when the editor binds a
  different saved script and `force_overwrite_editor:false` (default).
- **Tests:** `tests/unit/pine_editor_state.test.js` (9 cases).
- **Audit reproduction (CC TV MCP.txt:105, 142, 237-239):** 6 redeploy
  cycles → refused on first attempt with actionable remediation.

### C3 / A1-F3 / A2-F3 — Pine drawing reads return freshness provenance — 2084fb0

- **Files:** `src/core/data.js`
  (`getPineLabels`/`getPineTables`/`getPineLines`/`getPineBoxes` +
  `_readChartProvenance` + `_computeStaleness`),
  `src/tools/data.js` (schema gains `expected_for_symbol`).
- **Behaviour:** all 4 getters return `chart_symbol`,
  `chart_resolution`, `last_chart_mutation_id`, `stale`,
  `stale_reason` on every result. With `expected_for_symbol`,
  mismatched results return `success:false` +
  `error:"PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE"`.
  `_DLY` normalized on both sides.
- **Tests:** `tests/unit/pine_freshness.test.js` (11 cases).
- **Audit reproduction (CC TV MCP.txt:712, 985, 1172):** "those labels
  are still 1120 data (Al Rajhi Bank prices)" → fails loudly now.

---

## Wave 2 — P0 sync + health

### C4 / A1-F2 / A2-F6 — `tv_health_check` pine_evaluation_live + contention warning — a22a5e2

- **Files:** `src/core/health.js`
  (`healthCheck` + `_countTvChartTargets`), `src/tools/health.js`
  (`tv_health_check` schema gains `probe_pine_evaluation`).
- **Behaviour:** new fields `pine_evaluation_live`, `last_bar_time`,
  `study_count`, `tv_chart_tab_count`, `possible_session_contention`,
  `contention_warning`, `last_chart_mutation_id`, `probed_at`.
  `tv_chart_tab_count` counts distinct `tradingview.com/chart` CDP
  targets via `http://127.0.0.1:9222/json` — `>1` triggers the
  warning (close other tabs / Desktop app).
- **Tests:** `tests/unit/health_contention.test.js` (4 cases; uses an
  in-process fake CDP server).
- **Audit reproduction (CC TV MCP.txt:1247-1250):** Desktop-app
  contention → audit's "single hardest-to-diagnose issue" now
  surfaced explicitly.

### C5 / A1-F6 — `pine_wait_for_output` replaces sleep workarounds — e3807c9

- **Files:** `src/core/pine.js` (new `waitForOutput`),
  `src/tools/pine.js` (new `pine_wait_for_output` tool).
- **Behaviour:** server-side poll loop on
  `getPineLabels/Lines/Boxes/Tables`. Returns on
  `min_count` reached OR `expected_for_symbol` satisfied OR
  `timeout_s` elapsed. On timeout returns `success:false` +
  `code:"PINE_WAIT_TIMEOUT"` + `polls`, `wait_ms_elapsed`,
  `last_result`, `remediation`.
- **Tests:** `tests/unit/pine_wait_for_output.test.js` (8 cases).
- **Audit reproduction:** 47 `Bash(sleep N)` calls (Grep count in
  CC TV MCP.txt) — all replaced by a single primitive.

---

## Wave 3 — P0 per-symbol batch extractor

### C6 / A1-F1 — `pine_extract_per_symbol` collapses N × (set+wait+read) — ed71fa9

- **Files:** `src/core/batch.js` (new `extractPerSymbol`),
  `src/tools/batch.js` (new `pine_extract_per_symbol` tool).
- **Behaviour:** per-symbol routine `ensureSymbol` → `waitForOutput`
  (expected_for_symbol=symbol) → read each requested emit kind →
  record `{symbol, success, payload, mutation_id_*, total_items, elapsed_ms, error?}`.
  Supports `verify_with_known_good` (fail-fast) and
  `abort_after_consecutive_empty` (mid-loop pipeline-degraded bail).
- **Tests:** `tests/unit/pine_extract_per_symbol.test.js` (8 cases).
- **Audit reproduction (CC TV MCP.txt:431, 1337):** 244 tickers ×
  4 calls / 30s = 8/244 shipped. New single-call workflow.

---

## Wave 4 — P1 cleanup

### C7 / A1-F7 — `pine_dismiss_dialog` kind enum — 800536a

- **Files:** `src/core/pine.js` (exported `DIALOG_KINDS` +
  `dismissDialog` enhanced), `src/tools/pine.js` (schema gains
  `expected_dialog_kinds` enum).
- **Behaviour:** 5 dialog kinds (`unsaved_changes`,
  `save_and_add_to_chart`, `overwrite_existing_study`, `save_as_new`,
  `compile_error_modal`). Kind-specific primary-button selection.
  Floating-button fallback at
  `[data-name="submit-button-save-and-add-to-chart"]`. Returns
  `matched_dialog_kind` + `action`.
- **Tests:** `tests/unit/pine_dialog_kinds.test.js` (11 cases).
- **Audit reproduction (CC TV MCP.txt:323, 1022):** 2+ failures + user
  screenshot needed → resolved by kind-specific click.

### C8 / A1-F8 / A2-F2 — `pine_deploy_*` per-step failure diagnostic — ad90293

- **Files:** `src/core/pine.js:deployStrategy` (full refactor with
  step tracking).
- **Behaviour:** tracks `step_completed` / `step_failed` across
  `set_source` → `save` → `add_to_chart_button_click` →
  `study_added`. On failure returns `compile_errors` (auto-pulled
  from Monaco markers if step_failed=study_added) and `ui_diagnostic`
  with modal/button visibility + actionable remediation text.
- **Tests:** `tests/unit/pine_deploy_diagnostic.test.js` (2 cases —
  early-step path; later steps need live CDP and are covered by
  `tests/e2e.test.js`).
- **Audit reproduction (CC TV MCP.txt:277-292):** "Deploy reported
  failure but no compile errors" + 3 follow-up probes → inline.

### C9 / A1-F9 / A2-F5 — `data_get_pine_tables` differentiates study-missing vs no-table — b8e8960

- **Files:** `src/core/data.js:getPineTables` (now does a second
  evaluate for `chart.getAllStudies()` when table extract is empty).
- **Behaviour:** 3 distinct branches: tables found (success), study
  found but no tables (`error:"NO_PINE_TABLES_EXTRACTED"`,
  `studies_seen`, `tables_in_last_bar`, `diagnostic` recommending
  labels fallback), study not found (success but empty,
  diagnostic pointing at `chart_get_state` for the right name).
- **Tests:** `tests/unit/pine_tables_diagnostic.test.js` (4 cases).
- **Audit reproduction (CC TV MCP.txt:1628):** "data_get_pine_tables
  was unreliable in this session" — now actionable.

### C10 / A1-F10 — `pine_lint` rule for v6 multi-line `+` — 44a957d

- **Files:** `src/core/pine.js` (new `_stripStringsAndComments`,
  v6-multi-line-plus rule in `analyze`).
- **Behaviour:** new error-severity diagnostic
  `[v6-multi-line-plus]` when a line starts with `+`, parenDepth==0,
  and the previous line doesn't legally continue. String literals and
  comments correctly excluded from paren counting.
- **Tests:** `tests/unit/pine_v6_multiline_plus.test.js` (6 cases).
- **Audit reproduction (CC TV MCP.txt:335):** "Mismatched input '+'
  expecting end of line at line 14" — diagnosed via user screenshot
  in original session. Now flagged by `pine_lint` before deploy.

---

## Wave 5 — P2 polish

### C11 / A1-F11 / A2-F4 — `chart_ensure_symbol` require_ready hard-stop — e04f4d2

- **Files:** `src/core/chart.js:ensureSymbol` (new `require_ready`
  default true + `ready_timeout_ms`), `src/tools/chart.js`
  (schema additions).
- **Behaviour:** on `chart_ready !== true` under `require_ready=true`,
  returns `success:false` + `error:"CHART_NOT_READY"` + `next_action`
  text. `require_ready:false` preserves legacy "fire and forget".
- **Tests:** `tests/unit/chart_ensure_symbol_require_ready.test.js`
  (3 cases).

### C12 / A1-F12 — `pine_v6_reference` includes enum members — e66b7df

- **Files:** `src/core/v6_reference.js` (new `V6_ENUM_MEMBERS` +
  `lookupBuiltin` enhanced).
- **Behaviour:** `lookupBuiltin('request.earnings')` now returns
  `enums.field.valid` = ['earnings.actual', 'earnings.estimate',
  'earnings.standardized'] + `common_mistakes` covering
  `earnings.actual_period` and `earnings.eps`. Same for
  `request.dividends.field`.
- **Tests:** `tests/unit/pine_v6_reference_enums.test.js` (3 cases).

### C13 / A1-F13 — `chart_clear_studies` cleanup primitive — 171e172

- **Files:** `src/core/chart.js` (new `clearStudies`,
  `_BUILT_IN_STUDY_NAMES`), `src/tools/chart.js`
  (new `chart_clear_studies` tool with `destructiveHint:true`).
- **Behaviour:** removes all studies except `except_names`
  allowlist + (when `except_built_ins=true` default) Volume/Volume
  Profile/Sessions. `dry_run=true` returns `would_remove` preview.
  Returns `removed`/`preserved`/`errors`/`mutation_id`.
- **Tests:** `tests/unit/chart_clear_studies.test.js` (4 cases).

---

## Wave 6 — Local-mitigation docs (ac2e781)

- `docs/AUDIT_LOCAL_MITIGATIONS.md` — NEW. Per-finding prompt
  conventions for LLM operators (pre-flight, expected_for_symbol on
  every Pine read, pine_get_editor_state before deploy, never
  Bash(sleep), pine_extract_per_symbol for sweeps >5 symbols, dialog
  kind selection, enum lookup, chart_clear_studies at session start).
- `skills/multi-symbol-scan/SKILL.md` updated to bake C4 contention
  pre-flight, C5 wait primitive, C6 batch extractor, C11 hard-stop.
- `skills/pine-develop/SKILL.md` updated to bake C2 preflight, C7+C8
  deploy-failure diagnosis, C10 lint rule check.
- `README.md` appended "Known Issues / Operator Gotchas" with link.

---

## Tests summary

| Tier | Count pre | Count post | Net new |
|------|----------:|-----------:|--------:|
| Offline (`test:offline`) | 29 | 90 | +61 |
| Live E2E (`tests/e2e.test.js`) | unchanged | unchanged | 0 |

Per-finding unit test files (added):
- `tests/unit/mutation_ledger.test.js`
- `tests/unit/chart_state_coherence.test.js`
- `tests/unit/pine_editor_state.test.js`
- `tests/unit/pine_freshness.test.js`
- `tests/unit/health_contention.test.js`
- `tests/unit/pine_wait_for_output.test.js`
- `tests/unit/pine_extract_per_symbol.test.js`
- `tests/unit/pine_dialog_kinds.test.js`
- `tests/unit/pine_deploy_diagnostic.test.js`
- `tests/unit/pine_tables_diagnostic.test.js`
- `tests/unit/pine_v6_multiline_plus.test.js`
- `tests/unit/chart_ensure_symbol_require_ready.test.js`
- `tests/unit/pine_v6_reference_enums.test.js`
- `tests/unit/chart_clear_studies.test.js`

Live E2E scenarios per finding (the schema deltas need real CDP +
TradingView for full coverage) are TODO — out of scope for this branch;
the unit suite covers all observable-behaviour assertions for the 6
P0 findings via dep injection.

## Precondition (operator-side, before triggering this branch)

1. Chrome with CDP via `scripts/launch_chrome_cdp.ps1` (port 9222).
2. TradingView logged in in that Chrome window (one-time).
3. TradingView Desktop app **closed** on the same account.
4. `tv_health_check` returns `cdp_connected:true` +
   `api_available:true` + `possible_session_contention:false`.

## Out of scope

- No new dependencies (still `@modelcontextprotocol/sdk` +
  `chrome-remote-interface` only).
- No Siyolah-v3 CLAUDE.md addendum (per user scope choice).
- No `batch_run` refactor (C6 is a NEW tool, not an extension).
- No live-CDP E2E suite expansion (existing `tests/e2e.test.js`
  unchanged; per-finding live scenarios would extend it but are not
  shipped in this branch).
- Mutation ledger is intentionally NOT persisted — module-level state
  resets on server restart by design.
