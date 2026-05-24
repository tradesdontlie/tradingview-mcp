import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView, return current chart state, and list all available CDP targets/windows', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.tool('target_list', 'List all available CDP targets/windows exposed by TradingView Desktop', {}, async () => {
    try { return jsonResult(await core.targets()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('target_switch', 'Switch the MCP connection to a specific TradingView Desktop CDP target/window by target_id', {
    target_id: z.string().describe('CDP target id from tv_health_check or target_list'),
  }, async ({ target_id }) => {
    try { return jsonResult(await core.targetSwitch({ target_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.uiState())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
