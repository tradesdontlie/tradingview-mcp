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
  }, async ({ region, filename, method, date, timeframe }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, date, timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
