import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    wait_for_render: z.boolean().optional().describe('Wait for the chart canvas to stabilize before capturing. Use after chart_set_symbol or chart_set_timeframe to avoid stale frames.'),
    output_dir: z.string().optional().describe('Absolute path to save directory (default: screenshots/ in project root)'),
  }, async ({ region, filename, method, wait_for_render, output_dir }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, waitForRender: wait_for_render, output_dir })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
