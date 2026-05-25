/**
 * Volume surge detection and approximate volume-profile metrics.
 *
 * Delta approximation uses the tick-rule (close vs open direction).
 * This is a structural proxy only — it is NOT true bid/ask order flow.
 *
 * @module volumeEngine
 */

/**
 * @typedef {{ surge: boolean, ratio: number }} VolumeSurgeResult
 */

/**
 * Detects whether the bar at `barIndex` has a volume surge relative to recent bars.
 *
 * @param {Array<{vol:number}>} bars
 * @param {number} barIndex - the target bar to evaluate
 * @param {number} [lookback=20] - number of prior bars used to compute average
 * @param {number} [threshold=1.5] - surge multiplier (e.g. 1.5 = 150% of average)
 * @returns {VolumeSurgeResult}
 */
export function detectVolumeSurge(bars, barIndex, lookback = 20, threshold = 1.5) {
  if (barIndex < 0 || barIndex >= bars.length) return { surge: false, ratio: 0 };
  const start = Math.max(0, barIndex - lookback);
  const prior = bars.slice(start, barIndex);
  if (!prior.length) return { surge: false, ratio: 0 };
  const avg = prior.reduce((s, b) => s + b.vol, 0) / prior.length;
  const ratio = avg > 0 ? bars[barIndex].vol / avg : 0;
  return { surge: ratio >= threshold, ratio: +ratio.toFixed(3) };
}

/**
 * Returns the close price of the bar with the highest volume (POC approximation).
 * Use on a single session's bars for a meaningful result.
 *
 * @param {Array<{close:number,vol:number}>} bars
 * @returns {number} approximate point of control price
 */
export function approximatePoc(bars) {
  if (!bars.length) return 0;
  return bars.reduce((best, b) => (b.vol > best.vol ? b : best), bars[0]).close;
}

/**
 * Approximates Value Area High and Value Area Low by accumulating volume outward
 * from the POC until `coverage` fraction of total volume is enclosed.
 *
 * @param {Array<{close:number,vol:number}>} bars
 * @param {number} poc - point of control price
 * @param {number} [coverage=0.7] - fraction of total volume to enclose (e.g. 0.7 = 70%)
 * @returns {{ vah: number, val: number }}
 */
export function approximateVahVal(bars, poc, coverage = 0.7) {
  if (!bars.length) return { vah: poc, val: poc };
  const totalVol = bars.reduce((s, b) => s + b.vol, 0);
  const target   = totalVol * coverage;
  const sorted   = [...bars].sort((a, b) => Math.abs(a.close - poc) - Math.abs(b.close - poc));
  let acc = 0;
  const prices = [];
  for (const b of sorted) {
    acc += b.vol;
    prices.push(b.close);
    if (acc >= target) break;
  }
  return { vah: Math.max(...prices), val: Math.min(...prices) };
}

/**
 * Approximates delta direction using the tick-rule across all bars.
 *
 * Each bar is classified as a buy bar (close > open) or sell bar (close < open).
 * Returns "positive" if buy bars exceed sell bars by >20%, "negative" if vice versa,
 * otherwise "neutral".
 *
 * NOT true bid/ask order flow — use as supporting context only.
 *
 * @param {Array<{open:number,close:number}>} bars
 * @returns {"positive"|"negative"|"neutral"}
 */
export function approximateDelta(bars) {
  let buys = 0, sells = 0;
  for (const b of bars) {
    if (b.close > b.open)      buys++;
    else if (b.close < b.open) sells++;
  }
  if (buys > sells * 1.2)  return 'positive';
  if (sells > buys * 1.2)  return 'negative';
  return 'neutral';
}
