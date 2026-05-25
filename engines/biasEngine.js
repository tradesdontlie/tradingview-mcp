/**
 * Determines directional bias from OHLCV bars using confirmed swing structure.
 *
 * @module biasEngine
 */

import { findSwingPoints } from './structureEngine.js';

/**
 * @typedef {"bullish"|"bearish"|"neutral"} Bias
 *
 * @typedef {{ "4H": Bias, "1H": Bias, "15m": Bias, "5m": Bias,
 *             permission: "long"|"short"|"none" }} MtfBiasResult
 */

/**
 * Classifies directional bias from a bar array using confirmed swing structure.
 *
 * Bullish:  higher highs (HH) AND higher lows (HL)
 * Bearish:  lower  highs (LH) AND lower  lows (LL)
 * Neutral:  fewer than 2 confirmed swing highs/lows, or mixed signals
 *
 * @param {Array<{high: number, low: number}>} bars - OHLCV bars (oldest first)
 * @param {number} [lookback=2] - bars required on each side to confirm a swing point
 * @returns {Bias}
 */
export function classifyBias(bars, lookback = 2) {
  const { highs, lows } = findSwingPoints(bars, lookback);
  if (highs.length < 2 || lows.length < 2) return 'neutral';

  const isHH = highs.at(-1).price > highs.at(-2).price;
  const isHL = lows.at(-1).price  > lows.at(-2).price;
  const isLH = highs.at(-1).price < highs.at(-2).price;
  const isLL = lows.at(-1).price  < lows.at(-2).price;

  if (isHH && isHL) return 'bullish';
  if (isLH && isLL) return 'bearish';
  return 'neutral';
}

/**
 * Builds a multi-timeframe bias object and determines directional permission.
 *
 * Permission rules:
 *   "long"  — 4H is not bearish AND 1H is not bearish
 *   "short" — 4H is not bullish AND 1H is not bullish
 *   "none"  — 4H and 1H are in direct conflict (one bullish, one bearish)
 *
 * @param {{ "4H": Array, "1H": Array, "15m": Array, "5m": Array }} ohlcvByTimeframe
 * @returns {MtfBiasResult}
 */
export function buildMtfBias(ohlcvByTimeframe) {
  const result = {};
  for (const [tf, bars] of Object.entries(ohlcvByTimeframe)) {
    result[tf] = classifyBias(bars);
  }

  const h4 = result['4H'] ?? 'neutral';
  const h1 = result['1H'] ?? 'neutral';

  let permission;
  if (h4 === 'bullish' && h1 === 'bearish') permission = 'none';
  else if (h4 === 'bearish' && h1 === 'bullish') permission = 'none';
  else if (h4 !== 'bearish' && h1 !== 'bearish') permission = 'long';
  else if (h4 !== 'bullish' && h1 !== 'bullish') permission = 'short';
  else permission = 'none';

  result.permission = permission;
  return result;
}
