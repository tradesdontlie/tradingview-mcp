/**
 * Zigzag pivot detection over an OHLCV bar array.
 * A pivot high/low is confirmed once price reverses by >= thresholdPct from
 * the running extreme. This is the standard "swing" building block that every
 * other detector (S/R, trendlines, Elliott Wave, chart patterns) is built on.
 *
 * IMPORTANT: only fully-reversed (confirmed) pivots are returned. The
 * in-progress extreme at the tail of the data — wherever price currently
 * sits, which may not have reversed by thresholdPct yet — is deliberately
 * NOT included. Earlier versions pushed that unconfirmed point as a normal
 * pivot, which let detectors (Elliott Wave impulse/wave3, chart patterns)
 * treat "today's price" as if it were a completed wave/swing point — a
 * recency bias that over-flagged setups that hadn't actually completed.
 * Callers that need "where is price right now relative to the last
 * confirmed swing" should read the bars array directly (e.g.
 * bars[bars.length-1].close), not expect it from this pivot list.
 */

/**
 * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} bars
 * @param {number} thresholdPct e.g. 0.04 = 4% reversal required to confirm a pivot
 * @returns {Array<{index:number, time:number, price:number, type:'high'|'low'}>}
 */
export function findPivots(bars, thresholdPct = 0.04) {
  if (!bars || bars.length < 3) return [];

  const pivots = [];
  let direction = 0; // 1 = looking for a high, -1 = looking for a low, 0 = undetermined
  let extremeIndex = 0;
  let extremePrice = bars[0].close;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];

    if (direction >= 0 && bar.high >= extremePrice) {
      extremePrice = bar.high;
      extremeIndex = i;
      direction = 1;
      continue;
    }
    if (direction <= 0 && bar.low <= extremePrice) {
      extremePrice = bar.low;
      extremeIndex = i;
      direction = -1;
      continue;
    }

    if (direction === 1) {
      const drawdown = (extremePrice - bar.low) / extremePrice;
      if (drawdown >= thresholdPct) {
        pivots.push({ index: extremeIndex, time: bars[extremeIndex].time, price: extremePrice, type: 'high' });
        direction = -1;
        extremePrice = bar.low;
        extremeIndex = i;
      }
    } else if (direction === -1) {
      const rally = (bar.high - extremePrice) / extremePrice;
      if (rally >= thresholdPct) {
        pivots.push({ index: extremeIndex, time: bars[extremeIndex].time, price: extremePrice, type: 'low' });
        direction = 1;
        extremePrice = bar.high;
        extremeIndex = i;
      }
    }
  }

  // The current running extreme (extremePrice/extremeIndex) is deliberately
  // NOT pushed here — it hasn't reversed by thresholdPct yet, so it isn't a
  // confirmed pivot. See the confirmed-only note in the file header.

  return pivots;
}

export function avgVolume(bars, lookback = 20) {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, b) => sum + (b.volume || 0), 0) / slice.length;
}

/** Average daily transaction VALUE (price * volume, in Rupiah) — a liquidity gate. */
export function avgValueTraded(bars, lookback = 50) {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, b) => sum + b.close * (b.volume || 0), 0) / slice.length;
}

export function sma(bars, period) {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((sum, b) => sum + b.close, 0) / period;
}
