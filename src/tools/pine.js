import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor (returns bound_title = the script the editor will Save to — verify it matches your intended target before saving)', {
    source: z.string().describe('Pine Script source code to inject'),
    reason: z.string().optional().describe('Optional context (e.g. "TM-230: warning fix") logged to pine-actions.log'),
  }, async ({ source, reason }) => {
    try { return jsonResult(await core.setSource({ source, reason })); }
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

  server.tool('pine_open', 'DEPRECATED — loads a script\'s source into the CURRENT editor WITHOUT changing the editor\'s bound script (Save/Publish target stays unchanged). Risk: a subsequent save overwrites the bound script with the loaded source. Use pine_open_gui to actually switch scripts.', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_open_gui', 'Really switch the Pine Editor to another saved script by driving TradingView\'s own "Open script…" flow, so the editor REBINDS (Save/Publish then target the new script). Verifies the switch by polling the editor title and throws if it did not change. Returns the canonical script_id. Logs the switch to pine-actions.log.', {
    name: z.string().describe('Name of the saved script to switch to (case-insensitive match)'),
    reason: z.string().optional().describe('Optional context (e.g. "TM-231: edit tmAlert") logged to pine-actions.log'),
  }, async ({ name, reason }) => {
    try { return jsonResult(await core.openScriptGui({ name, reason })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
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
}
