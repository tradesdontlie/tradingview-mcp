import { register } from '../router.js';
import { gapScreener } from '../../core/tv_screener.js';

register('gap', {
  description: 'Screen gap-up/down stocks with market-cap + volume filters',
  options: {
    direction: { type: 'string', short: 'd', description: "up | down | both (default both)" },
    'min-gap':  { type: 'string', short: 'g', description: 'Absolute gap threshold %, default 0.5' },
    'min-mcap': { type: 'string', short: 'm', description: 'Minimum market cap in crore, e.g. 5000' },
    'min-relvol': { type: 'string', short: 'v', description: 'Minimum relative volume (1 = avg)' },
    index:     { type: 'string', short: 'i', description: 'Restrict to index: "NIFTY 500" etc.' },
    exchange:  { type: 'string', short: 'e', description: 'Exchange (default NSE)' },
    screener:  { type: 'string', short: 's', description: 'Screener region (default india)' },
    limit:     { type: 'string', short: 'l', description: 'Max rows per direction (default 100)' },
  },
  handler: (opts) => gapScreener({
    direction: opts.direction || 'both',
    minGapPct: opts['min-gap'] != null ? Number(opts['min-gap']) : 0.5,
    minMarketCapCr: opts['min-mcap'] != null ? Number(opts['min-mcap']) : 0,
    minRelVol: opts['min-relvol'] != null ? Number(opts['min-relvol']) : 0,
    index: opts.index,
    exchange: opts.exchange || 'NSE',
    screener: opts.screener || 'india',
    limit: opts.limit != null ? Number(opts.limit) : 100,
  }),
});
