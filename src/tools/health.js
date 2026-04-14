import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
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

  server.tool('tv_ensure', 'Ensure TradingView Desktop is running with CDP enabled. Idempotent: no-op if CDP is already up. If TV is running without CDP, kills and relaunches. If TV is not running, launches it. Call this before any TV tool when unsure if CDP is available.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
  }, async ({ port }) => {
    try { return jsonResult(await core.ensureCDP({ port })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_reconnect', 'Reconnect TradingView Desktop by reloading the page to reclaim the backend session. Use when TV was opened in a browser/phone and the Desktop session went stale.', {}, async () => {
    try { return jsonResult(await core.reconnect()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
