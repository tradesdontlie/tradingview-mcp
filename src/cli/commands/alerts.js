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
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete alerts (--all requires --confirm DELETE_ALL_ALERTS)',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts (requires --confirm)' },
        id: { type: 'string', description: 'Alert id to delete (from alert list)' },
        confirm: { type: 'string', description: `Must equal ${core.DELETE_ALL_CONFIRMATION} when --all is set` },
      },
      handler: (opts, positionals, _deps) => core.deleteAlerts({
        delete_all: opts.all,
        alert_id: opts.id ? Number(opts.id) : undefined,
        confirm: opts.confirm,
        _deps,
      }),
    }],
  ]),
});
