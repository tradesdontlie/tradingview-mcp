import { register } from '../router.js';
import * as core from '../../core/sfp.js';

function parseBars(json) {
  let bars;
  try { bars = JSON.parse(json); }
  catch { throw new Error('bars must be a JSON array of {open,high,low,close} candles'); }
  return bars;
}

register('sfp', {
  description: 'Swing Failure Pattern detection (close-based sweep confirmation, doji filter, trade-plan builder)',
  subcommands: new Map([
    ['swing-highs', {
      description: 'Find local swing-high points in a JSON bar array',
      options: {
        lookback: { type: 'string', short: 'l', description: 'Bars on each side that must be lower (default 2)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv sfp swing-highs <bars_json> [-l lookback]');
        return core.findSwingHighs(parseBars(barsJson), { lookback: opts.lookback ? Number(opts.lookback) : undefined });
      },
    }],
    ['swing-lows', {
      description: 'Find local swing-low points in a JSON bar array',
      options: {
        lookback: { type: 'string', short: 'l', description: 'Bars on each side that must be higher (default 2)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv sfp swing-lows <bars_json> [-l lookback]');
        return core.findSwingLows(parseBars(barsJson), { lookback: opts.lookback ? Number(opts.lookback) : undefined });
      },
    }],
    ['is-doji', {
      description: 'Check whether a single OHLC candle qualifies as a doji',
      options: {
        ratio: { type: 'string', short: 'r', description: 'Max body/range ratio to count as a doji (default 0.1)' },
      },
      handler: (opts, positionals) => {
        const [barJson] = positionals;
        if (!barJson) throw new Error('Usage: tv sfp is-doji <bar_json> [-r ratio]');
        let bar;
        try { bar = JSON.parse(barJson); }
        catch { throw new Error('bar must be a JSON object {open,high,low,close}'); }
        return { is_doji: core.isDoji(bar, { maxBodyToRangeRatio: opts.ratio ? Number(opts.ratio) : undefined }) };
      },
    }],
    ['scan', {
      description: 'Scan a JSON bar array for SFPs at a key level (close-based confirmation, tags first/retest)',
      options: {
        type: { type: 'string', short: 't', description: 'bullish (sweep of a low/support) or bearish (sweep of a high/resistance)' },
        'skip-dojis': { type: 'string', description: 'true (default) or false — skip doji sweep candles' },
      },
      handler: (opts, positionals) => {
        const [barsJson, level] = positionals;
        if (!barsJson || !level || !opts.type) throw new Error('Usage: tv sfp scan <bars_json> <level> -t bullish|bearish [--skip-dojis true|false]');
        return {
          hits: core.scanForSFP(parseBars(barsJson), {
            level: Number(level),
            type: opts.type,
            skipDojis: opts['skip-dojis'] === undefined ? undefined : opts['skip-dojis'] !== 'false',
          }),
        };
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,confidence} from a confirmed SFP hit',
      options: {
        type: { type: 'string', short: 't', description: 'bullish (-> long plan) or bearish (-> short plan)' },
        'last-swing': { type: 'string', description: 'Price of the last swing high/low (a valid target option)' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [hitJson] = positionals;
        if (!hitJson || !opts.type) throw new Error('Usage: tv sfp plan <hit_json> -t bullish|bearish [--last-swing price] [--range price]');
        let hit;
        try { hit = JSON.parse(hitJson); }
        catch { throw new Error('hit must be a JSON object with at least {entry, stop} (e.g. one element from `tv sfp scan`)'); }
        return core.buildSFPTradePlan({
          hit,
          type: opts.type,
          lastSwingLevel: opts['last-swing'] ? Number(opts['last-swing']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
