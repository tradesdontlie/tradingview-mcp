import { register } from '../router.js';
import * as core from '../../core/watchlist.js';
import * as smaFibScan from '../../core/sma-fib-watchlist-scan.js';
import { RSI_BULLISH_CONDITIONS } from '../../core/rsi-attention.js';
import { SMA_FIB_ATTENTION_CONDITIONS } from '../../core/sma-fib-attention.js';
import { scanUnifiedAttention } from '../../core/unified-attention-scan.js';

const ATTENTION_CONDITION_SET = new Set([
  ...SMA_FIB_ATTENTION_CONDITIONS,
  ...RSI_BULLISH_CONDITIONS,
]);

function nonnegativePercentage(value, label, fallback) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new TypeError(`${label} must be a finite, non-negative percentage.`);
  }
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a finite, non-negative percentage.`);
  }
  return parsed;
}

function commaList(value, label, allowed, transform = item => item) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty comma-separated list.`);
  }
  const items = [...new Set(value.split(',').map(item => transform(item.trim())))];
  const unknown = items.filter(item => !allowed.has(item));
  if (unknown.length) throw new TypeError(`${label} has unknown values: ${unknown.join(', ')}.`);
  return items;
}

function minimumFamilies(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 3) {
    throw new TypeError('--minimum-families must be an integer from 0 to 3.');
  }
  return parsed;
}

function requireExclusiveChartUseFlag(opts) {
  if (opts['exclusive-chart-use-confirmed'] === true) return true;
  const error = new Error(
    'Pass --exclusive-chart-use-confirmed only after ensuring no person, task, or other chart tool will use the active chart during this scan.',
  );
  error.code = 'exclusive_chart_use_unconfirmed';
  throw error;
}

register('watchlist', {
  description: 'Watchlist tools (get, attention scans, add, add-bulk, remove)',
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
    ['sma-fib-scan', {
      description: 'Scan the active watchlist, or supplied exchange-qualified symbols, for independent 200D/200W MA and causal Fib attention states',
      options: {
        'price-buffer': {
          type: 'string',
          description: 'Default independent MA and Fib price/range buffers in percent (default: 5)',
        },
        'alignment-tolerance': {
          type: 'string',
          description: 'Maximum structural SMA-to-pocket gap in percent (default: 0)',
        },
        'ma-buffer': {
          type: 'string',
          description: 'Independent MA distance buffer in percent (defaults to --price-buffer)',
        },
        'fib-buffer': {
          type: 'string',
          description: 'Independent Fib-pocket distance buffer in percent (defaults to --price-buffer)',
        },
        'exclusive-chart-use-confirmed': {
          type: 'boolean',
          description: 'Required: confirm exclusive use of the active chart for the full scan',
        },
      },
      handler: (opts, positionals) => {
        const priceBufferPct = nonnegativePercentage(opts['price-buffer'], '--price-buffer', 5);
        const options = {
          priceBufferPct,
          alignmentTolerancePct: nonnegativePercentage(
            opts['alignment-tolerance'],
            '--alignment-tolerance',
            0,
          ),
          maBufferPct: nonnegativePercentage(opts['ma-buffer'], '--ma-buffer', priceBufferPct),
          fibBufferPct: nonnegativePercentage(opts['fib-buffer'], '--fib-buffer', priceBufferPct),
          exclusiveChartUseConfirmed: requireExclusiveChartUseFlag(opts),
        };
        return positionals.length
          ? smaFibScan.scanSmaFibWatchlist({ ...options, symbols: positionals })
          : smaFibScan.scanCurrentSmaFibWatchlist(options);
      },
    }],
    ['attention-scan', {
      description: 'Scan the active watchlist, or supplied symbols, for ranked Daily/Weekly MA, Fib, and bullish-RSI attention states',
      options: {
        'price-buffer': {
          type: 'string',
          description: 'Default independent MA and Fib current-price buffer in percent (default: 5)',
        },
        'ma-buffer': {
          type: 'string',
          description: 'Independent MA buffer in percent (defaults to --price-buffer)',
        },
        'fib-buffer': {
          type: 'string',
          description: 'Independent Fib-pocket buffer in percent (defaults to --price-buffer)',
        },
        'alignment-tolerance': {
          type: 'string',
          description: 'Structural SMA-to-pocket confluence gap in percent (default: 0)',
        },
        conditions: {
          type: 'string',
          description: 'Comma-separated exact conditions, e.g. FIB_INSIDE,RSI_DEVELOPING_HIDDEN_BULL',
        },
        families: {
          type: 'string',
          description: 'Comma-separated primitive families: ma,fib,rsi',
        },
        operator: {
          type: 'string',
          description: 'Combine condition/family lists with and or or (default: or)',
        },
        'minimum-families': {
          type: 'string',
          description: 'Minimum active primitive-family count from 0 to 3',
        },
        timeframes: {
          type: 'string',
          description: 'Comma-separated D,W timeframe filter',
        },
        'observation-kinds': {
          type: 'string',
          description: 'Comma-separated current,last_closed filter; with any other filter, omission means current only',
        },
        'exclude-provisional': {
          type: 'boolean',
          description: 'Exclude unclosed Daily/Weekly observations',
        },
        'require-complete-sources': {
          type: 'boolean',
          description: 'Require exact same-bar SMA/Fib and RSI coverage',
        },
        'rsi-kinds': {
          type: 'string',
          description: 'Comma-separated RSI kinds: regular,hidden',
        },
        'rsi-stages': {
          type: 'string',
          description: 'Comma-separated RSI stages: WATCH,DEVELOPING_ACTIVE,NEW_DEVELOPING,CONFIRMED',
        },
        'exclusive-chart-use-confirmed': {
          type: 'boolean',
          description: 'Required: confirm exclusive use of the active chart for the full scan',
        },
      },
      handler: (opts, positionals) => {
        const priceBufferPct = nonnegativePercentage(opts['price-buffer'], '--price-buffer', 5);
        const conditions = commaList(
          opts.conditions,
          '--conditions',
          ATTENTION_CONDITION_SET,
          item => item.toUpperCase(),
        );
        const families = commaList(
          opts.families,
          '--families',
          new Set(['ma', 'fib', 'rsi']),
          item => item.toLowerCase(),
        );
        const timeframes = commaList(
          opts.timeframes,
          '--timeframes',
          new Set(['D', 'W']),
          item => item.toUpperCase(),
        );
        const observationKinds = commaList(
          opts['observation-kinds'],
          '--observation-kinds',
          new Set(['current', 'last_closed']),
          item => item.toLowerCase(),
        );
        const rsiKinds = commaList(
          opts['rsi-kinds'],
          '--rsi-kinds',
          new Set(['regular', 'hidden']),
          item => item.toLowerCase(),
        );
        const rsiStages = commaList(
          opts['rsi-stages'],
          '--rsi-stages',
          new Set(['WATCH', 'DEVELOPING_ACTIVE', 'NEW_DEVELOPING', 'CONFIRMED']),
          item => item.toUpperCase(),
        );
        const operator = opts.operator?.toLowerCase() ?? 'or';
        if (operator !== 'and' && operator !== 'or') {
          throw new TypeError('--operator must be and or or.');
        }
        const minimumFamilyCount = minimumFamilies(opts['minimum-families']);
        const includeProvisional = opts['exclude-provisional'] !== true;
        const requireCompleteSources = opts['require-complete-sources'] === true;
        const queryRequested = conditions !== undefined
          || families !== undefined
          || timeframes !== undefined
          || observationKinds !== undefined
          || rsiKinds !== undefined
          || rsiStages !== undefined
          || minimumFamilyCount !== undefined
          || !includeProvisional
          || requireCompleteSources;
        const options = {
          priceBufferPct,
          maBufferPct: nonnegativePercentage(opts['ma-buffer'], '--ma-buffer', priceBufferPct),
          fibBufferPct: nonnegativePercentage(opts['fib-buffer'], '--fib-buffer', priceBufferPct),
          alignmentTolerancePct: nonnegativePercentage(
            opts['alignment-tolerance'],
            '--alignment-tolerance',
            0,
          ),
          exclusiveChartUseConfirmed: requireExclusiveChartUseFlag(opts),
        };
        if (positionals.length) options.symbols = positionals;
        if (queryRequested) {
          options.query = {
            operator,
            includeProvisional,
            requireCompleteSources,
          };
          if (conditions !== undefined) options.query.conditions = conditions;
          if (families !== undefined) options.query.families = families;
          if (timeframes !== undefined) options.query.timeframes = timeframes;
          if (observationKinds !== undefined) {
            options.query.observationKinds = observationKinds;
          }
          if (rsiKinds !== undefined) options.query.rsiKinds = rsiKinds;
          if (rsiStages !== undefined) options.query.rsiStages = rsiStages;
          if (minimumFamilyCount !== undefined) {
            options.query.minimumFamilyCount = minimumFamilyCount;
          }
        }
        return scanUnifiedAttention(options);
      },
    }],
  ]),
});
