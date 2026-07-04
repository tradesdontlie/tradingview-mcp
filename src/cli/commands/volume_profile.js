import { register } from '../router.js';
import * as core from '../../core/volume_profile.js';

function parseBars(json) {
  let bars;
  try { bars = JSON.parse(json); }
  catch { throw new Error('bars must be a JSON array of {open_time,high,low,close,volume} candles'); }
  return bars;
}

register('volume-profile', {
  description: 'Volume Profile bias filters (Ch.14 VPVR Value Area, Ch.17 session VWAP) — confluence-only "fair value" rules, not standalone entry triggers',
  subcommands: new Map([
    ['vwap', {
      description: 'Calculate session VWAP, resetting at each UTC day boundary',
      handler: (_opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv volume-profile vwap <bars_json>');
        return { vwap: core.calculateSessionVWAP(parseBars(barsJson)) };
      },
    }],
    ['vwap-bias', {
      description: 'Apply Ch.17\'s rule to the latest bar: above VWAP -> only longs allowed (bias=long); below VWAP -> only shorts (bias=short)',
      handler: (_opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv volume-profile vwap-bias <bars_json>');
        return core.classifyVWAPBias(parseBars(barsJson));
      },
    }],
    ['value-area', {
      description: 'Calculate the VPVR volume-by-price profile (POC/VaH/VaL) over a JSON bar array',
      options: {
        bins: { type: 'string', short: 'b', description: 'Number of price bins (default 24)' },
        'va-percent': { type: 'string', description: 'Percent of total volume the Value Area should cover (default 70)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv volume-profile value-area <bars_json> [-b bins] [--va-percent pct]');
        return core.calculateValueArea(parseBars(barsJson), {
          bins: opts.bins ? Number(opts.bins) : undefined,
          valueAreaPercent: opts['va-percent'] ? Number(opts['va-percent']) : undefined,
        });
      },
    }],
    ['value-area-bias', {
      description: 'Apply Ch.14\'s rule to the latest bar: above VaH -> bias=short (look for shorts); below VaL -> bias=long; inside the Value Area -> bias=null',
      options: {
        bins: { type: 'string', short: 'b', description: 'Number of price bins (default 24)' },
        'va-percent': { type: 'string', description: 'Percent of total volume the Value Area should cover (default 70)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv volume-profile value-area-bias <bars_json> [-b bins] [--va-percent pct]');
        return core.classifyValueAreaBias(parseBars(barsJson), {
          bins: opts.bins ? Number(opts.bins) : undefined,
          valueAreaPercent: opts['va-percent'] ? Number(opts['va-percent']) : undefined,
        });
      },
    }],
  ]),
});
