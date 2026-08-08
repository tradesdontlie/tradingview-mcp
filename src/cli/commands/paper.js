import { register } from '../router.js';
import * as core from '../../core/paper.js';

register('paper', {
  description: 'TradingView native Paper Trading (observability + guarded mutations)',
  subcommands: new Map([
    ['status', {
      description: 'Show Paper Trading status (session, panel, broker, mutation safety)',
      handler: () => core.getStatus(),
    }],
    ['panel', {
      description: 'Open/close/toggle the Trading Panel (paper_trading widget)',
      handler: (opts, positionals) => core.openPanel({ action: positionals[0] || 'open' }),
    }],
    ['connect', {
      description: 'Connect native Paper Trading broker (id Paper)',
      handler: () => core.connect(),
    }],
    ['account', {
      description: 'Show active Paper account summary',
      handler: () => core.getAccount(),
    }],
    ['accounts', {
      description: 'List Paper accounts',
      handler: () => core.listAccounts(),
    }],
    ['switch-account', {
      description: 'Switch active Paper account by id',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv paper switch-account <account_id>');
        return core.switchAccount({ account_id: positionals[0] });
      },
    }],
    ['positions', {
      description: 'List open Paper positions',
      handler: () => core.listPositions(),
    }],
    ['orders', {
      description: 'List active Paper orders (use --history for history)',
      options: {
        history: { type: 'boolean', description: 'Return order history instead of active orders' },
      },
      handler: (opts) => core.listOrders({ history: !!opts.history }),
    }],
    ['place', {
      description: 'Place a Paper order. Usage: tv paper place buy market --qty 1 [--tif WEEK|DAY|MONTH|GTD] [--duration-datetime ISO|ms]',
      options: {
        qty: { type: 'string', short: 'q', description: 'Quantity' },
        symbol: { type: 'string', short: 's', description: 'Symbol (default: chart)' },
        price: { type: 'string', description: 'Limit price' },
        'stop-price': { type: 'string', description: 'Stop price' },
        'take-profit': { type: 'string', description: 'Take profit' },
        'stop-loss': { type: 'string', description: 'Stop loss' },
        tif: { type: 'string', description: 'Time in force: DAY, WEEK, MONTH, GTD' },
        'duration-datetime': { type: 'string', description: 'GTD expiry (ISO or unix ms)' },
      },
      handler: (opts, positionals) => {
        const side = positionals[0];
        const type = positionals[1] || 'market';
        if (!side) throw new Error('Usage: tv paper place <buy|sell> [market|limit|stop|stop_limit] --qty N');
        if (opts.qty == null) throw new Error('--qty required');
        return core.placeOrder({
          side,
          type,
          qty: Number(opts.qty),
          symbol: opts.symbol,
          price: opts.price != null ? Number(opts.price) : undefined,
          stop_price: opts['stop-price'] != null ? Number(opts['stop-price']) : undefined,
          take_profit: opts['take-profit'] != null ? Number(opts['take-profit']) : undefined,
          stop_loss: opts['stop-loss'] != null ? Number(opts['stop-loss']) : undefined,
          tif: opts.tif,
          duration_datetime: opts['duration-datetime'],
        });
      },
    }],
    ['cancel', {
      description: 'Cancel a Paper order by id',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv paper cancel <order_id>');
        return core.cancelOrder({ order_id: positionals[0] });
      },
    }],
    ['modify', {
      description: 'Modify a Paper order',
      options: {
        qty: { type: 'string', description: 'New quantity' },
        price: { type: 'string', description: 'New limit price' },
        'stop-price': { type: 'string', description: 'New stop price' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv paper modify <order_id> [--qty N] [--price N]');
        return core.modifyOrder({
          order_id: positionals[0],
          qty: opts.qty != null ? Number(opts.qty) : undefined,
          price: opts.price != null ? Number(opts.price) : undefined,
          stop_price: opts['stop-price'] != null ? Number(opts['stop-price']) : undefined,
        });
      },
    }],
    ['close', {
      description: 'Close a Paper position (full or partial)',
      options: {
        qty: { type: 'string', description: 'Partial quantity' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv paper close <position_id|symbol> [--qty N]');
        return core.closePosition({ position_id: positionals[0], qty: opts.qty != null ? Number(opts.qty) : undefined });
      },
    }],
    ['brackets', {
      description: 'Set or clear SL/TP on a Paper position',
      options: {
        'stop-loss': { type: 'string', description: 'Stop loss price' },
        'take-profit': { type: 'string', description: 'Take profit price' },
        clear: { type: 'boolean', description: 'Clear both SL and TP' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv paper brackets <position_id|symbol> --stop-loss N --take-profit N | --clear');
        return core.setBrackets({
          position_id: positionals[0],
          stop_loss: opts['stop-loss'] != null ? Number(opts['stop-loss']) : undefined,
          take_profit: opts['take-profit'] != null ? Number(opts['take-profit']) : undefined,
          clear: !!opts.clear,
        });
      },
    }],
  ]),
});
