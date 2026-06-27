import { register } from '../router.js';
import * as core from '../../core/drawing.js';
import { requireFinite } from '../../connection.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, trend_line, rectangle, text' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time (for trend_line, rectangle)' },
        text: { type: 'string', description: 'Text content (for text shapes)' },
        overrides: { type: 'string', description: 'JSON style overrides' },
      },
      handler: (opts) => {
        if (opts.time === undefined) throw new Error('--time required (unix timestamp).');
        if (opts.price === undefined) throw new Error('--price required.');
        const point = { time: requireFinite(opts.time, 'time'), price: requireFinite(opts.price, 'price') };
        let point2;
        if (opts.price2 !== undefined) {
          if (opts.time2 === undefined) throw new Error('--time2 required when --price2 is given.');
          point2 = { time: requireFinite(opts.time2, 'time2'), price: requireFinite(opts.price2, 'price2') };
        }
        return core.drawShape({ shape: opts.type || 'horizontal_line', point, point2, overrides: opts.overrides, text: opts.text });
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
