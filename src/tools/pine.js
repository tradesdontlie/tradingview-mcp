import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'pine_refresh_catalog',
    'Bust TV\'s chart-side My-scripts metaInfo cache by replacing the cached `userScriptsPromise` with a fresh `/pine-facade/list/` fetch and forcing `_updateUserStudies()` to rebuild `_studies[\'Script$USER\']`. CALL THIS AFTER `pine_save_source` and BEFORE `chart_manage_indicator(remove + add)` so the chart picks up the freshly compiled IL instead of the stale cached version. Returns `{success, cache_before_count, cache_after_count, delta, scripts[{id,title}]}`. Sub-second, no page reload, no UI flash. T107 / cherry-pick of upstream PR #152 commit `63fe862`.',
    {},
    async () => {
      try { return jsonResult(await core.refreshCatalog()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save_source', 'Save Pine Script source directly to a saved cloud script via TradingView\'s pine-facade REST endpoint. No Monaco editor required — works regardless of editor pane layout (bottom bar / side dock / dialog). Sub-second. Pass `id` (preferred, from pine_list_scripts) or `name` (case-insensitive match). After saving, run `chart_manage_indicator` (remove + re-add) on the chart so the live chart picks up the new cloud version.', {
    source: z.string().describe('Pine Script source code to save'),
    id: z.string().optional().describe('Saved-script id (e.g. "d101351d0e8a4c63bbb74d2676077538"). Get from pine_list_scripts. Preferred over `name` since it bypasses a list-and-search step.'),
    name: z.string().optional().describe('Saved-script display name (case-insensitive match). Used when id is not provided.'),
  }, async ({ source, id, name }) => {
    try { return jsonResult(await core.saveSource({ id, name, source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_source_rest', 'Read Pine Script source from a saved cloud script via TradingView\'s pine-facade REST endpoint. No Monaco editor required. Pass `id` (preferred) or `name` (case-insensitive match). Optional `version` (defaults to the current saved version).', {
    id: z.string().optional().describe('Saved-script id. Get from pine_list_scripts.'),
    name: z.string().optional().describe('Saved-script display name (case-insensitive match). Used when id is not provided.'),
    version: z.union([z.string(), z.number()]).optional().describe('Specific version to fetch. Defaults to current.'),
  }, async ({ id, name, version }) => {
    try { return jsonResult(await core.getSourceByREST({ id, name, version })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('with_pine_save', 'Orchestrated Pine save: compile + REST save + cache-bust + chart reload + verification, with retry on cache-miss. Replaces the 4-5 manual MCP call dance (pine_check → pine_save_source → pine_refresh_catalog → chart_manage_indicator remove+add → data_get_pine_tables verify) with a single call. Returns per-step timings + final_verification status. Pass `indicator_display_name` to auto-reload the chart; omit to save-only. Pass `expected_version` (e.g. "v2.12.1") to verify the reloaded entity\'s name contains that substring; otherwise verification falls back to pine_tables row count > 0.', {
    script_id_or_name: z.string().describe('Saved-script id (preferred, starts with `USER;`) or case-insensitive display name.'),
    source: z.string().describe('Full Pine v6 source. Will be compiled via pine_check before save.'),
    expected_version: z.string().optional().describe('Version substring to assert in the reloaded entity name (e.g. "v2.12.1"). Most reliable verification probe.'),
    indicator_display_name: z.string().optional().describe('Display name used by chart_manage_indicator(add). Required for chart reload + verification. Omit for save-only mode.'),
    max_retries: z.number().int().min(0).max(5).optional().describe('Retries on cache miss / RELOAD failure. Default 2. A version mismatch is never retried — a retry cannot change a declared version string and each retry is another non-atomic chart mutation.'),
    save_layout: z.boolean().optional().describe('Save the chart layout after a passing verification. Default true — without it the ship is NOT durable: the layout keeps instantiating the previous compiled version after any restart.'),
    force_layout_save: z.boolean().optional().describe('Save the layout even if the reload reset tuned inputs to their declared defaults. Default false (refusing protects you from persisting a settings loss).'),
    restore_settings: z.boolean().optional().describe('Snapshot the study\'s user inputs before the reload and re-apply them after, so operator tuning survives. Default true. Skipped automatically when the input COUNT changed, since the ids are positional.'),
  }, async ({ script_id_or_name, source, expected_version, indicator_display_name, max_retries, save_layout, force_layout_save, restore_settings }) => {
    try {
      return jsonResult(await core.withSave({ script_id_or_name, source, expected_version, indicator_display_name, max_retries, save_layout, force_layout_save, restore_settings }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('chart_save_layout', 'Persist the current chart layout (studies, their versions, drawings) via TradingView\'s own silent-save service, then assert the change flag actually cleared. Needed because updating a script and swapping the live study does NOT update the layout\'s saved copy — any reload, layout re-sync or app restart re-instantiates the OLD compiled version under a fresh entity id, which does not read as a revert. Auto-save being enabled is not sufficient; it can fail to flush. Do NOT substitute Ctrl+S — the save target is sticky to whatever last had focus, so with the Pine Editor focused it saves the script instead of the layout.', {
    timeout_ms: z.number().int().min(1000).max(60000).optional().describe('How long to wait for the change flag to clear. Default 8000.'),
  }, async ({ timeout_ms }) => {
    try { return jsonResult(await core.saveLayout({ timeout_ms })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
