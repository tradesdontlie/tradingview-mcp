import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/drawing.js';

export function registerDrawingTools(server) {
  server.tool('draw_shape', 'Draw a shape/line on the chart', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text shapes'),
  }, async ({ shape, point, point2, overrides, text }) => {
    try { return jsonResult(await core.drawShape({ shape, point, point2, overrides, text })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_list', 'List all shapes/drawings on the chart', {}, async () => {
    try { return jsonResult(await core.listDrawings()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_clear', 'Remove all drawings from the chart', {}, async () => {
    try { return jsonResult(await core.clearAll()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.removeOne({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getProperties({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_position', 'Draw a Long or Short position on the chart with entry, take-profit, and stop-loss price levels', {
    direction: z.enum(['long', 'short']).describe('Trade direction'),
    entry_price: z.coerce.number().describe('Entry price level'),
    stop_loss: z.coerce.number().describe('Stop-loss price level'),
    take_profit: z.coerce.number().describe('Take-profit price level'),
    entry_time: z.coerce.number().optional().describe('Unix timestamp for horizontal placement (defaults to latest visible bar)'),
    account_size: z.coerce.number().optional().describe('Account balance for P&L calculation'),
    risk: z.coerce.number().optional().describe('Risk as percentage of account (e.g. 2 for 2%)'),
    lot_size: z.coerce.number().optional().describe('Lot/contract size'),
  }, async ({ direction, entry_price, stop_loss, take_profit, entry_time, account_size, risk, lot_size }) => {
    try { return jsonResult(await core.drawPosition({ direction, entry_price, stop_loss, take_profit, entry_time, account_size, risk, lot_size })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
