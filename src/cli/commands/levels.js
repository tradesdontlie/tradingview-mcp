import { register } from '../router.js';
import * as core from '../../core/levels.js';

function parseBars(json) {
  let bars;
  try { bars = JSON.parse(json); }
  catch { throw new Error('bars must be a JSON array of {open,high,low,close} candles'); }
  return bars;
}

function parseJsonObject(json, label) {
  try { return JSON.parse(json); }
  catch { throw new Error(`${label} must be a JSON object`); }
}

register('levels', {
  description: 'Key Levels / Zones detection (consolidation-range -> breakout -> support/resistance + continuation/reversal classification, retest scanning, trade-plan builder)',
  subcommands: new Map([
    ['ranges', {
      description: 'Find tight consolidation ranges (adjacent swing-high/swing-low pairs close enough together to read as one zone)',
      options: {
        'swing-lookback': { type: 'string', short: 'l', description: 'Bars on each side required to confirm a swing point (default 2)' },
        'max-range-percent': { type: 'string', description: 'Max percent gap between the swing high/low for a tight range (default 3)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv levels ranges <bars_json> [-l swing_lookback] [--max-range-percent pct]');
        return core.findConsolidationRanges(parseBars(barsJson), {
          swingLookback: opts['swing-lookback'] ? Number(opts['swing-lookback']) : undefined,
          maxRangePercent: opts['max-range-percent'] ? Number(opts['max-range-percent']) : undefined,
        });
      },
    }],
    ['scan', {
      description: 'Scan a JSON bar array for confirmed support/resistance zones (continuation/reversal classified)',
      options: {
        'swing-lookback': { type: 'string', short: 'l', description: 'Bars on each side required to confirm a swing point (default 2)' },
        'max-range-percent': { type: 'string', description: 'Max percent gap between the swing high/low for a tight range (default 3)' },
        'trend-lookback': { type: 'string', description: 'Bars to look back from the range start to read the prior trend (default 5)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv levels scan <bars_json> [-l swing_lookback] [--max-range-percent pct] [--trend-lookback n]');
        return { zones: core.detectZones(parseBars(barsJson), {
          swingLookback: opts['swing-lookback'] ? Number(opts['swing-lookback']) : undefined,
          maxRangePercent: opts['max-range-percent'] ? Number(opts['max-range-percent']) : undefined,
          trendLookback: opts['trend-lookback'] ? Number(opts['trend-lookback']) : undefined,
        }) };
      },
    }],
    ['retests', {
      description: 'Find bars after a zone\'s breakout that overlap it — i.e. price returning to retest the zone (the trade trigger)',
      handler: (opts, positionals) => {
        const [barsJson, zoneJson] = positionals;
        if (!barsJson || !zoneJson) throw new Error('Usage: tv levels retests <bars_json> <zone_json>');
        return { hits: core.findZoneRetests(parseBars(barsJson), parseJsonObject(zoneJson, 'zone')) };
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,confidence} from a confirmed zone retest',
      options: {
        'opposite-zone': { type: 'string', description: 'Price of the next opposing zone — the curriculum\'s "First Trouble Area" target' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [zoneJson, hitJson] = positionals;
        if (!zoneJson || !hitJson) throw new Error('Usage: tv levels plan <zone_json> <hit_json> [--opposite-zone price] [--range price]');
        return core.buildZoneTradePlan({
          zone: parseJsonObject(zoneJson, 'zone'),
          hit: parseJsonObject(hitJson, 'hit'),
          oppositeZoneLevel: opts['opposite-zone'] ? Number(opts['opposite-zone']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
