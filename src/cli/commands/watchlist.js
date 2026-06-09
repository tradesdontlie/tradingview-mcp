import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, create, list, delete)',
  subcommands: new Map([
    ['get', {
      description: 'Get symbols from the active watchlist',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the active watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['create', {
      description: 'Create a named watchlist with optional initial symbols. Usage: tv watchlist create "AI – GPU demand" NASDAQ:NVDA NASDAQ:AMD',
      handler: (opts, positionals) => {
        const [name, ...symbols] = positionals;
        if (!name) throw new Error('Name required. Usage: tv watchlist create "My List" SYM1 SYM2');
        return core.create({ name, symbols });
      },
    }],
    ['list', {
      description: 'List all named watchlists with ids and symbol counts',
      handler: () => core.list(),
    }],
    ['delete', {
      description: 'Delete a named watchlist by id. Usage: tv watchlist delete 335018981',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Watchlist id required. Usage: tv watchlist delete <id>');
        return core.remove({ id: Number(positionals[0]) });
      },
    }],
  ]),
});
