import { register } from '../router.js';
import * as core from '../../core/fibonacci.js';

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

function parseRatios(opt) {
  if (!opt) return undefined;
  const ratios = parseJsonObject(opt, 'ratios');
  if (!Array.isArray(ratios)) throw new Error('ratios must be a JSON array, e.g. "[0.618,0.66]"');
  return ratios;
}

register('fibonacci', {
  description: 'Fibonacci confluence detection (golden-pocket retracement zone, sweep-and-reject reaction scanning, trade-plan builder)',
  subcommands: new Map([
    ['pocket', {
      description: 'Compute the golden-pocket zone (0.618-0.66 retracement region) for a swing from a prior extreme to the most recent one',
      options: {
        ratios: { type: 'string', description: 'JSON two-element array of retracement ratios bounding the pocket (default [0.618,0.66])' },
      },
      handler: (opts, positionals) => {
        const [start, end] = positionals;
        if (!start || !end) throw new Error('Usage: tv fibonacci pocket <start> <end> [--ratios "[0.618,0.66]"]');
        return core.findGoldenPocket({ start: Number(start), end: Number(end), ratios: parseRatios(opts.ratios) });
      },
    }],
    ['scan', {
      description: 'Scan a JSON bar array for a golden-pocket sweep-and-reject reaction off the most recent swing high/low',
      options: {
        ratios: { type: 'string', description: 'JSON two-element array of retracement ratios bounding the golden pocket (default [0.618,0.66])' },
        'skip-dojis': { type: 'string', description: 'Set to "false" to include indecision candles when scanning (default true)' },
      },
      handler: (opts, positionals) => {
        const [barsJson, swingHighJson, swingLowJson] = positionals;
        if (!barsJson || !swingHighJson || !swingLowJson) {
          throw new Error('Usage: tv fibonacci scan <bars_json> <swing_high_json> <swing_low_json> [--ratios "[0.618,0.66]"] [--skip-dojis false]');
        }
        return core.scanForFibReaction(parseBars(barsJson), {
          swingHigh: parseJsonObject(swingHighJson, 'swing_high'),
          swingLow: parseJsonObject(swingLowJson, 'swing_low'),
          ratios: parseRatios(opts.ratios),
          skipDojis: opts['skip-dojis'] === undefined ? undefined : opts['skip-dojis'] !== 'false',
        });
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,confidence} from a confirmed golden-pocket reaction',
      options: {
        'last-swing': { type: 'string', description: 'Price of the swing point being retraced toward — the primary continuation target' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [hitJson, direction] = positionals;
        if (!hitJson || !direction) throw new Error('Usage: tv fibonacci plan <hit_json> <bullish|bearish> [--last-swing price] [--range price]');
        return core.buildFibTradePlan({
          hit: parseJsonObject(hitJson, 'hit'),
          direction,
          lastSwingLevel: opts['last-swing'] ? Number(opts['last-swing']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
