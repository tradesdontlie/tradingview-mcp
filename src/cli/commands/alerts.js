import { register } from '../router.js';
import * as core from '../../core/alerts.js';
import { requireFinite } from '../../connection.js';

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
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, crossing_up, crossing_down' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => {
        if (opts.price === undefined) throw new Error('Price required. Usage: tv alert create -p 24500 -c crossing');
        return core.create({
          price: requireFinite(opts.price, 'price'),
          condition: opts.condition || 'crossing',
          message: opts.message,
        });
      },
    }],
    ['delete', {
      description: 'Delete alerts by id or all',
      options: {
        id: { type: 'string', description: 'Alert id(s) to delete, comma-separated (from `alert list`)' },
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts) => {
        const ids = opts.id ? opts.id.split(',').map(s => requireFinite(s.trim(), 'id')) : undefined;
        return core.deleteAlerts({ alert_ids: ids, delete_all: opts.all });
      },
    }],
  ]),
});
