import { register } from '../router.js';
import * as core from '../../core/market_structure.js';

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

register('market-structure', {
  description: 'Market Structure detection (HH/HL/LH/LL labeling, BOS confirmation, CHoCH cycle tracking, trade-plan builder)',
  subcommands: new Map([
    ['detect', {
      description: 'Detect market structure (labeled swing sequence, confirmed BOS events, CHoCH cycle, current trend) from a bar array and its swing highs/lows',
      options: {},
      handler: (opts, positionals) => {
        const [barsJson, swingHighsJson, swingLowsJson] = positionals;
        if (!barsJson || !swingHighsJson || !swingLowsJson) {
          throw new Error('Usage: tv market-structure detect <bars_json> <swing_highs_json> <swing_lows_json>');
        }
        return core.detectMarketStructure(parseBars(barsJson), {
          swingHighs: parseJsonArray(swingHighsJson, 'swing_highs'),
          swingLows: parseJsonArray(swingLowsJson, 'swing_lows'),
        });
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,confidence} from a CHoCH event that realigns with the established trend',
      options: {
        'last-swing': { type: 'string', description: 'Price of the swing point being targeted — the primary continuation target' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [chochJson, trend] = positionals;
        if (!chochJson || !trend) throw new Error('Usage: tv market-structure plan <choch_json> <bullish|bearish> [--last-swing price] [--range price]');
        return core.buildStructureTradePlan({
          choch: parseJsonObject(chochJson, 'choch'),
          trend,
          lastSwingLevel: opts['last-swing'] ? Number(opts['last-swing']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
