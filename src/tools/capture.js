import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension). Combined with out_dir if provided, else written to the MCP default screenshots/ folder.'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    wait_for_render: z.boolean().optional().describe('Wait for the visible chart canvas to stabilize before capture. Useful after chart_set_symbol or chart_set_timeframe.'),
    out_dir: z.string().optional().describe('Directory to write the screenshot into. Absolute or relative to the MCP cwd. Created if missing.'),
    path: z.string().optional().describe('Full output path including filename. Wins over out_dir+filename. .png appended if no extension.'),
  }, async ({ region, filename, method, wait_for_render, out_dir, path }) => {
    try {
      return jsonResult(await core.captureScreenshot({
        region,
        filename,
        method,
        waitForRender: wait_for_render,
        out_dir,
        path,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
