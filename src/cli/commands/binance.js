import { register } from '../router.js';
import * as core from '../../core/binance.js';

register('binance', {
  description: 'Binance Spot Testnet tools (balance, klines, order, orders, cancel)',
  subcommands: new Map([
    ['balance', {
      description: 'Get testnet account balances',
      handler: () => core.accountInfo(),
    }],
    ['klines', {
      description: 'Get OHLCV candles for a symbol',
      options: {
        interval: { type: 'string', short: 'i', description: 'Candle interval (default 1m)' },
        limit: { type: 'string', short: 'l', description: 'Number of candles (default 100)' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv binance klines BTCUSDT');
        return core.getKlines({
          symbol: positionals[0],
          interval: opts.interval || '1m',
          limit: opts.limit ? Number(opts.limit) : 100,
        });
      },
    }],
    ['order', {
      description: 'Place an order (market or limit)',
      options: {
        type: { type: 'string', short: 't', description: 'Order type: market (default) or limit' },
        price: { type: 'string', short: 'p', description: 'Limit price (required for limit orders)' },
        'dry-run': { type: 'boolean', description: 'Print the order without sending it' },
      },
      handler: (opts, positionals) => {
        const [symbol, side, quantity] = positionals;
        if (!symbol || !side || !quantity) {
          throw new Error('Usage: tv binance order <symbol> <buy|sell> <quantity> [-t market|limit] [-p price] [--dry-run]');
        }
        return core.placeOrder({
          symbol,
          side,
          quantity: Number(quantity),
          type: opts.type || 'market',
          price: opts.price ? Number(opts.price) : undefined,
          dry_run: !!opts['dry-run'],
        });
      },
    }],
    ['orders', {
      description: 'List open orders',
      handler: (opts, positionals) => core.getOpenOrders({ symbol: positionals[0] }),
    }],
    ['cancel', {
      description: 'Cancel an order',
      handler: (opts, positionals) => {
        const [symbol, orderId] = positionals;
        if (!symbol || !orderId) throw new Error('Usage: tv binance cancel <symbol> <order_id>');
        return core.cancelOrder({ symbol, order_id: Number(orderId) });
      },
    }],
  ]),
});
