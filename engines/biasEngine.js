/**
 * Determines directional bias from OHLCV bars.
 * Phase 2A uses a simple SMA comparison — swing-pivot logic replaces this in Phase 3.
 *
 * @module biasEngine
 */

/**
 * @typedef {"bullish"|"bearish"|"neutral"} Bias
 *
 * @typedef {{ "4H": Bias, "1H": Bias, "15m": Bias, "5m": Bias,
 *             permission: "long"|"short"|"none" }} MtfBiasResult
 */

/**
 * Classifies directional bias from a bar array using a prior-period SMA.
 *
 * @param {Array<{close: number}>} bars - OHLCV bars (oldest first)
 * @param {number} [period=5] - SMA lookback (excludes the current bar)
 * @returns {Bias}
 */
export function classifyBias(bars, period = 5) {
  if (bars.length < period + 1) return 'neutral';
  const prior = bars.slice(-(period + 1), -1);
  const sma = prior.reduce((sum, b) => sum + b.close, 0) / period;
  const last = bars[bars.length - 1].close;
  if (last > sma * 1.001) return 'bullish';
  if (last < sma * 0.999) return 'bearish';
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
