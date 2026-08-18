import { register } from '../router.js';
import * as core from '../../core/mt5.js';

register('mt5', {
  description: 'MT5 live trading via the local bridge (scripts/mt5_bridge.py)',
  subcommands: new Map([
    ['health', {
      description: 'Check the MT5 bridge + terminal connection',
      handler: () => core.health(),
    }],
    ['account', {
      description: 'Get account balance, equity, margin, and demo/live status',
      handler: () => core.getAccount(),
    }],
    ['positions', {
      description: 'List open positions',
      options: {
        symbol: { type: 'string', short: 's', description: 'Filter by symbol' },
      },
      handler: (opts) => core.getPositions({ symbol: opts.symbol }),
    }],
    ['quote', {
      description: 'Get current bid/ask for a symbol',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv mt5 quote EURUSD');
        return core.getQuote({ symbol: positionals[0] });
      },
    }],
    ['order', {
      description: 'Place a market order. Usage: tv mt5 order buy EURUSD 0.01 --confirm',
      options: {
        sl: { type: 'string', description: 'Stop loss price' },
        tp: { type: 'string', description: 'Take profit price' },
        comment: { type: 'string', description: 'Order comment' },
        confirm: { type: 'boolean', description: 'Required — confirms this is a real order' },
      },
      handler: (opts, positionals) => {
        const [side, symbol, volume] = positionals;
        if (!side || !symbol || !volume) throw new Error('Usage: tv mt5 order <buy|sell> <symbol> <volume> --confirm');
        return core.placeOrder({
          side, symbol, volume: Number(volume),
          sl: opts.sl ? Number(opts.sl) : undefined,
          tp: opts.tp ? Number(opts.tp) : undefined,
          comment: opts.comment,
          confirm: !!opts.confirm,
        });
      },
    }],
    ['close', {
      description: 'Close an open position by ticket. Usage: tv mt5 close <ticket> --confirm',
      options: {
        volume: { type: 'string', description: 'Partial close volume' },
        confirm: { type: 'boolean', description: 'Required — confirms this closes a real position' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Ticket required. Usage: tv mt5 close 123456 --confirm');
        return core.closeOrder({
          ticket: Number(positionals[0]),
          volume: opts.volume ? Number(opts.volume) : undefined,
          confirm: !!opts.confirm,
        });
      },
    }],
    ['modify', {
      description: 'Modify SL/TP on an open position. Usage: tv mt5 modify <ticket> --sl 1.05 --tp 1.10',
      options: {
        sl: { type: 'string', description: 'New stop loss price' },
        tp: { type: 'string', description: 'New take profit price' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Ticket required. Usage: tv mt5 modify 123456 --sl 1.05');
        return core.modifyOrder({
          ticket: Number(positionals[0]),
          sl: opts.sl ? Number(opts.sl) : undefined,
          tp: opts.tp ? Number(opts.tp) : undefined,
        });
      },
    }],
  ]),
});
