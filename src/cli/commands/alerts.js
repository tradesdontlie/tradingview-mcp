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
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
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
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts) => core.deleteAlerts({ delete_all: opts.all }),
    }],
  ]),
});
