import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

// Annotation shortcuts so registrations stay readable.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATES   = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const NETWORK   = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor. WARNING: can return 200KB+ for complex scripts — avoid unless you need to edit.', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('pine_set_source', 'Set Pine Script source code in the editor. Does NOT compile or add to chart — follow with pine_compile or use pine_deploy_strategy for the full flow.', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_compile', 'Compile and add the current Pine Script to the chart. Returns study_added=true/false and blocked_by if a modal (e.g. Save script) prevents the action — in which case call pine_save_as first.', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S). For unnamed scripts a Save dialog appears — use pine_save_as instead if you want to assign a name.', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_save_as', 'Save the current Pine Script under a chosen name. Handles the "Save script" modal that appears for unnamed scripts (types the name, clicks Save). Use this before pine_compile when deploying a new strategy.', {
    name: z.string().min(1).max(80).describe('Display name for the saved script (1-80 chars, e.g., "RSI Backtest 20/80")'),
  }, async ({ name }) => {
    try { return jsonResult(await core.saveAs({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_deploy_strategy', 'ONE-SHOT WORKFLOW: set source → save with name → add to chart → wait for study → return study_id. By default REFUSES with code=EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT if the editor is bound to a different saved script (audit C2/A1-F5/A2-F2 — without this guard, "Add to chart" silently adds stale bytecode under the wrong name). Pass force_overwrite_editor=true to save-as the new name and rebind.', {
    source: z.string().describe('Complete Pine Script source code (must include strategy() or indicator() declaration)'),
    name: z.string().optional().describe('Display name for the script. Auto-derived from strategy()/indicator() title if omitted.'),
    replace_existing: z.coerce.boolean().optional().describe('If a study with the same name exists, click "Update on chart" instead of "Add to chart" (default true)'),
    wait_ms: z.coerce.number().int().min(500).max(60000).optional().describe('Milliseconds to wait for the study to appear on the chart (default 8000)'),
    force_overwrite_editor: z.coerce.boolean().optional().describe('If the editor currently has a DIFFERENT saved script bound, default behavior refuses to deploy (would add stale bytecode under that name). Set true to save-as the requested name and rebind the editor first. Default false.'),
  }, async ({ source, name, replace_existing, wait_ms, force_overwrite_editor }) => {
    try { return jsonResult(await core.deployStrategy({ source, name, replace_existing, wait_ms, force_overwrite_editor })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_deploy_indicator', 'ONE-SHOT WORKFLOW for INDICATORS (overlay=true or pane studies): set source → save with name → add to chart → wait for study → return study_id. Same EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT preflight as pine_deploy_strategy (audit C2). Use when your source begins with indicator(...).', {
    source: z.string().describe('Complete Pine Script source code (must include indicator() declaration)'),
    name: z.string().optional().describe('Display name for the script. Auto-derived from indicator() title if omitted.'),
    replace_existing: z.coerce.boolean().optional().describe('If a study with the same name exists, click "Update on chart" instead of "Add to chart" (default true)'),
    wait_ms: z.coerce.number().int().min(500).max(60000).optional().describe('Milliseconds to wait for the study to appear on the chart (default 8000)'),
    force_overwrite_editor: z.coerce.boolean().optional().describe('If editor currently bound to a different saved script, default refuses; true rebinds via save-as. Default false.'),
  }, async ({ source, name, replace_existing, wait_ms, force_overwrite_editor }) => {
    try { return jsonResult(await core.deployStrategy({ source, name, replace_existing, wait_ms, force_overwrite_editor })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_get_editor_state', 'Read Pine Editor state WITHOUT mutating it: {panel_open, script_name, dirty, source_hash, action_button, modal, compile_errors}. Use BEFORE pine_deploy_* to verify the editor is in the expected state (audit C2/A1-F5/A2-F2).', {
    include_source_hash: z.coerce.boolean().optional().describe('Compute and return SHA-256 (16-hex-char prefix) of the editor source. Default true.'),
  }, async ({ include_source_hash }) => {
    try { return jsonResult(await core.getEditorState({ include_source_hash: include_source_hash !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('pine_wait_for_output', 'Block until a Pine study emits >= min_count items of the requested emit kind, OR (when expected_for_symbol is set) until the chart is on that symbol AND items are present, OR timeout. Replaces ad-hoc Bash sleep loops (audit C5/A1-F6: 47 manual sleeps reproduced). Returns the same payload as data_get_pine_<emit> once the condition is met, plus polls/wait_ms_elapsed; on timeout returns success:false + code:"PINE_WAIT_TIMEOUT" with last_result for diagnosis.', {
    study_filter: z.string().describe('Substring matching the study name (e.g. "EarnsExtractor")'),
    emit: z.enum(['labels', 'lines', 'boxes', 'tables']).optional().describe('Which Pine output type to poll. Default "labels".'),
    min_count: z.coerce.number().int().min(0).optional().describe('Minimum items required before returning. 0 = wait only for the study to be present. Default 1.'),
    expected_for_symbol: z.string().optional().describe('Optional. Reject reads that are stale for the requested symbol; keep polling until the chart is on the expected symbol. Use this after chart_ensure_symbol to make wait_for_output also gate on symbol-correctness.'),
    timeout_s: z.coerce.number().min(1).max(60).optional().describe('Total wait deadline in seconds. Default 10.'),
    poll_interval_ms: z.coerce.number().int().min(50).max(5000).optional().describe('Poll cadence in ms. Default 250.'),
  }, async ({ study_filter, emit, min_count, expected_for_symbol, timeout_s, poll_interval_ms }) => {
    try { return jsonResult(await core.waitForOutput({ study_filter, emit, min_count, expected_for_symbol, timeout_s, poll_interval_ms })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('pine_smart_compile', 'Compile with auto-detection: clicks the right button (Add/Update/Save and add), reports compile errors, study_added status, and blocked_by if a modal interrupts.', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_new', 'Create a new blank Pine Script in the editor (overwrites current source). Use pine_template for a pattern-specific scaffold.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_open', 'Open a saved Pine Script by name into the editor (case-insensitive substring match).', {
    name: z.string().describe('Name of the saved script to open (e.g., "RSI Backtest")'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_list_scripts', 'List the user\'s saved Pine Scripts (id, name, version, last modified)', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, NETWORK);

  server.tool('pine_analyze', 'Offline static analysis of Pine source — catches array out-of-bounds, unguarded first()/last(), missing strategy() declaration. Fast (~10ms), no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_check', 'Server-side Pine Script validation via TradingView\'s compile API. No chart required. Use to verify a script compiles cleanly before pine_set_source.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, NETWORK);

  server.tool('pine_lint', 'Combined static + server-side lint: runs pine_analyze AND pine_check in one call and merges diagnostics. Use this as the primary "is my script OK?" check.', {
    source: z.string().describe('Pine Script source code to lint'),
  }, async ({ source }) => {
    try { return jsonResult(await core.lint({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, NETWORK);

  server.tool('pine_template', 'Return a vetted Pine v6 template by pattern name. Avoids re-deriving common scaffolds and prevents version footguns. Omit `pattern` to list available patterns for the given type.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Script type'),
    pattern: z.string().optional().describe('Pattern name (e.g., "rsi_crossover", "ema_cross", "bb_meanreversion", "rsi", "plot_close", "blank"). Omit to list options.'),
  }, async ({ type, pattern }) => {
    try { return jsonResult(core.template({ type, pattern })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_dismiss_dialog', 'Dismiss the modal dialog blocking the Pine Editor (Save script, Confirm overwrite, etc.). Use after pine_compile reports blocked_by.', {
    accept: z.coerce.boolean().optional().describe('true = click the primary button (Save/OK/Confirm); false = click Cancel/Discard (default false)'),
  }, async ({ accept }) => {
    try { return jsonResult(await core.dismissDialog({ accept })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('pine_extract_inputs', 'Parse `input.int/float/bool/string/...()` declarations from Pine source and return them as a structured list (id, kind, defval, title, minval, maxval, step, options). Useful to populate pine_grid_search axes or document a script.', {
    source: z.string().describe('Pine Script source code to scan'),
  }, async ({ source }) => {
    try { return jsonResult(core.extractInputs({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_migrate_v6', 'Heuristic v4/v5 → v6 source rewrite: bumps the version header, prefixes built-ins with the correct namespace (rsi → ta.rsi, security → request.security, abs → math.abs, etc.), and reports which rules fired. ALWAYS run pine_lint on the output before deploying.', {
    source: z.string().describe('Old (v4/v5) Pine source to migrate'),
  }, async ({ source }) => {
    try { return jsonResult(core.migrateToV6({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_explain_error', 'Translate a Pine compile error message into an actionable explanation with fix suggestions. Pass the raw `message` from pine_get_errors[].message.', {
    message: z.string().describe('The error message text (e.g., "Could not find function or function reference \'rsi\'")'),
  }, async ({ message }) => {
    try { return jsonResult(core.explainError({ message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_v6_reference', 'Look up a Pine v6 built-in function signature (e.g., "ta.rsi", "strategy.entry", "request.security"). Omit `name` to list namespaces; pass `list_all=true` to dump every cached builtin (~80 entries).', {
    name: z.string().optional().describe('Function name to look up. With or without namespace prefix. Substring matching when no exact hit.'),
    list_all: z.coerce.boolean().optional().describe('Dump every cached builtin (heavy — use sparingly).'),
  }, async ({ name, list_all }) => {
    try { return jsonResult(core.v6Reference({ name, list_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
}
