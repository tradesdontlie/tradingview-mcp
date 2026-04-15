import { register } from '../router.js';
import * as core from '../../core/screener.js';
import * as screens from '../../core/screener_screens.js';
import * as filters from '../../core/screener_filters.js';
import * as columns from '../../core/screener_columns.js';

register('screener', {
  description: 'Stock Screener — dialog lifecycle + screens / filters / columns management',
  subcommands: new Map([
    // Dialog lifecycle ────────────────────────────────────────────────
    ['open', {
      description: 'Open the Stock Screener dialog',
      handler: () => core.open(),
    }],
    ['close', {
      description: 'Close the Stock Screener dialog',
      handler: () => core.close(),
    }],
    ['status', {
      description: 'Check whether the Stock Screener is open',
      handler: () => core.status(),
    }],
    ['get', {
      description: 'Read rows from the open Stock Screener (run `tv screener open` first)',
      options: {
        limit: { type: 'string', short: 'l', description: 'Max rows to return (default 100, max 500)' },
      },
      handler: (opts) => core.get({ limit: opts.limit ? Number(opts.limit) : undefined }),
    }],

    // Screens (saved presets) ─────────────────────────────────────────
    ['active', {
      description: 'Show the currently active screen name',
      handler: () => screens.active(),
    }],
    ['menu-actions', {
      description: 'Inspect which screen actions are currently enabled in the UI',
      handler: () => screens.menu_actions(),
    }],
    ['save', {
      description: 'Save changes to the current screen (no-op if nothing to save or built-in preset)',
      handler: () => screens.save(),
    }],
    ['save-as', {
      description: '(stretch) Save current state as a new named screen',
      options: {
        name: { type: 'string', short: 'n', description: 'New screen name' },
      },
      handler: (opts) => screens.save_as({ name: opts.name }),
    }],
    ['switch', {
      description: '(stretch) Switch to a saved screen by name',
      options: {
        name: { type: 'string', short: 'n', description: 'Screen name to switch to' },
      },
      handler: (opts) => screens.switchTo({ name: opts.name }),
    }],
    ['delete-screen', {
      description: '(stretch) Delete a saved screen by name',
      options: {
        name: { type: 'string', short: 'n', description: 'Screen name to delete' },
      },
      handler: (opts) => screens.remove({ name: opts.name }),
    }],
    ['rename', {
      description: '(stretch) Rename a saved screen',
      options: {
        name: { type: 'string', description: 'Current name' },
        'new-name': { type: 'string', description: 'New name' },
      },
      handler: (opts) => screens.rename({ name: opts.name, new_name: opts['new-name'] }),
    }],
    ['create-new', {
      description: '(stretch) Create a new empty screen with a name',
      options: {
        name: { type: 'string', short: 'n', description: 'New screen name' },
      },
      handler: (opts) => screens.createNew({ name: opts.name }),
    }],

    // Filters ─────────────────────────────────────────────────────────
    ['filters', {
      description: 'List active filter pills on the current screen',
      handler: () => filters.list(),
    }],
    ['filter-remove', {
      description: 'Remove a filter pill by label (idempotent)',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter label (e.g. "Market cap")' },
      },
      handler: (opts) => filters.remove({ filter: opts.filter }),
    }],
    ['filter-clear', {
      description: 'Remove every filter pill from the current screen',
      handler: () => filters.clear(),
    }],
    ['filter-add', {
      description: '(stretch) Add a filter pill',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter name' },
        operator: { type: 'string', description: 'Comparison operator' },
        value: { type: 'string', description: 'Value' },
      },
      handler: (opts) => filters.add({ filter: opts.filter, operator: opts.operator, value: opts.value }),
    }],
    ['filter-modify', {
      description: '(stretch) Modify a filter pill value',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter name' },
        operator: { type: 'string', description: 'New operator' },
        value: { type: 'string', description: 'New value' },
      },
      handler: (opts) => filters.modify({ filter: opts.filter, operator: opts.operator, value: opts.value }),
    }],

    // Columns ─────────────────────────────────────────────────────────
    ['columns', {
      description: 'List current column headers',
      handler: () => columns.list(),
    }],
    ['column-reset', {
      description: '(stretch) Reset columns to screen default',
      handler: () => columns.reset(),
    }],
    ['column-remove', {
      description: '(stretch) Hide a column by name',
      options: {
        column: { type: 'string', short: 'c', description: 'Column name' },
      },
      handler: (opts) => columns.remove({ column: opts.column }),
    }],
    ['column-add', {
      description: '(stretch) Show a column by name',
      options: {
        column: { type: 'string', short: 'c', description: 'Column name' },
      },
      handler: (opts) => columns.add({ column: opts.column }),
    }],
    ['column-reorder', {
      description: '(stretch) Reorder columns to a desired layout',
      options: {
        columns: { type: 'string', description: 'Comma-separated desired column order' },
      },
      handler: (opts) => columns.reorder({ columns: opts.columns ? opts.columns.split(',').map(s => s.trim()) : [] }),
    }],
  ]),
});
