import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/divergence.js';

const barSchema = z.object({
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
}).passthrough();

/**
 * RSI Divergence detection tools — pure pattern-matching over OHLC bar arrays
 * (e.g. from binance_get_klines / data_get_ohlcv), no live chart/exchange
 * calls of their own. Encodes the curriculum's "Divergence Master-Class"
 * (Chapters 10-11): RSI is computed from closes, so price swings are compared
 * close-to-close against it; bullish divergence only ever looks at lows,
 * bearish only at highs; and each side has four ranked patterns
 * (strong/medium/weak/hidden — hidden is a continuation signal the
 * curriculum's author explicitly doesn't trade).
 */
export function registerDivergenceTools(server) {
  server.tool('divergence_calculate_rsi', 'Calculate Wilder\'s RSI over a bar series\' closing prices (the standard formulation — RSI is derived from closes)', {
    bars: z.array(barSchema).describe('OHLC candle array, oldest first (e.g. from binance klines)'),
    period: z.coerce.number().int().positive().optional().describe('RSI lookback period (default 14)'),
  }, async ({ bars, period }) => {
    try { return jsonResult({ success: true, rsi: core.calculateRSI(bars, { period }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('divergence_find_close_swing_highs', 'Find local swing-high points in the CLOSE-price series (the price side of a bearish-divergence comparison — curriculum: compare bodies, not wicks)', {
    bars: z.array(barSchema).describe('OHLC candle array, oldest first'),
    lookback: z.coerce.number().int().positive().optional().describe('Bars on each side that must be lower for a point to count as a swing high (default 2)'),
  }, async ({ bars, lookback }) => {
    try { return jsonResult({ success: true, swings: core.findCloseSwingHighs(bars, { lookback }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('divergence_find_close_swing_lows', 'Find local swing-low points in the CLOSE-price series (the price side of a bullish-divergence comparison — curriculum: compare bodies, not wicks)', {
    bars: z.array(barSchema).describe('OHLC candle array, oldest first'),
    lookback: z.coerce.number().int().positive().optional().describe('Bars on each side that must be higher for a point to count as a swing low (default 2)'),
  }, async ({ bars, lookback }) => {
    try { return jsonResult({ success: true, swings: core.findCloseSwingLows(bars, { lookback }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'divergence_scan',
    'Scan a bar series for RSI divergence: computes RSI, finds the relevant close-based price swings ' +
    '(LOWS only for bullish, HIGHS only for bearish — curriculum is explicit on this), and classifies the ' +
    'two most recent same-side swings into the curriculum\'s four-pattern taxonomy ranked by conviction: ' +
    '"strong" (price/RSI extremes move opposite ways), "medium" (price double top/bottom + RSI breaks away), ' +
    '"weak" (price breaks + RSI double tops/bottoms), or "hidden" (a trend-CONTINUATION signal, not a reversal — ' +
    'excluded by default since the curriculum\'s author is explicit: "I don\'t trade it"). ' +
    'A minimum 4-hour timeframe is preferred per the curriculum.',
    {
      bars: z.array(barSchema).describe('OHLC candle array to scan, oldest first'),
      type: z.enum(['bullish', 'bearish']).describe('"bullish" = look for a bottom via the LOWS (signals a potential long); "bearish" = look for a top via the HIGHS (signals a potential short)'),
      rsi_period: z.coerce.number().int().positive().optional().describe('RSI lookback period (default 14)'),
      lookback: z.coerce.number().int().positive().optional().describe('Bars on each side required to confirm a swing point (default 2)'),
      tolerance_percent: z.coerce.number().nonnegative().optional().describe('Percent tolerance for treating two extremes as "equal" / a double top-or-bottom (default 0.05)'),
      include_hidden: z.coerce.boolean().optional().describe('Include hidden divergences in results (default false — they are continuation signals, not traded per the curriculum)'),
    },
    async ({ bars, type, rsi_period, lookback, tolerance_percent, include_hidden }) => {
      try {
        return jsonResult({
          success: true,
          ...core.scanForDivergence(bars, {
            type, rsiPeriod: rsi_period, lookback, tolerancePercent: tolerance_percent, includeHidden: include_hidden,
          }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('divergence_calculate_cvd', 'Calculate rolling-window Cumulative Volume Delta (CVD) over a bar series — per-bar delta = takerBuyVolume - (volume - takerBuyVolume), summed over a trailing window (Chapter 18)', {
    bars: z.array(barSchema.extend({
      volume: z.coerce.number(),
      taker_buy_volume: z.coerce.number(),
    })).describe('OHLC candle array, oldest first, with volume and taker_buy_volume (from binance klines)'),
    window: z.coerce.number().int().positive().optional().describe('Rolling window size in bars for the cumulative sum (default 14)'),
  }, async ({ bars, window }) => {
    try { return jsonResult({ success: true, cvd: core.calculateCVD(bars, { window }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'divergence_scan_cvd',
    'Scan a bar series for CVD divergence (Chapter 18 — "Master-Class on Cumulative Volume Delta"): computes rolling-window CVD, ' +
    'finds the relevant close-based price swings (LOWS only for bullish, HIGHS only for bearish), and classifies the two most ' +
    'recent same-side swings into the same strong/medium/weak/hidden taxonomy as RSI divergence. ' +
    '"Absorption" = CVD makes a new extreme but price doesn\'t follow; "Exhaustion" = price makes a new extreme but CVD doesn\'t ' +
    'follow — both are divergences in this taxonomy. Hidden divergences are excluded by default (continuation signal).',
    {
      bars: z.array(barSchema.extend({
        volume: z.coerce.number(),
        taker_buy_volume: z.coerce.number(),
      })).describe('OHLC candle array to scan, oldest first, with volume and taker_buy_volume'),
      type: z.enum(['bullish', 'bearish']).describe('"bullish" = look for a bottom via the LOWS; "bearish" = look for a top via the HIGHS'),
      cvd_window: z.coerce.number().int().positive().optional().describe('Rolling window size in bars for CVD (default 14)'),
      lookback: z.coerce.number().int().positive().optional().describe('Bars on each side required to confirm a swing point (default 2)'),
      tolerance_percent: z.coerce.number().nonnegative().optional().describe('Percent tolerance for treating two extremes as "equal" / a double top-or-bottom (default 0.05)'),
      include_hidden: z.coerce.boolean().optional().describe('Include hidden divergences in results (default false)'),
    },
    async ({ bars, type, cvd_window, lookback, tolerance_percent, include_hidden }) => {
      try {
        return jsonResult({
          success: true,
          ...core.scanForCVDDivergence(bars, {
            type, cvdWindow: cvd_window, lookback, tolerancePercent: tolerance_percent, includeHidden: include_hidden,
          }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'divergence_build_trade_plan',
    'Build a trade plan (entry/stop/target/side) from a confirmed divergence (from divergence_scan), in the exact ' +
    'shape consumed by risk_evaluate_trade_setup — closing the loop between setup detection and the deterministic ' +
    'risk gate, identically to sfp_build_trade_plan. Bullish divergence -> long (predicts a bottom); bearish -> short ' +
    '(predicts a top). Entry = close of the confirming pivot candle; stop = beyond that candle\'s wick; ' +
    'target = the nearer of the last opposite-side swing level and/or the range level (curriculum\'s target convention).',
    {
      hit: z.object({
        divergence: z.literal(true),
        pattern: z.enum(['strong', 'medium', 'weak', 'hidden']),
        direction: z.enum(['bullish', 'bearish']),
        newer_swing: z.object({ index: z.coerce.number(), value: z.coerce.number() }).passthrough(),
      }).passthrough().describe('A confirmed divergence result object from divergence_scan (must have divergence: true)'),
      last_swing_level: z.coerce.number().positive().optional().describe('Price of the last opposite-side swing high/low — a valid target option per the curriculum'),
      range_level: z.coerce.number().positive().optional().describe('Price of the range high/low — the other valid target option (at least one of the two target options is required)'),
    },
    async ({ hit, last_swing_level, range_level }) => {
      try {
        return jsonResult({
          success: true,
          plan: core.buildDivergenceTradePlan({ hit, lastSwingLevel: last_swing_level, rangeLevel: range_level }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
