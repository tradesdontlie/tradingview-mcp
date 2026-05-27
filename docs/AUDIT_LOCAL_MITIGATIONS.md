# Audit Local Mitigations — Operator Prompt Conventions

> **Context.** These are prompt-side conventions for LLM operators using
> the TradingView MCP. They complement the schema-level fixes shipped in
> the `audit/consolidated-2026-05-26` branch (commits C1-C13). Each
> mitigation references the consolidated finding ID + the audit source
> IDs (A1-F* / A2-F*).
>
> Reference audits:
> - `Downloads/TradingView_MCP_Audit_2026-05-25.md` (13 findings, F1-F13)
> - `Downloads/TradingView_MCP_Audit_CC_TV_MCP_2026-05-25_1740_AST.md` (6 findings + 1 D3)
> - Operator session: `Downloads/CC TV MCP.txt` (1677 lines, 244-ticker
>   TADAWUL earnings sweep that shipped 8/244 before this branch).

---

## Mandatory pre-flight (every TV MCP session)

1. **Close the TradingView Desktop app** before any MCP loop. Desktop +
   browser tab on the same account silently freezes Pine evaluation
   across symbol switches (audit C4/A1-F2/A2-F6, the "single hardest-to-
   diagnose issue of the session"). `tv_health_check` now detects this
   (`possible_session_contention:true`), but pre-flight closure is the
   real fix.
2. **Run `tv_health_check` first**. Verify `cdp_connected:true`,
   `api_available:true`, `possible_session_contention:false`. If the
   contention flag is set, ask the user to close the other tab/desktop
   before continuing.
3. **For any loop >5 symbols, ALSO re-probe `tv_health_check` every
   10 symbols** during the sweep. Pine evaluation can degrade mid-loop;
   re-probing catches it before you've wasted 50+ calls.

---

## Per-finding conventions

### C1 / A1-F4 / A2-F1 — chart_get_state coherence

- **Always pass `verify_against_feed:true` (the default).** Never use
  the legacy snapshot-only mode in production loops.
- On `error:"CHART_DATA_STATE_MISMATCH"`, do NOT retry blindly. Either
  reload the TradingView browser tab (operator action) or call
  `chart_ensure_symbol` again.

### C2 / A1-F5 / A2-F2 — pine_deploy_* editor preflight

- **Before any `pine_deploy_*`**, call `pine_get_editor_state` to know
  what the editor currently holds.
- If `editor_saved_script_name` is NOT the script you're about to
  deploy, either:
  - Call `pine_new(type)` to clear the editor, OR
  - Pass `force_overwrite_editor:true` on the deploy.
- Do NOT just hope that the editor is clean. Six redeploys (the audit's
  reproduction) is the cost of skipping this check.

### C3 / A1-F3 / A2-F3 — Pine read freshness

- **Every `data_get_pine_*` call after a `chart_ensure_symbol`** MUST
  pass `expected_for_symbol:<symbol>` matching the symbol you just set.
  Stale reads now fail loudly (`PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE`)
  instead of returning data from the prior symbol.
- For sweeps, prefer `pine_extract_per_symbol` (C6) which threads
  `expected_for_symbol` automatically.

### C4 / A1-F2 / A2-F6 — Multi-session contention

- Pre-flight: close TradingView Desktop app.
- During sweeps: re-call `tv_health_check` every 10 symbols.
- On `possible_session_contention:true`, STOP. Ask the user to close
  the other session. Do not silently continue.

### C5 / A1-F6 — Replace fixed sleeps with `pine_wait_for_output`

- **NEVER use `Bash(sleep N)` to wait for TV Pine output.** Always use:
  ```
  pine_wait_for_output({
    study_filter: "MyStudy",
    emit: "labels",
    min_count: 1,
    expected_for_symbol: <symbol_just_set>,
    timeout_s: 8,
  })
  ```
- The 47 manual sleeps in the audit operator session were all
  workarounds for this missing primitive. They are no longer
  acceptable.

### C6 / A1-F1 — Per-symbol sweeps

- **For any per-symbol Pine-output sweep >5 symbols, use
  `pine_extract_per_symbol`.** Do NOT loop
  `chart_ensure_symbol → sleep → data_get_pine_labels` manually — that
  is the exact ~4-call/ticker pattern that failed in the audit
  (8/244 shipped).
- Pass `verify_with_known_good:"TADAWUL:2222"` (or whatever ticker you
  know has data) for fail-fast detection of broken pipelines.
- For long sweeps, set `abort_after_consecutive_empty:5` to bail when
  Pine state degrades mid-loop.

### C7 / A1-F7 — "Save and add to chart" modal

- When `pine_smart_compile` reports `blocked_by:"Save script"`, call:
  ```
  pine_dismiss_dialog({
    accept: true,
    expected_dialog_kinds: ["save_and_add_to_chart"],
  })
  ```
- The bare `pine_dismiss_dialog({accept:true})` may click the wrong
  button.

### C8 / A1-F8 / A2-F2 — Deploy failure diagnosis

- When `pine_deploy_*` returns `success:false`, ALWAYS check
  `step_failed` and `ui_diagnostic` FIRST before re-running. The
  diagnostic tells you whether to dismiss a modal, fix a compile error,
  or re-open the Pine panel.

### C9 / A1-F9 / A2-F5 — `data_get_pine_tables` empty

- On `error:"NO_PINE_TABLES_EXTRACTED"`, do NOT redeploy. Switch to
  `data_get_pine_labels` for the same study. The Pine likely uses
  `table.new()` gated by `barstate.islast` and the last bar isn't
  currently rendered — labels are more robust for machine reads.

### C10 / A1-F10 — Pine v6 multi-line `+`

- **Before any `pine_deploy_*` of source written in this session, call
  `pine_lint(source=...)`.** Look for `v6-multi-line-plus` errors.
  Wrap the offending expression in `(` ... `)`.

### C11 / A1-F11 / A2-F4 — Chart not ready hard-stop

- Keep `require_ready:true` (the default) on all `chart_ensure_symbol`
  calls. On `error:"CHART_NOT_READY"`, increase `ready_timeout_ms`
  (e.g. to 20000) for slow symbols, but do NOT proceed with
  `data_get_*` calls until ready is confirmed.

### C12 / A1-F12 — Pine v6 enum lookup

- **Before drafting any Pine source that uses an enum-typed argument**
  (e.g. `request.earnings(field=...)`), call
  `pine_v6_reference({name:"request.earnings"})` and use ONLY the
  enum values listed in `enums.field.valid`. Do not derive enum
  members from external TradingView docs — they often list members
  valid in chart panels but NOT in Pine v6.

### C13 / A1-F13 — Pre-deploy chart cleanup

- **At the start of every Pine-development session**, call
  `chart_clear_studies({dry_run:true})` to see what's on the chart.
  If unrelated studies are present, call without dry_run to clean up.
- Use `except_names:["MyKnownStudy"]` to keep your in-progress work.

---

## Watch for these patterns in your own behavior

- ❌ Using `Bash(sleep N)` after any TV MCP call → switch to
  `pine_wait_for_output`.
- ❌ Calling `data_get_pine_labels` without `expected_for_symbol` after
  a symbol switch → stale data risk.
- ❌ Calling `pine_deploy_*` without checking `pine_get_editor_state`
  first → stale bytecode risk.
- ❌ Looping `chart_ensure_symbol` + sleep + read manually for >5
  symbols → use `pine_extract_per_symbol`.
- ❌ Skipping `tv_health_check` at session start → contention will
  bite mid-loop.

---

## See also

- `handoff_summaries/TV_MCP_AUDIT_CONSOLIDATED_FIX_2026-05-26.md`
  — implementation summary per finding.
- `tests/unit/*.test.js` — observable-behaviour assertions per fix.
