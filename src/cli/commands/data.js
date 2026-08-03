import { register } from '../router.js';
import * as core from '../../core/data.js';

register('quote', {
  description: 'Get real-time price quote',
  handler: (opts, positionals) => core.getQuote({ symbol: positionals[0] }),
});

register('ohlcv', {
  description: 'Get OHLCV bar data',
  options: {
    count: { type: 'string', short: 'n', description: 'Number of bars (default 100, max 500)' },
    summary: { type: 'boolean', short: 's', description: 'Return summary stats instead of all bars' },
  },
  handler: (opts) => core.getOhlcv({
    count: opts.count ? Number(opts.count) : undefined,
    summary: opts.summary,
  }),
});

register('values', {
  description: 'Get current indicator values from data window',
  handler: () => core.getStudyValues(),
});

// Shared option for every symbol-data subcommand: omit to use the chart symbol.
const SYMBOL_OPT = { type: 'string', short: 's', description: 'Exchange-qualified symbol (e.g. NASDAQ:AMZN); default = chart symbol' };

register('data', {
  description: 'Advanced data tools (lines, labels, tables, boxes, strategy, trades, equity, depth, symbol panels)',
  subcommands: new Map([
    ['lines', {
      description: 'Get Pine Script line.new() price levels',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw line data' },
      },
      handler: (opts) => core.getPineLines({ study_filter: opts.filter, verbose: opts.verbose }),
    }],
    ['labels', {
      description: 'Get Pine Script label.new() annotations',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        max: { type: 'string', short: 'n', description: 'Max labels per study (default 50)' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw label data' },
      },
      handler: (opts) => core.getPineLabels({ study_filter: opts.filter, max_labels: opts.max ? Number(opts.max) : undefined, verbose: opts.verbose }),
    }],
    ['tables', {
      description: 'Get Pine Script table.new() data',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
      },
      handler: (opts) => core.getPineTables({ study_filter: opts.filter }),
    }],
    ['boxes', {
      description: 'Get Pine Script box.new() price zones',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw box data' },
      },
      handler: (opts) => core.getPineBoxes({ study_filter: opts.filter, verbose: opts.verbose }),
    }],
    ['strategy', {
      description: 'Get strategy performance metrics',
      handler: () => core.getStrategyResults(),
    }],
    ['trades', {
      description: 'Get strategy trade list',
      options: {
        max: { type: 'string', short: 'n', description: 'Max trades to return' },
      },
      handler: (opts) => core.getTrades({ max_trades: opts.max ? Number(opts.max) : undefined }),
    }],
    ['equity', {
      description: 'Get strategy equity curve',
      handler: () => core.getEquity(),
    }],
    ['depth', {
      description: 'Get order book / DOM data',
      handler: () => core.getDepth(),
    }],
    ['indicator', {
      description: 'Get indicator info and inputs by entity ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv data indicator eFu1Ot');
        return core.getIndicator({ entity_id: positionals[0] });
      },
    }],
    ['key-stats', {
      description: 'Market cap, next earnings, volume, dividend yield, P/E',
      options: { symbol: SYMBOL_OPT },
      handler: (opts) => core.getKeyStats({ symbol: opts.symbol }),
    }],
    ['technicals', {
      description: 'Technicals consensus gauges + indicator values',
      options: {
        symbol: SYMBOL_OPT,
        timeframe: { type: 'string', short: 't', description: 'Timeframe: 1, 5, 15, 30, 60, 120, 240, 1D, 1W, 1M' },
      },
      handler: (opts) => core.getTechnicals({ symbol: opts.symbol, timeframe: opts.timeframe }),
    }],
    ['forecast', {
      description: 'Analyst price targets, upside % and consensus rating',
      options: { symbol: SYMBOL_OPT },
      handler: (opts) => core.getForecast({ symbol: opts.symbol }),
    }],
    ['financials', {
      description: 'Income statement history (revenue, net income, EPS, margins)',
      options: {
        symbol: SYMBOL_OPT,
        period: { type: 'string', short: 'p', description: 'annual (default) or quarterly' },
        limit: { type: 'string', short: 'n', description: 'Periods to return (default 8, max 32)' },
      },
      handler: (opts) => core.getFinancials({
        symbol: opts.symbol, period: opts.period,
        limit: opts.limit ? Number(opts.limit) : undefined,
      }),
    }],
    ['seasonals', {
      description: 'Average return and win rate per calendar month (chart symbol)',
      options: { years: { type: 'string', short: 'y', description: 'Lookback in years (default 10, max 30)' } },
      handler: (opts) => core.getSeasonals({ years: opts.years ? Number(opts.years) : undefined }),
    }],
    ['news', {
      description: 'Recent news headlines',
      options: {
        symbol: SYMBOL_OPT,
        limit: { type: 'string', short: 'n', description: 'Max headlines (default 15, max 50)' },
      },
      handler: (opts) => core.getNews({ symbol: opts.symbol, limit: opts.limit ? Number(opts.limit) : undefined }),
    }],
    ['options', {
      description: 'ATM implied-volatility term structure',
      options: {
        symbol: SYMBOL_OPT,
        max: { type: 'string', short: 'n', description: 'Max expiries (default 10, max 30)' },
      },
      handler: (opts) => core.getOptions({ symbol: opts.symbol, max_expirations: opts.max ? Number(opts.max) : undefined }),
    }],
    ['etf', {
      description: 'ETF/fund profile (AUM, expense ratio, NAV)',
      options: { symbol: SYMBOL_OPT },
      handler: (opts) => core.getEtfProfile({ symbol: opts.symbol }),
    }],
    ['bond', {
      description: 'Bond/yield info (yield, coupon, maturity)',
      options: { symbol: SYMBOL_OPT },
      handler: (opts) => core.getBondInfo({ symbol: opts.symbol }),
    }],
  ]),
});
