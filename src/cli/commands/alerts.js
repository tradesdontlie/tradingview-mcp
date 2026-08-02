import { register } from '../router.js';
import * as core from '../../core/alerts.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

register('alert', {
  description: 'Alert tools (list, create, delete, sync)',
  subcommands: new Map([
    ['list', {
      description: 'List normalized TradingView alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create an exact price or live Pine-indicator alert',
      options: {
        symbol: { type: 'string', short: 's', description: 'Exchange-qualified symbol (required)' },
        timeframe: { type: 'string', short: 't', description: 'Exact TradingView timeframe (required)' },
        kind: { type: 'string', short: 'k', description: 'price or indicator (required)' },
        condition: { type: 'string', short: 'c', description: 'Price condition or exact Pine condition name' },
        price: { type: 'string', short: 'p', description: 'Positive level for price alerts' },
        indicator: { type: 'string', short: 'i', description: 'Exact live indicator title' },
        frequency: { type: 'string', description: 'once, once_per_bar, or once_per_bar_close' },
        expiration: { type: 'string', short: 'e', description: 'ISO-8601 timestamp with offset' },
        message: { type: 'string', short: 'm', description: 'Exact deterministic alert message' },
        'dry-run': { type: 'boolean', description: 'Validate without creating an alert' },
      },
      handler: (opts) => core.create({
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        kind: opts.kind,
        condition: opts.condition,
        price: opts.price === undefined ? undefined : Number(opts.price),
        indicator: opts.indicator,
        frequency: opts.frequency,
        expiration: opts.expiration,
        message: opts.message,
        dry_run: !!opts['dry-run'],
      }),
    }],
    ['sync', {
      description: 'Idempotently synchronize a complete alert plan from JSON',
      options: {
        file: { type: 'string', short: 'f', description: 'Alert-plan JSON file (required)' },
        'dry-run': { type: 'boolean', description: 'Return the diff without creating or deleting alerts' },
      },
      handler: async (opts) => {
        if (!opts.file) throw new Error('File required. Usage: tv alert sync --file <alerts.json> --dry-run');
        const filePath = resolve(opts.file);
        let plan;
        try {
          plan = JSON.parse(await readFile(filePath, 'utf8'));
        } catch (err) {
          throw new Error(`Could not read alert plan ${filePath}: ${err.message}`);
        }
        return core.syncAlerts({
          alerts: plan.alerts,
          replace_alert_ids: plan.replace_alert_ids || [],
          dry_run: !!opts['dry-run'] || plan.dry_run === true,
        });
      },
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
