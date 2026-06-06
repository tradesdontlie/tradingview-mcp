import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/drawing.js';

export function registerDrawingTools(server) {
  server.tool('draw_shape', 'Draw a shape/line on the chart', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, parallel_channel, pitchfork, text'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    point3: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Third point for three-point shapes (parallel_channel, pitchfork)'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text shapes'),
  }, async ({ shape, point, point2, point3, overrides, text }) => {
    try { return jsonResult(await core.drawShape({ shape, point, point2, point3, overrides, text })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_parallel_channel', 'Draw a parallel channel (two parallel rails) using TradingView\'s native parallel_channel tool. Define the main rail with point + point2; set the channel width in price units with `width` (positive = second rail below the main rail), or pass an explicit point3 the parallel rail passes through. Both rails stay truly parallel.', {
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('Main rail start { time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('Main rail end { time: unix_timestamp, price: number }'),
    width: z.coerce.number().optional().describe('Channel width in price units; positive puts the second rail below the main rail. Ignored if point3 is given.'),
    point3: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Explicit point the parallel rail passes through (overrides width)'),
    overrides: z.string().optional().describe('JSON string of style overrides (parallel_channel has no text label; style it here)'),
  }, async ({ point, point2, width, point3, overrides }) => {
    try { return jsonResult(await core.drawParallelChannel({ point, point2, width, point3, overrides })); }
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
}
