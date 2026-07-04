import { register } from '../router.js';
import * as core from '../../core/pinbar.js';

function parseBars(json) {
  let bars;
  try { bars = JSON.parse(json); }
  catch { throw new Error('bars must be a JSON array of {open,high,low,close} candles'); }
  return bars;
}

function parseJsonArray(json, label) {
  let val;
  try { val = JSON.parse(json); }
  catch { throw new Error(`${label} must be a JSON array`); }
  if (!Array.isArray(val)) throw new Error(`${label} must be a JSON array`);
  return val;
}

function parseJsonObject(json, label) {
  try { return JSON.parse(json); }
  catch { throw new Error(`${label} must be a JSON object`); }
}

register('pinbar', {
  description: 'Pinbar reversal-bias detection (pinbar-at-swing-extreme + close-based level retest, trade-plan builder)',
  subcommands: new Map([
    ['scan', {
      description: 'Scan for a pinbar reversal-bias setup (pinbar at the most recent swing extreme, confirmed by a close-based retest of the prior candle\'s level) — returns ready-to-trade hits',
      options: {
        'skip-dojis': { type: 'string', description: 'Skip doji-shaped candles when scanning ("true"/"false", default true)' },
      },
      handler: (opts, positionals) => {
        const [barsJson, swingHighsJson, swingLowsJson] = positionals;
        if (!barsJson || !swingHighsJson || !swingLowsJson) {
          throw new Error('Usage: tv pinbar scan <bars_json> <swing_highs_json> <swing_lows_json> [--skip-dojis true|false]');
        }
        return core.scanForPinbarSetup(parseBars(barsJson), {
          swingHighs: parseJsonArray(swingHighsJson, 'swing_highs'),
          swingLows: parseJsonArray(swingLowsJson, 'swing_lows'),
          skipDojis: opts['skip-dojis'] === undefined ? undefined : opts['skip-dojis'] !== 'false',
        });
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,confidence} from a confirmed pinbar retest setup',
      options: {
        'last-swing': { type: 'string', description: 'Price of the swing point being targeted — the primary continuation target' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [hitJson] = positionals;
        if (!hitJson) throw new Error('Usage: tv pinbar plan <hit_json> [--last-swing price] [--range price]');
        return core.buildPinbarTradePlan({
          hit: parseJsonObject(hitJson, 'hit'),
          lastSwingLevel: opts['last-swing'] ? Number(opts['last-swing']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
