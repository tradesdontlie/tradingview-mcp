import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/drawing.js';

// All valid TradingView drawing tool names, grouped by category
const DRAW_TOOLS = {
  lines: [
    'horizontal_line', 'horizontal_ray', 'vertical_line',
    'trend_line', 'ray', 'extended', 'arrow', 'cross_line',
    'info_line', 'trend_angle',
  ],
  channels: [
    'parallel_channel', 'channel', 'disjoint_channel',
    'flat_bottom',
  ],
  fibonacci: [
    'fibonacci_retracement', 'fibonacci_extension',
    'fib_channel', 'fib_circles', 'fib_spiral',
    'fib_speed_resistance_fan', 'fib_speed_resistance_arcs',
    'fib_timezone', 'fib_wedge',
  ],
  gann: [
    'gann_square', 'gann_fan', 'gann_complex',
    'pitchfork', 'inside_pitchfork', 'schiff_pitchfork_modified',
  ],
  patterns: [
    'head_and_shoulders', 'triangle_pattern',
    'three_drives', 'cypher_pattern', 'abcd_pattern',
    'elliott_impulse_wave', 'elliott_correction_wave',
  ],
  measurement: [
    'price_range', 'date_range', 'date_and_price_range',
    'measure', 'measure_tool', 'ruler',
  ],
  shapes: [
    'rectangle', 'rotated_rectangle', 'ellipse', 'circle',
    'arc', 'polyline', 'path',
  ],
  analysis: [
    'anchored_volume_profile', 'fixed_range_volume_profile',
    'anchored_vwap', 'regression_trend',
  ],
  trading: [
    'long_position', 'short_position',
    'risk_reward_long', 'risk_reward_short',
    'forecast', 'projection',
  ],
  annotation: [
    'text', 'callout', 'comment', 'note', 'anchored_note',
    'balloon', 'signpost', 'flag', 'price_label', 'price_note',
    'arrow_up', 'arrow_down', 'arrow_marker',
    'sticker', 'image', 'emoji',
  ],
  misc: [
    'brush', 'highlighter', 'bars_pattern', 'ghost_feed',
    'time_cycles', 'sine_line', 'marker',
  ],
};

const ALL_TOOL_NAMES = Object.values(DRAW_TOOLS).flat();

const pointSchema = z.object({ time: z.coerce.number(), price: z.coerce.number() });

function buildToolDescription() {
  const lines = ['Draw a tool on the chart. Pass `points` array with {time, price} objects (most tools need 2 points, some need 1).', 'Available tools by category:'];
  for (const [category, tools] of Object.entries(DRAW_TOOLS)) {
    lines.push(`  ${category}: ${tools.join(', ')}`);
  }
  return lines.join('\n');
}

export function registerDrawingTools(server) {
  server.tool('draw', buildToolDescription(), {
    tool: z.enum(ALL_TOOL_NAMES).describe('Drawing tool name'),
    points: z.array(pointSchema).min(1).max(10).describe('Array of {time, price} points. Most tools need 2 points.'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for annotation tools'),
  }, async ({ tool, points, overrides, text }) => {
    try { return jsonResult(await core.drawShape({ shape: tool, points, overrides, text })); }
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
