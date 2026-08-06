import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, add-bulk, remove)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
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
