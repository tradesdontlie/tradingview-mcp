import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/profiler.js';

export function registerProfilerTools(server) {
  server.tool(
    'pine_profiler_enable',
    'Enable Pine Profiler mode for the currently open Pine script. Opens the editor "..." menu and toggles Profiler Mode on. Idempotent — re-calling returns was_already_enabled=true.',
    {},
    async () => {
      try { return jsonResult(await core.enableProfiler()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'pine_profiler_disable',
    'Disable Pine Profiler mode if currently enabled. Idempotent.',
    {},
    async () => {
      try { return jsonResult(await core.disableProfiler()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'pine_profiler_get_data',
    'Read the Pine Profiler panel and return per-line execution metrics (ms, pct of total, line number). Sorted hottest-first. Profiler must be enabled (see pine_profiler_enable). Pass top_n to limit output.',
    {
      top_n: z.coerce.number().int().positive().optional()
        .describe('Return only the N most expensive lines (sorted by ms desc, then pct desc)'),
    },
    async ({ top_n }) => {
      try { return jsonResult(await core.getProfilerData({ top_n })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'pine_runtime_warnings',
    'Read TradingView runtime warning/error banners on the chart pane (e.g., "script takes too long, 40s limit", max bars back, loop limit). Distinct from pine_get_errors (compile markers) and pine_get_console (log output). Pure read, no UI mutation.',
    {
      severity_filter: z.enum(['all', 'warning', 'error']).optional()
        .describe('Filter by severity (default: all)'),
    },
    async ({ severity_filter }) => {
      try { return jsonResult(await core.getRuntimeWarnings({ severity_filter })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'pine_profiler_probe',
    'Discovery tool — dump the DOM landscape around the profiler (anchors, menus, menu items) so a human can update selectors when TradingView ships a UI change. Use only when the other profiler tools report failure.',
    {},
    async () => {
      try { return jsonResult({ success: true, probe: await core.probeProfilerDom() }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
