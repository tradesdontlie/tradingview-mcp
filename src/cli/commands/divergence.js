import { register } from '../router.js';
import * as core from '../../core/divergence.js';

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

register('divergence', {
  description: 'RSI Divergence detection (close-based price/RSI swing comparison, strong/medium/weak/hidden taxonomy, trade-plan builder)',
  subcommands: new Map([
    ['rsi', {
      description: 'Calculate Wilder\'s RSI over a JSON bar array\'s closing prices',
      options: {
        period: { type: 'string', short: 'p', description: 'RSI lookback period (default 14)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv divergence rsi <bars_json> [-p period]');
        return { rsi: core.calculateRSI(parseBars(barsJson), { period: opts.period ? Number(opts.period) : undefined }) };
      },
    }],
    ['swing-highs', {
      description: 'Find local swing-high points in the CLOSE-price series (price side of a bearish-divergence comparison)',
      options: {
        lookback: { type: 'string', short: 'l', description: 'Bars on each side that must be lower (default 2)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv divergence swing-highs <bars_json> [-l lookback]');
        return core.findCloseSwingHighs(parseBars(barsJson), { lookback: opts.lookback ? Number(opts.lookback) : undefined });
      },
    }],
    ['swing-lows', {
      description: 'Find local swing-low points in the CLOSE-price series (price side of a bullish-divergence comparison)',
      options: {
        lookback: { type: 'string', short: 'l', description: 'Bars on each side that must be higher (default 2)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv divergence swing-lows <bars_json> [-l lookback]');
        return core.findCloseSwingLows(parseBars(barsJson), { lookback: opts.lookback ? Number(opts.lookback) : undefined });
      },
    }],
    ['scan', {
      description: 'Scan a JSON bar array for RSI divergence (bullish=lows only, bearish=highs only); classifies strong/medium/weak/hidden',
      options: {
        type: { type: 'string', short: 't', description: 'bullish (look for a bottom via lows) or bearish (look for a top via highs)' },
        'rsi-period': { type: 'string', description: 'RSI lookback period (default 14)' },
        lookback: { type: 'string', short: 'l', description: 'Bars on each side required to confirm a swing point (default 2)' },
        tolerance: { type: 'string', description: 'Percent tolerance for "equal" extremes / double tops-bottoms (default 0.05)' },
        'include-hidden': { type: 'string', description: 'true or false (default) — include continuation-signal hidden divergences' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson || !opts.type) throw new Error('Usage: tv divergence scan <bars_json> -t bullish|bearish [--rsi-period n] [-l lookback] [--tolerance pct] [--include-hidden true|false]');
        return core.scanForDivergence(parseBars(barsJson), {
          type: opts.type,
          rsiPeriod: opts['rsi-period'] ? Number(opts['rsi-period']) : undefined,
          lookback: opts.lookback ? Number(opts.lookback) : undefined,
          tolerancePercent: opts.tolerance ? Number(opts.tolerance) : undefined,
          includeHidden: opts['include-hidden'] === 'true',
        });
      },
    }],
    ['cvd', {
      description: 'Calculate rolling-window Cumulative Volume Delta over a JSON bar array (bars need volume + taker_buy_volume)',
      options: {
        window: { type: 'string', short: 'w', description: 'Rolling window size in bars (default 14)' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson) throw new Error('Usage: tv divergence cvd <bars_json> [-w window]');
        return { cvd: core.calculateCVD(parseBars(barsJson), { window: opts.window ? Number(opts.window) : undefined }) };
      },
    }],
    ['scan-cvd', {
      description: 'Scan a JSON bar array for CVD divergence (bullish=lows only, bearish=highs only); classifies strong/medium/weak/hidden',
      options: {
        type: { type: 'string', short: 't', description: 'bullish (look for a bottom via lows) or bearish (look for a top via highs)' },
        'cvd-window': { type: 'string', description: 'Rolling window size in bars for CVD (default 14)' },
        lookback: { type: 'string', short: 'l', description: 'Bars on each side required to confirm a swing point (default 2)' },
        tolerance: { type: 'string', description: 'Percent tolerance for "equal" extremes / double tops-bottoms (default 0.05)' },
        'include-hidden': { type: 'string', description: 'true or false (default) — include continuation-signal hidden divergences' },
      },
      handler: (opts, positionals) => {
        const [barsJson] = positionals;
        if (!barsJson || !opts.type) throw new Error('Usage: tv divergence scan-cvd <bars_json> -t bullish|bearish [--cvd-window n] [-l lookback] [--tolerance pct] [--include-hidden true|false]');
        return core.scanForCVDDivergence(parseBars(barsJson), {
          type: opts.type,
          cvdWindow: opts['cvd-window'] ? Number(opts['cvd-window']) : undefined,
          lookback: opts.lookback ? Number(opts.lookback) : undefined,
          tolerancePercent: opts.tolerance ? Number(opts.tolerance) : undefined,
          includeHidden: opts['include-hidden'] === 'true',
        });
      },
    }],
    ['plan', {
      description: 'Build a trade plan {side,entry,stop,target,alternate_target,pattern,confidence} from a confirmed divergence hit',
      options: {
        'last-swing': { type: 'string', description: 'Price of the last opposite-side swing high/low (a valid target option)' },
        range: { type: 'string', description: 'Price of the range high/low (the other valid target option)' },
      },
      handler: (opts, positionals) => {
        const [hitJson] = positionals;
        if (!hitJson) throw new Error('Usage: tv divergence plan <hit_json> [--last-swing price] [--range price]');
        return core.buildDivergenceTradePlan({
          hit: parseJsonObject(hitJson, 'hit'),
          lastSwingLevel: opts['last-swing'] ? Number(opts['last-swing']) : undefined,
          rangeLevel: opts.range ? Number(opts.range) : undefined,
        });
      },
    }],
  ]),
});
