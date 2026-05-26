import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    date: z.string().optional().describe('Zoom to a specific trading day before screenshotting (ISO format: "2025-01-15"). Shows all bars for that calendar day. Chart view is not restored after.'),
  }, async ({ region, filename, method, date }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
