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
}
