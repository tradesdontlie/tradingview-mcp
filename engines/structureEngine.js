/**
 * Detects swing points, market structure shifts (MSS/CHoCH), and displacement candles.
 *
 * @module structureEngine
 */

/**
 * @typedef {{ index: number, price: number }} SwingPoint
 * @typedef {{ highs: SwingPoint[], lows: SwingPoint[] }} SwingPoints
 * @typedef {{ detected: boolean, mssBarIndex: number|null }} MssResult
 * @typedef {{ index: number, direction: "bullish"|"bearish",
 *             bodySize: number, volumeRatio: number }|null} DisplacementCandle
 */

/**
 * Identifies swing highs and swing lows using a symmetric lookback pivot.
 *
 * A swing high at index i: bar[i].high > bar[j].high for all j in [i−lookback, i+lookback], j ≠ i
 * A swing low  at index i: bar[i].low  < bar[j].low  for all j in [i−lookback, i+lookback], j ≠ i
 *
 * @param {Array<{high:number,low:number}>} bars
 * @param {number} [lookback=3]
 * @returns {SwingPoints}
 */
export function findSwingPoints(bars, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const b = bars[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= b.high) isHigh = false;
      if (bars[j].low  <= b.low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: b.high });
    if (isLow)  lows.push({  index: i, price: b.low  });
  }
  return { highs, lows };
}

/**
 * Detects a Market Structure Shift (MSS) or Change of Character (CHoCH) after a sweep.
 *
 * Bullish MSS: after `afterIndex`, the first bar whose high exceeds the highest high
 *              seen in bars[0..afterIndex] signals that buyers have taken control.
 * Bearish MSS: after `afterIndex`, the first bar whose low falls below the lowest low
 *              seen in bars[0..afterIndex] signals that sellers have taken control.
 *
 * @param {Array<{high:number,low:number}>} bars
 * @param {number} afterIndex - the sweep bar index; search begins at afterIndex+1
 * @param {"bullish"|"bearish"} direction
 * @returns {MssResult}
 */
export function detectMss(bars, afterIndex, direction) {
  const preSlice = bars.slice(0, afterIndex + 1);
  if (!preSlice.length) return { detected: false, mssBarIndex: null };

  if (direction === 'bullish') {
    const refHigh = Math.max(...preSlice.map(b => b.high));
    for (let i = afterIndex + 1; i < bars.length; i++) {
      if (bars[i].high > refHigh) return { detected: true, mssBarIndex: i };
    }
  } else {
    const refLow = Math.min(...preSlice.map(b => b.low));
    for (let i = afterIndex + 1; i < bars.length; i++) {
      if (bars[i].low < refLow) return { detected: true, mssBarIndex: i };
    }
  }
  return { detected: false, mssBarIndex: null };
}

/**
 * Finds the first displacement candle at or after `afterIndex`.
 *
 * A displacement candle has:
 *   body > avgBody(bars[0..afterIndex−1]) × bodyMult
 *   vol  > avgVol(bars[0..afterIndex−1])  × volMult
 *
 * @param {Array<{open:number,high:number,low:number,close:number,vol:number}>} bars
 * @param {number} afterIndex - search starts here (inclusive)
 * @param {number} [bodyMult=1.5]
 * @param {number} [volMult=1.5]
 * @returns {DisplacementCandle}
 */
export function findDisplacementCandle(bars, afterIndex, bodyMult = 1.5, volMult = 1.5) {
  if (afterIndex <= 0 || bars.length <= afterIndex) return null;

  const prior = bars.slice(0, afterIndex);
  if (!prior.length) return null;

  const avgBody = prior.reduce((s, b) => s + Math.abs(b.close - b.open), 0) / prior.length;
  const avgVol  = prior.reduce((s, b) => s + b.vol, 0) / prior.length;

  for (let i = afterIndex; i < bars.length; i++) {
    const b = bars[i];
    const body     = Math.abs(b.close - b.open);
    const volRatio = avgVol > 0 ? b.vol / avgVol : 0;
    if (body > avgBody * bodyMult && volRatio > volMult) {
      return {
        index:       i,
        direction:   b.close >= b.open ? 'bullish' : 'bearish',
        bodySize:    +body.toFixed(4),
        volumeRatio: +volRatio.toFixed(3),
      };
    }
  }
  return null;
}
