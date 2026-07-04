import { register } from '../router.js';
import * as core from '../../core/chart_patterns.js';

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

register('chart_patterns', {
  description: 'Classic chart pattern detection (double top/bottom, head & shoulders, triangles, flags/pennants — close-based breakout confirmation, trade-plan builders)',
  subcommands: new Map([
    ['double-top-bottom', {
      description: 'Find Double Top/Bottom patterns from a bar series and its swing highs/lows',
      options: {
        tolerance: { type: 'string', short: 't', description: 'Max %% difference between the two peaks/troughs to count as "near-equal" (default 1.5)' },
      },
      handler: (opts, positionals) => {
        const [barsJson, swingHighsJson, swingLowsJson] = positionals;
        if (!barsJson || !swingHighsJson || !swingLowsJson) {
          throw new Error('Usage: tv chart_patterns double-top-bottom <bars_json> <swing_highs_json> <swing_lows_json> [-t tolerance_percent]');
        }
        return core.findDoubleTopBottom(parseBars(barsJson), {
          swingHighs: parseJsonArray(swingHighsJson, 'swing_highs'),
          swingLows: parseJsonArray(swingLowsJson, 'swing_lows'),
          tolerancePercent: opts.tolerance ? Number(opts.tolerance) : undefined,
        });
      },
    }],
    ['head-and-shoulders', {
      description: 'Find Head & Shoulders / Inverse Head & Shoulders patterns from a bar series and its swing highs/lows',
      options: {
        tolerance: { type: 'string', short: 't', description: 'Max %% difference between the two shoulders (default 5)' },
      },
      handler: (opts, positionals) => {
        const [barsJson, swingHighsJson, swingLowsJson] = positionals;
        if (!barsJson || !swingHighsJson || !swingLowsJson) {
          throw new Error('Usage: tv chart_patterns head-and-shoulders <bars_json> <swing_highs_json> <swing_lows_json> [-t shoulder_tolerance_percent]');
        }
        return core.findHeadAndShoulders(parseBars(barsJson), {
          swingHighs: parseJsonArray(swingHighsJson, 'swing_highs'),
          swingLows: parseJsonArray(swingLowsJson, 'swing_lows'),
          shoulderTolerancePercent: opts.tolerance ? Number(opts.tolerance) : undefined,
        });
      },
    }],
    ['neckline-break', {
      description: 'Scan for the close-based neckline break confirming a Double Top/Bottom or Head & Shoulders pattern',
      handler: (opts, positionals) => {
        const [barsJson, patternJson] = positionals;
        if (!barsJson || !patternJson) throw new Error('Usage: tv chart_patterns neckline-break <bars_json> <pattern_json>');
        return core.scanForNecklineBreak(parseBars(barsJson), parseJsonObject(patternJson, 'pattern'));
      },
    }],
    ['double-top-bottom-plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target} from a confirmed Double Top/Bottom neckline break',
      options: {
        range: { type: 'string', description: 'Price of the range high/low (becomes alternate_target)' },
      },
      handler: (opts, positionals) => {
        const [patternJson, breakoutJson] = positionals;
        if (!patternJson || !breakoutJson) throw new Error('Usage: tv chart_patterns double-top-bottom-plan <pattern_json> <breakout_json> [--range price]');
        return core.buildDoubleTopBottomTradePlan({
          pattern: parseJsonObject(patternJson, 'pattern'),
          breakout: parseJsonObject(breakoutJson, 'breakout'),
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
    ['head-and-shoulders-plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target} from a confirmed Head & Shoulders / Inverse Head & Shoulders neckline break',
      options: {
        range: { type: 'string', description: 'Price of the range high/low (becomes alternate_target)' },
      },
      handler: (opts, positionals) => {
        const [patternJson, breakoutJson] = positionals;
        if (!patternJson || !breakoutJson) throw new Error('Usage: tv chart_patterns head-and-shoulders-plan <pattern_json> <breakout_json> [--range price]');
        return core.buildHeadAndShouldersTradePlan({
          pattern: parseJsonObject(patternJson, 'pattern'),
          breakout: parseJsonObject(breakoutJson, 'breakout'),
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
    ['triangle', {
      description: 'Classify the two most recent swing highs/lows into an ascending/descending/symmetrical triangle',
      options: {
        'flat-slope': { type: 'string', description: 'Max |slope| (%% of latest close per bar) to count as "flat" (default 0.02)' },
      },
      handler: (opts, positionals) => {
        const [barsJson, swingHighsJson, swingLowsJson] = positionals;
        if (!barsJson || !swingHighsJson || !swingLowsJson) {
          throw new Error('Usage: tv chart_patterns triangle <bars_json> <swing_highs_json> <swing_lows_json> [--flat-slope percent]');
        }
        return core.findTriangle(parseBars(barsJson), {
          swingHighs: parseJsonArray(swingHighsJson, 'swing_highs'),
          swingLows: parseJsonArray(swingLowsJson, 'swing_lows'),
          flatSlopePercent: opts['flat-slope'] ? Number(opts['flat-slope']) : undefined,
        });
      },
    }],
    ['triangle-breakout', {
      description: 'Scan for a confirmed close-based triangle breakout',
      handler: (opts, positionals) => {
        const [barsJson, triangleJson] = positionals;
        if (!barsJson || !triangleJson) throw new Error('Usage: tv chart_patterns triangle-breakout <bars_json> <triangle_json>');
        return core.scanForTriangleBreakout(parseBars(barsJson), parseJsonObject(triangleJson, 'triangle'));
      },
    }],
    ['triangle-plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target} from a confirmed triangle breakout',
      options: {
        range: { type: 'string', description: 'Price of the range high/low (becomes alternate_target)' },
      },
      handler: (opts, positionals) => {
        const [triangleJson, breakoutJson] = positionals;
        if (!triangleJson || !breakoutJson) throw new Error('Usage: tv chart_patterns triangle-plan <triangle_json> <breakout_json> [--range price]');
        return core.buildTriangleTradePlan({
          triangle: parseJsonObject(triangleJson, 'triangle'),
          breakout: parseJsonObject(breakoutJson, 'breakout'),
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
    ['flag-pennant', {
      description: 'Find a Flag/Pennant continuation pattern (directional flagpole + tight consolidation)',
      options: {
        'pole-lookback': { type: 'string', description: 'Bars in the flagpole window (default 10)' },
        'flag-lookback': { type: 'string', description: 'Bars in the consolidation window (default 8)' },
        'pole-ratio': { type: 'string', description: 'Min net-move / range ratio for the pole (default 0.6)' },
        'consolidation-ratio': { type: 'string', description: 'Max flag-range / pole-range ratio (default 0.5)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv chart_patterns flag-pennant <bars_json> [--pole-lookback n] [--flag-lookback n] [--pole-ratio r] [--consolidation-ratio r]');
        return core.findFlagPennant(parseBars(barsJson), {
          poleLookback: opts['pole-lookback'] ? Number(opts['pole-lookback']) : undefined,
          flagLookback: opts['flag-lookback'] ? Number(opts['flag-lookback']) : undefined,
          poleDirectionalityRatio: opts['pole-ratio'] ? Number(opts['pole-ratio']) : undefined,
          consolidationMaxRatio: opts['consolidation-ratio'] ? Number(opts['consolidation-ratio']) : undefined,
        });
      },
    }],
    ['flag-breakout', {
      description: 'Scan for the close-based break of a flag/pennant\'s consolidation range (continuation confirmation)',
      handler: (opts, positionals) => {
        const [barsJson, patternJson] = positionals;
        if (!barsJson || !patternJson) throw new Error('Usage: tv chart_patterns flag-breakout <bars_json> <pattern_json>');
        return core.scanForFlagBreakout(parseBars(barsJson), parseJsonObject(patternJson, 'pattern'));
      },
    }],
    ['flag-plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target} from a confirmed flag/pennant breakout',
      options: {
        range: { type: 'string', description: 'Price of the range high/low (becomes alternate_target)' },
      },
      handler: (opts, positionals) => {
        const [patternJson, breakoutJson] = positionals;
        if (!patternJson || !breakoutJson) throw new Error('Usage: tv chart_patterns flag-plan <pattern_json> <breakout_json> [--range price]');
        return core.buildFlagTradePlan({
          pattern: parseJsonObject(patternJson, 'pattern'),
          breakout: parseJsonObject(breakoutJson, 'breakout'),
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
