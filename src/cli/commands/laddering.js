import { register } from '../router.js';
import * as core from '../../core/laddering.js';

register('laddering', {
  description: 'Price-ladder order construction (split a single order into N equally-sized, equally-spaced limit orders across a range)',
  subcommands: new Map([
    ['build', {
      description: 'Build a price ladder: N equally-sized orders at N equally-spaced price levels spanning [low, high], plus the resulting average fill price',
      options: {
        side: { type: 'string', description: 'Order side: buy|sell (required)' },
        size: { type: 'string', description: 'Total notional/quantity to split across the ladder (required)' },
        low: { type: 'string', description: 'Lower bound of the price range (required)' },
        high: { type: 'string', description: 'Upper bound of the price range (required)' },
        orders: { type: 'string', description: 'Number of equally-sized, equally-spaced orders — at least 2 (required)' },
      },
      handler: (opts) => {
        if (!opts.side || !opts.size || !opts.low || !opts.high || !opts.orders) {
          throw new Error('Usage: tv laddering build --side buy|sell --size <total> --low <price> --high <price> --orders <count>');
        }
        return core.buildLadderOrders({
          side: opts.side,
          totalSize: Number(opts.size),
          priceLow: Number(opts.low),
          priceHigh: Number(opts.high),
          numOrders: Number(opts.orders),
        });
      },
    }],
  ]),
});
