/**
 * Timeframe utilities — bar-duration math + min-bars-per-tf config used by the
 * screenshot path to guarantee a sensible window. "More is okay, less is not":
 * we only EXPAND a tight range to meet the minimum, never shrink a wide one.
 */

// Minimum bars to show per resolution so candles aren't squashed/clipped.
// Defaults assume NSE 6h15m = 375 minutes per session (75 × 5-min bars).
export const MIN_BARS_BY_TF = {
  '1':   750,    // 2 sessions
  '3':   250,    // 2 sessions
  '5':   150,    // 2 sessions
  '10':  75,     // 2 sessions
  '15':  50,     // 2 sessions
  '30':  26,     // 2 sessions
  '60':  30,     // ~4-5 sessions
  '120': 20,
  '240': 15,
  'D':   120,    // ~6 months
  'W':   52,     // ~1 year
  'M':   24,     // 2 years
};

/** Seconds per bar for a resolution string. Supports "5","60","4H","D","W","M". */
export function secPerBar(tf) {
  const s = String(tf).toUpperCase().trim();
  if (s === 'D' || s === '1D') return 86400;
  if (s === 'W' || s === '1W') return 7 * 86400;
  if (s === 'M' || s === '1M') return 30 * 86400;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return s.endsWith('H') ? n * 3600 : n * 60;
}

/** Pick the nearest defined key in `MIN_BARS_BY_TF` by sec-per-bar distance. */
export function nearestTfKey(tf) {
  const s = String(tf).toUpperCase().trim();
  if (Object.prototype.hasOwnProperty.call(MIN_BARS_BY_TF, s)) return s;
  // Try numeric direct match for unsuffixed minutes
  const target = secPerBar(s);
  let best = null, bestDist = Infinity;
  for (const k of Object.keys(MIN_BARS_BY_TF)) {
    const d = Math.abs(secPerBar(k) - target);
    if (d < bestDist) { best = k; bestDist = d; }
  }
  return best;
}

/** Minimum bars required for a given resolution (falls back to nearest defined). */
export function minBarsFor(tf) {
  const k = nearestTfKey(tf);
  return MIN_BARS_BY_TF[k];
}

/**
 * Expand [from,to] symmetrically until it covers ≥ `minBars` bars at the given
 * timeframe. Never shrinks. Returns `{ from, to, expanded, target, spanBars }`.
 *
 * @param {{from:number, to:number, timeframe:string, minBars?:number}} args
 */
export function expandRangeToMinBars({ from, to, timeframe, minBars }) {
  const spb = secPerBar(timeframe);
  const span = to - from;
  const target = minBars != null ? minBars : minBarsFor(timeframe);
  const minSpan = target * spb;
  if (span >= minSpan) return { from, to, expanded: false, target, spanBars: Math.round(span / spb) };
  const need = minSpan - span;
  const half = Math.ceil(need / 2);
  return { from: from - half, to: to + half, expanded: true, target, spanBars: target };
}
