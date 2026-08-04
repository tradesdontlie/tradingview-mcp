import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, add-bulk, remove, lists, create, delete-list, switch)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['lists', {
      description: 'List all watchlists (id, name, symbol count, active)',
      handler: () => core.listLists(),
    }],
    ['create', {
      description: 'Create a new named watchlist (optional seed symbols)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name required. Usage: tv watchlist create "My List" NASDAQ:AAPL ES1!');
        return core.createList({ name: positionals[0], symbols: positionals.slice(1) });
      },
    }],
    ['delete-list', {
      description: 'Delete a whole watchlist by name (or --id)',
      options: { id: { type: 'string', description: 'Watchlist id (from `tv watchlist lists`)' } },
      handler: (opts, positionals) => {
        if (!positionals[0] && !opts.id) throw new Error('Name or --id required. Usage: tv watchlist delete-list "My List"');
        return core.deleteList({ id: opts.id, name: positionals[0] });
      },
    }],
    ['switch', {
      description: 'Switch the active watchlist by name (or --id)',
      options: { id: { type: 'string', description: 'Watchlist id (from `tv watchlist lists`)' } },
      handler: (opts, positionals) => {
        if (!positionals[0] && !opts.id) throw new Error('Name or --id required. Usage: tv watchlist switch "My List"');
        return core.switchList({ id: opts.id, name: positionals[0] });
      },
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['add-bulk', {
      description: 'Add multiple symbols to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist add-bulk AAPL MSFT');
        return core.addBulk({ symbols: positionals });
      },
    }],
    ['remove', {
      description: 'Remove one or more symbols from the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist remove AAPL MSFT');
        return core.remove({ symbols: positionals });
      },
    }],
  ]),
});
