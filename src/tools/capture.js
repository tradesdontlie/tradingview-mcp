import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    target_id: targetIdParam,
  }, async ({ region, filename, method, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.captureScreenshot({ region, filename, method }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
