/**
 * Volume Profile bias filters — pure functions over OHLC+volume bar arrays.
 * Encodes the two mechanical "hard rules" from the curriculum's Volume
 * Profile series (Chapters 14 & 17) that are explicitly framed as
 * CONFLUENCE/bias tools, not standalone entry triggers:
 *
 *   - Ch.17 VWAP: "If the price is above VWAP, then don't short. If the
 *     price is below VWAP, don't long." ("The rules don't apply if you are
 *     taking swing trades on the 4H timeframe" — so this is scoped to the
 *     same lower timeframe as the trade trigger.)
 *   - Ch.14 VPVR: "Above VaH -> Trading above 'Fair Value' so look for
 *     shorts. Below VaL -> Trading below 'Fair Value' so look for longs."
 *
 * Ch.15 (FRVP) and Ch.16 (VPSV) both depend on a discretionary choice (where
 * to draw a fixed range; what counts as the "previous session" / untapped
 * nPOC across many sessions) and are NOT encoded here, for the same reason
 * as other discretionary concepts (see feedback_encoding_discipline).
 *
 * Bars are expected in {open_time, high, low, close, volume} shape (matches
 * getKlines() output).
 */

function requireBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('bars must be a non-empty array of OHLC candles');
  return bars;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Session VWAP = cumulative(typicalPrice * volume) / cumulative(volume),
 * reset at each UTC day boundary ("Session VWAP ... is based on data for the
 * current trading day", "24 hour periods for crypto" per Ch.16).
 * typicalPrice = (high + low + close) / 3 (Ch.17's formula).
 * Returns one VWAP value per bar (null only if a bar's session has zero
 * cumulative volume, which shouldn't happen with real kline data).
 */
export function calculateSessionVWAP(bars) {
  requireBars(bars);
  const values = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumVolume = 0;
  let currentDay = null;
  for (let i = 0; i < bars.length; i++) {
    const day = Math.floor(Number(bars[i].open_time) / MS_PER_DAY);
    if (day !== currentDay) {
      cumPV = 0;
      cumVolume = 0;
      currentDay = day;
    }
    const typicalPrice = (Number(bars[i].high) + Number(bars[i].low) + Number(bars[i].close)) / 3;
    cumPV += typicalPrice * Number(bars[i].volume);
    cumVolume += Number(bars[i].volume);
    values[i] = cumVolume > 0 ? cumPV / cumVolume : null;
  }
  return values;
}

/**
 * Ch.17's hard rule, evaluated on the latest bar: "If the price is above
 * VWAP, then don't short. If the price is below VWAP, don't long." -> the
 * `bias` is the ONLY side still allowed (the curriculum's negative framing
 * restated positively for use as a signal filter).
 */
export function classifyVWAPBias(bars) {
  requireBars(bars);
  const vwapValues = calculateSessionVWAP(bars);
  const vwap = vwapValues[vwapValues.length - 1];
  const close = Number(bars[bars.length - 1].close);
  let bias = null;
  if (vwap !== null) {
    if (close > vwap) bias = 'long';
    else if (close < vwap) bias = 'short';
  }
  return { bias, vwap, close };
}

/**
 * Volume-by-price profile over a bar series ("the visible price action on
 * your chart" — Ch.14). Each bar's volume is assigned to the bin containing
 * its CLOSE price (close-based, matching this codebase's other "compare
 * bodies, not wicks" conventions). POC = the bin with the most volume; the
 * Value Area expands outward from the POC bin, always adding whichever
 * adjacent bin (above or below the current range) has more volume, until
 * the cumulative volume covers `valueAreaPercent` of the total — the
 * standard Value Area construction.
 *
 * Returns { poc, vah, val, totalVolume } as prices (poc is the bin
 * midpoint; vah/val are the value-area range's outer bin edges).
 */
export function calculateValueArea(bars, { bins = 24, valueAreaPercent = 70 } = {}) {
  requireBars(bars);
  if (!Number.isInteger(bins) || bins <= 0) throw new Error('bins must be a positive integer');
  if (!(valueAreaPercent > 0 && valueAreaPercent <= 100)) throw new Error('valueAreaPercent must be between 0 and 100');

  const closes = bars.map(b => Number(b.close));
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const totalVolume = bars.reduce((sum, b) => sum + Number(b.volume), 0);

  if (hi === lo) return { poc: lo, vah: hi, val: lo, totalVolume, valueAreaPercent };

  const binSize = (hi - lo) / bins;
  const volumes = new Array(bins).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let idx = Math.floor((closes[i] - lo) / binSize);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    volumes[idx] += Number(bars[i].volume);
  }

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volumes[i] > volumes[pocIdx]) pocIdx = i;

  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  let covered = volumes[pocIdx];
  const target = totalVolume * (valueAreaPercent / 100);
  while (covered < target && (lowIdx > 0 || highIdx < bins - 1)) {
    const belowVolume = lowIdx > 0 ? volumes[lowIdx - 1] : -1;
    const aboveVolume = highIdx < bins - 1 ? volumes[highIdx + 1] : -1;
    if (aboveVolume >= belowVolume) { highIdx++; covered += volumes[highIdx]; }
    else { lowIdx--; covered += volumes[lowIdx]; }
  }

  return {
    poc: lo + (pocIdx + 0.5) * binSize,
    vah: lo + (highIdx + 1) * binSize,
    val: lo + lowIdx * binSize,
    totalVolume,
    valueAreaPercent,
  };
}

/**
 * Ch.14's hard rule, evaluated on the latest bar: "Above VaH -> Trading
 * above 'Fair Value' so look for shorts. Below VaL -> Trading below 'Fair
 * Value' so look for longs." -> `bias` is the side this favors (null if the
 * close is inside the value area, where the curriculum gives no directional
 * read).
 */
export function classifyValueAreaBias(bars, opts = {}) {
  requireBars(bars);
  const { poc, vah, val, totalVolume, valueAreaPercent } = calculateValueArea(bars, opts);
  const close = Number(bars[bars.length - 1].close);
  let bias = null;
  let position = 'inside';
  if (close > vah) { position = 'above'; bias = 'short'; }
  else if (close < val) { position = 'below'; bias = 'long'; }
  return { bias, position, poc, vah, val, close, totalVolume, valueAreaPercent };
}
