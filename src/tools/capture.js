import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    date: z.string().optional().describe('Zoom to a specific trading day before screenshotting (ISO format: "2025-01-15"). Chart view is not restored after.'),
    timeframe: z.string().optional().describe('Timeframe to use for zoom window calculation (e.g. "5", "15", "60", "D"). Defaults to 5 (5m) if not set and chart resolution cannot be read. Overrides current chart resolution.'),
    ignore_overlay: z.boolean().optional().describe('Skip the pre-capture overlay check (session-disconnected, login, paywall…). Default false: capture fails fast with a clear action hint when a blocking dialog is over the chart. Set true to capture the modal itself.'),
    auto_fit: z.boolean().optional().describe('Pre-capture: expand the visible range to a sensible minimum bar count for the timeframe (see MIN_BARS_BY_TF) and trigger Y-axis autoscale so candles aren\'t squashed/clipped. Default true. Set false to keep the chart\'s current range + Y-scale verbatim.'),
    min_bars: z.number().optional().describe('Override the auto_fit min-bars guarantee. If unset, uses MIN_BARS_BY_TF for the current timeframe. "More is OK, less is not" — never shrinks an already-wide range.'),
  }, async ({ region, filename, method, date, timeframe, ignore_overlay, auto_fit, min_bars }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, date, timeframe, ignore_overlay, auto_fit, min_bars })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
