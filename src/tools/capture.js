import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.enum(['full', 'chart', 'strategy_tester']).optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.enum(['cdp', 'api']).optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    persist: z.boolean().optional().describe('Whether to keep the saved PNG on disk (default true). false removes the artifact after returning its path/size.'),
    max_files: z.coerce.number().int().nonnegative().optional().describe('Retention: max PNGs to keep in screenshots/ (default 50). Oldest are pruned after capture.'),
    max_age_days: z.coerce.number().nonnegative().optional().describe('Retention: prune screenshots older than this many days (default 7).'),
    max_bytes: z.coerce.number().int().nonnegative().optional().describe('Retention: optional cap on total bytes of screenshots/ (default unlimited).'),
  }, async ({ region, filename, method, persist, max_files, max_age_days, max_bytes }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, persist, max_files, max_age_days, max_bytes })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
