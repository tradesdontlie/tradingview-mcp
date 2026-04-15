import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  server.tool(
    'screener_open',
    'Open the TradingView Stock Screener dialog. Returns { success, action, open, width, height }. No-op if already open.',
    {},
    async () => {
      try { return jsonResult(await core.open()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_close',
    'Close the Stock Screener dialog if open. No-op if already closed.',
    {},
    async () => {
      try { return jsonResult(await core.close()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_status',
    'Check whether the Stock Screener dialog is currently open. Returns { success, open, width, height }.',
    {},
    async () => {
      try { return jsonResult(await core.status()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_get',
    'Read rows from the currently-open Stock Screener. Returns the active screen name, column headers, row count, and up to `limit` rows as { column: value } objects. Call screener_open first.',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Maximum rows to return (default 100, max 500).'),
    },
    async ({ limit }) => {
      try { return jsonResult(await core.get({ limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
