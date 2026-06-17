import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, crossing_up, crossing_down, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
        symbol: { type: 'string', short: 's', description: 'Symbol (defaults to active chart)' },
        resolution: { type: 'string', short: 'r', description: 'Resolution (defaults to 1)' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
        symbol: opts.symbol,
        resolution: opts.resolution,
      }),
    }],
    ['delete', {
      description: 'Delete alerts (by id, price, or all)',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
        id: { type: 'string', description: 'Delete a single alert by alert_id' },
        price: { type: 'string', short: 'p', description: 'Delete every alert at this price level' },
      },
      handler: (opts) => core.deleteAlerts({
        delete_all: opts.all,
        alert_id: opts.id != null ? Number(opts.id) : undefined,
        price: opts.price != null ? Number(opts.price) : undefined,
      }),
    }],
  ]),
});
