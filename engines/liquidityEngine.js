/**
 * Detects liquidity sweeps and reclaims on known session price levels.
 *
 * A sweep occurs when price wicks beyond a level and is then rejected.
 * A reclaim occurs when a subsequent close returns to the correct side of the level.
 *
 * @module liquidityEngine
 */

/**
 * @typedef {{ swept: boolean, sweepBarIndex: number|null }} SweepResult
 * @typedef {{ reclaimed: boolean, reclaimBarIndex: number|null, candlesToReclaim: number|null }} ReclaimResult
 */

/**
 * Scans bars for the first sweep of a session level.
 *
 * direction "low"  → bullish setup: bar.low < levelPrice − tolerance (sweep of support)
 * direction "high" → bearish setup: bar.high > levelPrice + tolerance (sweep of resistance)
 *
 * @param {Array<{low:number,high:number}>} bars - bars to scan (oldest first)
 * @param {number} levelPrice - the session level to watch
 * @param {"low"|"high"} direction - which side of the level is being swept
 * @param {number} [tolerance=0] - price buffer in points (e.g. 0.25 for one tick)
 * @returns {SweepResult}
 */
export function detectSweep(bars, levelPrice, direction, tolerance = 0) {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (direction === 'low'  && b.low  < levelPrice - tolerance) return { swept: true,  sweepBarIndex: i };
    if (direction === 'high' && b.high > levelPrice + tolerance) return { swept: true,  sweepBarIndex: i };
  }
  return { swept: false, sweepBarIndex: null };
}

/**
 * Checks whether price reclaimed the swept level within the candle window.
 *
 * direction "low"  → reclaim = a bar closes above levelPrice after the sweep
 * direction "high" → reclaim = a bar closes below levelPrice after the sweep
 *
 * @param {Array<{close:number}>} bars
 * @param {number|null} sweepBarIndex - index returned by detectSweep
 * @param {number} levelPrice
 * @param {"low"|"high"} direction
 * @param {number} [window=5] - max candles after sweep to count as a valid reclaim
 * @returns {ReclaimResult}
 */
export function detectReclaim(bars, sweepBarIndex, levelPrice, direction, window = 5) {
  if (sweepBarIndex === null) {
    return { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null };
  }
  const limit = Math.min(sweepBarIndex + 1 + window, bars.length);
  for (let i = sweepBarIndex + 1; i < limit; i++) {
    const close = bars[i].close;
    if (direction === 'low'  && close > levelPrice) return { reclaimed: true, reclaimBarIndex: i, candlesToReclaim: i - sweepBarIndex };
    if (direction === 'high' && close < levelPrice) return { reclaimed: true, reclaimBarIndex: i, candlesToReclaim: i - sweepBarIndex };
  }
  return { reclaimed: false, reclaimBarIndex: null, candlesToReclaim: null };
}

/**
 * Scans bars for the most recent (latest) sweep of a session level within a window.
 *
 * Searches newest-first so the most recent sweep is returned instead of the
 * first historical one. Only considers the last `windowBars` completed bars.
 *
 * @param {Array<{low:number,high:number}>} bars
 * @param {number} levelPrice
 * @param {"low"|"high"} direction
 * @param {number} [tolerance=0]
 * @param {number} [windowBars=12] - look-back window in completed bars
 * @returns {SweepResult}
 */
export function detectLatestSweep(bars, levelPrice, direction, tolerance = 0, windowBars = 12) {
  const windowStart = Math.max(0, bars.length - windowBars);
  for (let i = bars.length - 1; i >= windowStart; i--) {
    const b = bars[i];
    if (direction === 'low'  && b.low  < levelPrice - tolerance) return { swept: true, sweepBarIndex: i };
    if (direction === 'high' && b.high > levelPrice + tolerance) return { swept: true, sweepBarIndex: i };
  }
  return { swept: false, sweepBarIndex: null };
}
