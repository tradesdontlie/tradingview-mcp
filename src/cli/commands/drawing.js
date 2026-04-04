import { register } from '../router.js';
import * as core from '../../core/drawing.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Drawing tool name (e.g., horizontal_line, trend_line, price_range, fibonacci_retracement)' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price' },
        time2: { type: 'string', description: 'Second point time' },
        text: { type: 'string', description: 'Text content (for annotation tools)' },
        overrides: { type: 'string', description: 'JSON style overrides' },
      },
      handler: (opts) => {
        const points = [{ time: Number(opts.time), price: Number(opts.price) }];
        if (opts.price2) points.push({ time: Number(opts.time2), price: Number(opts.price2) });
        return core.drawShape({ shape: opts.type || 'horizontal_line', points, overrides: opts.overrides, text: opts.text });
      },
    }],
    ['list', {
      description: 'List all drawings on the chart',
      handler: () => core.listDrawings(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (opts, positionals) => core.getProperties({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (opts, positionals) => core.removeOne({ entity_id: positionals[0] }),
    }],
    ['clear', {
      description: 'Remove all drawings',
      handler: () => core.clearAll(),
    }],
  ]),
});
