import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection + chart state + multi-session contention (audit C4/A1-F2/A2-F6). Returns cdp_connected, target_*, chart_*, api_available, pine_evaluation_live, study_count, last_bar_time, tv_chart_tab_count, possible_session_contention, contention_warning, last_chart_mutation_id, probed_at. With probe_pine_evaluation=true (default) also counts concurrent tradingview.com/chart CDP targets — >1 surfaces a hard warning (TradingView Desktop app or other browser tabs silently freeze Pine eval).', {
    probe_pine_evaluation: z.coerce.boolean().optional().describe('Run the contention + pine-eval-liveness probe. Default true. Set false for a minimal heartbeat check.'),
  }, async ({ probe_pine_evaluation }) => {
    try { return jsonResult(await core.healthCheck({ probe_pine_evaluation: probe_pine_evaluation !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
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
