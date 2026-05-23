import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, enable, disable, delete)',
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
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['enable', {
      description: 'Enable (restart) one or more alerts by id',
      options: {
        ids: { type: 'string', description: 'Comma-separated alert ids' },
      },
      handler: (opts) => core.enable({
        alert_ids: (opts.ids || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      }),
    }],
    ['disable', {
      description: 'Disable (stop) one or more alerts by id',
      options: {
        ids: { type: 'string', description: 'Comma-separated alert ids' },
      },
      handler: (opts) => core.disable({
        alert_ids: (opts.ids || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      }),
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
