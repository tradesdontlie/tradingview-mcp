import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete, log)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['log', {
      description: 'List recently fired/triggered alerts (alert log)',
      options: {
        limit: { type: 'string', short: 'n', description: 'Max fired alerts to return (default 20, max 100)' },
      },
      handler: (opts) => core.getLog({ limit: opts.limit ? Number(opts.limit) : undefined }),
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
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
        id: { type: 'string', description: 'Alert id to delete (from alert list)' },
      },
      handler: (opts) => core.deleteAlerts({ delete_all: opts.all, alert_id: opts.id ? Number(opts.id) : undefined }),
    }],
  ]),
});
