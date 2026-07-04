/**
 * Classic chart pattern detection — pure functions over OHLC bar arrays.
 *
 * NOT from the PDF curriculum — these are standard technical-analysis chart
 * patterns (the "next layer" of trader experience beyond the 13 encoded
 * chapters). Per Approach A, only patterns with a precise, self-contained
 * mechanical spec get encoded; each detector below documents its exact
 * thresholds so the read is reproducible, not eyeballed.
 *
 * Shared conventions (matching sfp.js / market_structure.js / levels.js):
 *   - Swing points are {index, price} objects (from findSwingHighs/Lows).
 *   - "Breakout" / "confirmation" is always CLOSE-based (scanForCloseBreak),
 *     never a wick alone — same standard used everywhere else in this bot.
 *   - Trade plans are {side, entry, stop, target, alternate_target} —
 *     directly consumable by core/risk.evaluateTradeSetup().
 *
 * Deliberately NOT encoded: cup & handle, rounding tops/bottoms, multi-
 * shoulder H&S variants, diamond tops/bottoms, and any pattern whose
 * boundary is a smooth curve rather than swing points + straight lines —
 * these require shape judgment that can't be reduced to a close-based check
 * without becoming arbitrary.
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 */

import { scanForCloseBreak } from './market_structure.js';

function requireBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('bars must be a non-empty array of OHLC candles');
  return bars;
}

function requireSwingPointArray(points, name) {
  if (!Array.isArray(points)) throw new Error(`${name} must be an array of swing point objects`);
  for (const p of points) {
    if (!p || !Number.isInteger(p.index) || typeof p.price !== 'number') throw new Error(`${name} entries must be {index, price} swing point objects`);
  }
  return points;
}

/** target = entry +/- height, in the trade's favorable direction. */
function measuredMoveTarget({ entry, height, side }) {
  return side === 'long' ? entry + height : entry - height;
}

function withAlternateTarget(plan, rangeLevel) {
  if (rangeLevel === undefined || rangeLevel === null) return plan;
  return { ...plan, alternate_target: rangeLevel };
}

// ---------------------------------------------------------------------------
// Double Top / Double Bottom
// ---------------------------------------------------------------------------

/**
 * Double Top: two consecutive swing highs H1 (older) and H2 (newer) within
 * `tolerancePercent` of each other's price (the "near-equal peaks" that
 * define an M), with at least one swing low strictly between them. The
 * neckline is the LOWEST such swing low (the deepest pullback between the
 * two peaks — the conservative, hardest-to-break neckline).
 *
 * Double Bottom mirrors this with swing lows (a W), neckline = the HIGHEST
 * swing high between the two troughs.
 *
 * tolerancePercent default 1.5% — tight enough that the two peaks/troughs
 * read as "the same level retested", not two unrelated swings.
 */
export function findDoubleTopBottom(bars, { swingHighs, swingLows, tolerancePercent = 1.5 } = {}) {
  requireBars(bars);
  requireSwingPointArray(swingHighs, 'swingHighs');
  requireSwingPointArray(swingLows, 'swingLows');

  const patterns = [];

  for (let i = 1; i < swingHighs.length; i++) {
    const h1 = swingHighs[i - 1], h2 = swingHighs[i];
    const diffPct = Math.abs(h2.price - h1.price) / h1.price * 100;
    if (diffPct > tolerancePercent) continue;
    const between = swingLows.filter(l => l.index > h1.index && l.index < h2.index);
    if (!between.length) continue;
    const neckline = between.reduce((min, l) => (l.price < min.price ? l : min), between[0]);
    patterns.push({
      type: 'double_top',
      points: [h1, h2],
      neckline,
      necklineLevel: neckline.price,
      breakoutDirection: 'below',
      side: 'short',
      height: Math.max(h1.price, h2.price) - neckline.price,
      stopLevel: Math.max(h1.price, h2.price),
      fromIndex: Math.max(h1.index, h2.index) + 1,
    });
  }

  for (let i = 1; i < swingLows.length; i++) {
    const l1 = swingLows[i - 1], l2 = swingLows[i];
    const diffPct = Math.abs(l2.price - l1.price) / l1.price * 100;
    if (diffPct > tolerancePercent) continue;
    const between = swingHighs.filter(h => h.index > l1.index && h.index < l2.index);
    if (!between.length) continue;
    const neckline = between.reduce((max, h) => (h.price > max.price ? h : max), between[0]);
    patterns.push({
      type: 'double_bottom',
      points: [l1, l2],
      neckline,
      necklineLevel: neckline.price,
      breakoutDirection: 'above',
      side: 'long',
      height: neckline.price - Math.min(l1.price, l2.price),
      stopLevel: Math.min(l1.price, l2.price),
      fromIndex: Math.max(l1.index, l2.index) + 1,
    });
  }

  return patterns.sort((a, b) => Math.max(...a.points.map(p => p.index)) - Math.max(...b.points.map(p => p.index)));
}

/**
 * Scan for the close-based neckline break that confirms a double top/bottom
 * (or H&S/inverse H&S, which share the same {necklineLevel, breakoutDirection,
 * fromIndex} shape). Returns null if no break has occurred yet.
 */
export function scanForNecklineBreak(bars, pattern) {
  requireBars(bars);
  return scanForCloseBreak(bars, {
    level: pattern.necklineLevel,
    direction: pattern.breakoutDirection,
    fromIndex: pattern.fromIndex,
  });
}

/**
 * Build a trade plan from a confirmed neckline break.
 * entry = close of the break candle; stop = beyond the pattern's extreme
 * (the higher top / lower bottom — `pattern.stopLevel`); target = measured
 * move (pattern height projected from the NECKLINE — the standard TA target
 * rule — not from entry, which may already sit past the neckline by the time
 * the breakout closes).
 */
export function buildDoubleTopBottomTradePlan({ pattern, breakout, rangeLevel } = {}) {
  if (!pattern?.necklineLevel) throw new Error('pattern must be a double_top/double_bottom result from findDoubleTopBottom');
  if (!breakout?.bar) throw new Error('breakout must be a confirmed neckline break (from scanForNecklineBreak)');

  const plan = {
    side: pattern.side,
    entry: breakout.bar.close,
    stop: pattern.stopLevel,
    target: measuredMoveTarget({ entry: pattern.necklineLevel, height: pattern.height, side: pattern.side }),
  };
  return withAlternateTarget(plan, rangeLevel);
}

// ---------------------------------------------------------------------------
// Head & Shoulders / Inverse Head & Shoulders
// ---------------------------------------------------------------------------

/**
 * Head & Shoulders: three consecutive swing highs Left Shoulder (LS), Head
 * (H), Right Shoulder (RS) where H exceeds both shoulders and the shoulders
 * are within `shoulderTolerancePercent` of each other (roughly symmetric).
 * The neckline is the HIGHER of the two swing lows flanking the head (the
 * shallower pullback — the conservative, hardest-to-break neckline, same
 * principle as the double-top neckline).
 *
 * Inverse H&S mirrors this with swing lows (H is the lowest), neckline =
 * the LOWER of the two swing highs flanking the head.
 *
 * shoulderTolerancePercent default 5% — wider than the double-top tolerance
 * because shoulders are rarely as symmetric as double tops/bottoms in
 * practice; the HEAD being strictly more extreme than both is the load-
 * bearing check, not shoulder symmetry.
 */
export function findHeadAndShoulders(bars, { swingHighs, swingLows, shoulderTolerancePercent = 5 } = {}) {
  requireBars(bars);
  requireSwingPointArray(swingHighs, 'swingHighs');
  requireSwingPointArray(swingLows, 'swingLows');

  const patterns = [];

  for (let i = 2; i < swingHighs.length; i++) {
    const ls = swingHighs[i - 2], h = swingHighs[i - 1], rs = swingHighs[i];
    if (!(h.price > ls.price && h.price > rs.price)) continue;
    const diffPct = Math.abs(rs.price - ls.price) / ls.price * 100;
    if (diffPct > shoulderTolerancePercent) continue;
    const leftLows = swingLows.filter(l => l.index > ls.index && l.index < h.index);
    const rightLows = swingLows.filter(l => l.index > h.index && l.index < rs.index);
    if (!leftLows.length || !rightLows.length) continue;
    const leftLow = leftLows[leftLows.length - 1], rightLow = rightLows[0];
    const neckline = leftLow.price >= rightLow.price ? leftLow : rightLow;
    patterns.push({
      type: 'head_and_shoulders',
      points: [ls, h, rs],
      neckline,
      necklineLevel: neckline.price,
      breakoutDirection: 'below',
      side: 'short',
      height: h.price - neckline.price,
      stopLevel: h.price,
      fromIndex: rs.index + 1,
    });
  }

  for (let i = 2; i < swingLows.length; i++) {
    const ls = swingLows[i - 2], h = swingLows[i - 1], rs = swingLows[i];
    if (!(h.price < ls.price && h.price < rs.price)) continue;
    const diffPct = Math.abs(rs.price - ls.price) / ls.price * 100;
    if (diffPct > shoulderTolerancePercent) continue;
    const leftHighs = swingHighs.filter(p => p.index > ls.index && p.index < h.index);
    const rightHighs = swingHighs.filter(p => p.index > h.index && p.index < rs.index);
    if (!leftHighs.length || !rightHighs.length) continue;
    const leftHigh = leftHighs[leftHighs.length - 1], rightHigh = rightHighs[0];
    const neckline = leftHigh.price <= rightHigh.price ? leftHigh : rightHigh;
    patterns.push({
      type: 'inverse_head_and_shoulders',
      points: [ls, h, rs],
      neckline,
      necklineLevel: neckline.price,
      breakoutDirection: 'above',
      side: 'long',
      height: neckline.price - h.price,
      stopLevel: h.price,
      fromIndex: rs.index + 1,
    });
  }

  return patterns.sort((a, b) => a.points[2].index - b.points[2].index);
}

/**
 * Build a trade plan from a confirmed H&S/inverse-H&S neckline break.
 * entry = close of the break candle; stop = beyond the head (`pattern.stopLevel`
 * — the pattern's single most extreme point); target = measured move (head-
 * to-neckline height projected from the NECKLINE, not from entry, which may
 * already sit past the neckline by the time the breakout closes).
 */
export function buildHeadAndShouldersTradePlan({ pattern, breakout, rangeLevel } = {}) {
  if (!pattern?.necklineLevel) throw new Error('pattern must be a head_and_shoulders/inverse_head_and_shoulders result from findHeadAndShoulders');
  if (!breakout?.bar) throw new Error('breakout must be a confirmed neckline break (from scanForNecklineBreak)');

  const plan = {
    side: pattern.side,
    entry: breakout.bar.close,
    stop: pattern.stopLevel,
    target: measuredMoveTarget({ entry: pattern.necklineLevel, height: pattern.height, side: pattern.side }),
  };
  return withAlternateTarget(plan, rangeLevel);
}

// ---------------------------------------------------------------------------
// Triangles (ascending / descending / symmetrical)
// ---------------------------------------------------------------------------

/**
 * Scan for a close-based break of a SLOPED trendline (the level moves bar-
 * to-bar: level(i) = anchorPrice + slope * (i - anchorIndex)). Same close-
 * based-confirmation principle as scanForCloseBreak, generalized to a line
 * instead of a flat level.
 */
export function scanForTrendlineBreak(bars, { slope, anchorPrice, anchorIndex, direction, fromIndex = 0 } = {}) {
  requireBars(bars);
  const dir = String(direction).toLowerCase();
  if (!['above', 'below'].includes(dir)) throw new Error('direction must be "above" or "below"');

  for (let i = Math.max(0, fromIndex); i < bars.length; i++) {
    const level = anchorPrice + slope * (i - anchorIndex);
    const bar = bars[i];
    const broke = dir === 'above' ? bar.close > level : bar.close < level;
    if (broke) return { index: i, bar, level };
  }
  return null;
}

/**
 * Classify the two most recent swing highs and two most recent swing lows
 * into a triangle, using each pair's price-per-bar slope:
 *   - ascending:   upper line FLAT, lower line RISING  -> breakout above the
 *                  flat resistance -> long
 *   - descending:  lower line FLAT, upper line FALLING -> breakout below the
 *                  flat support -> short
 *   - symmetrical: upper FALLING and lower RISING (converging) -> breakout
 *                  either direction; side decided by whichever line breaks
 *                  first (see scanForTriangleBreakout)
 *
 * "Flat" means |slope| <= flatSlopePercent% of the latest close, per bar.
 * Returns null if fewer than 2 swing highs/lows, or the shape doesn't match
 * one of the three triangle types (e.g. both lines rising = a channel, not
 * a triangle — deliberately not classified here).
 */
export function findTriangle(bars, { swingHighs, swingLows, flatSlopePercent = 0.02 } = {}) {
  requireBars(bars);
  requireSwingPointArray(swingHighs, 'swingHighs');
  requireSwingPointArray(swingLows, 'swingLows');

  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  const h1 = swingHighs[swingHighs.length - 2], h2 = swingHighs[swingHighs.length - 1];
  const l1 = swingLows[swingLows.length - 2], l2 = swingLows[swingLows.length - 1];
  if (h2.index === h1.index || l2.index === l1.index) return null;

  const upperSlope = (h2.price - h1.price) / (h2.index - h1.index);
  const lowerSlope = (l2.price - l1.price) / (l2.index - l1.index);
  const flatThreshold = bars[bars.length - 1].close * (flatSlopePercent / 100);

  const upperFlat = Math.abs(upperSlope) <= flatThreshold;
  const lowerFlat = Math.abs(lowerSlope) <= flatThreshold;

  let type;
  if (upperFlat && lowerSlope > flatThreshold) type = 'ascending_triangle';
  else if (lowerFlat && upperSlope < -flatThreshold) type = 'descending_triangle';
  else if (upperSlope < -flatThreshold && lowerSlope > flatThreshold) type = 'symmetrical_triangle';
  else return null;

  return {
    type,
    points: { upper: [h1, h2], lower: [l1, l2] },
    upperSlope,
    lowerSlope,
    height: Math.max(h1.price, h2.price) - Math.min(l1.price, l2.price),
    fromIndex: Math.max(h2.index, l2.index) + 1,
  };
}

/**
 * Scan for a confirmed triangle breakout. Ascending triangles only check the
 * upper (flat resistance) line; descending only the lower (flat support)
 * line; symmetrical checks both and returns whichever breaks FIRST
 * (chronologically) — that's the side the triangle actually resolved toward.
 */
export function scanForTriangleBreakout(bars, triangle) {
  if (!triangle?.points) throw new Error('triangle must be a result from findTriangle');
  const { type, points, upperSlope, lowerSlope, fromIndex } = triangle;

  const upperBrk = type !== 'descending_triangle'
    ? scanForTrendlineBreak(bars, { slope: upperSlope, anchorPrice: points.upper[1].price, anchorIndex: points.upper[1].index, direction: 'above', fromIndex })
    : null;
  const lowerBrk = type !== 'ascending_triangle'
    ? scanForTrendlineBreak(bars, { slope: lowerSlope, anchorPrice: points.lower[1].price, anchorIndex: points.lower[1].index, direction: 'below', fromIndex })
    : null;

  if (upperBrk && lowerBrk) return upperBrk.index <= lowerBrk.index ? { ...upperBrk, side: 'long' } : { ...lowerBrk, side: 'short' };
  if (upperBrk) return { ...upperBrk, side: 'long' };
  if (lowerBrk) return { ...lowerBrk, side: 'short' };
  return null;
}

/**
 * Build a trade plan from a confirmed triangle breakout.
 * entry = close of the break candle; stop = the most recent swing point on
 * the OPPOSITE side of the triangle (the line that did NOT break); target =
 * measured move (the triangle's widest height, projected from the BROKEN
 * TRENDLINE's level at the breakout bar — `breakout.level` — not from entry,
 * which may already sit past that line by the time the breakout closes).
 */
export function buildTriangleTradePlan({ triangle, breakout, rangeLevel } = {}) {
  if (!triangle?.points) throw new Error('triangle must be a result from findTriangle');
  if (!breakout?.bar) throw new Error('breakout must be a confirmed triangle breakout (from scanForTriangleBreakout)');

  const stop = breakout.side === 'long' ? triangle.points.lower[1].price : triangle.points.upper[1].price;
  const plan = {
    side: breakout.side,
    entry: breakout.bar.close,
    stop,
    target: measuredMoveTarget({ entry: breakout.level, height: triangle.height, side: breakout.side }),
  };
  return withAlternateTarget(plan, rangeLevel);
}

// ---------------------------------------------------------------------------
// Flags / Pennants
// ---------------------------------------------------------------------------

/**
 * Flag/Pennant: a sharp directional "flagpole" move over the `poleLookback`
 * bars immediately before the most recent `flagLookback` bars, followed by a
 * tight consolidation in those most recent bars.
 *
 *   - Flagpole direction: net close-to-open move over the pole window must
 *     cover >= `poleDirectionalityRatio` (default 60%) of the pole's
 *     high-low range — i.e. mostly one-directional, not a choppy range.
 *   - Consolidation tightness: the flag window's high-low range must be
 *     <= `consolidationMaxRatio` (default 50%) of the pole's range.
 *   - Breakout direction = the flagpole's direction (continuation pattern).
 *
 * Returns null if there isn't enough history, the pole isn't directional
 * enough, or the consolidation isn't tight enough.
 */
export function findFlagPennant(bars, { poleLookback = 10, flagLookback = 8, poleDirectionalityRatio = 0.6, consolidationMaxRatio = 0.5 } = {}) {
  requireBars(bars);
  const n = bars.length;
  const flagStart = n - flagLookback;
  const poleStart = flagStart - poleLookback;
  if (poleStart < 0) return null;

  const poleBars = bars.slice(poleStart, flagStart);
  const flagBars = bars.slice(flagStart, n);

  const poleHigh = Math.max(...poleBars.map(b => b.high));
  const poleLow = Math.min(...poleBars.map(b => b.low));
  const poleRange = poleHigh - poleLow;
  if (poleRange <= 0) return null;

  const poleMove = poleBars[poleBars.length - 1].close - poleBars[0].open;
  if (Math.abs(poleMove) / poleRange < poleDirectionalityRatio) return null;
  const side = poleMove > 0 ? 'long' : 'short';

  const flagHigh = Math.max(...flagBars.map(b => b.high));
  const flagLow = Math.min(...flagBars.map(b => b.low));
  const flagRange = flagHigh - flagLow;
  if (flagRange > poleRange * consolidationMaxRatio) return null;

  return {
    type: 'flag_pennant',
    side,
    breakoutLevel: side === 'long' ? flagHigh : flagLow,
    stopLevel: side === 'long' ? flagLow : flagHigh,
    height: poleRange,
    breakoutDirection: side === 'long' ? 'above' : 'below',
    fromIndex: n,
  };
}

/**
 * Scan for the close-based break of the flag/pennant's consolidation range
 * in the flagpole's direction (continuation confirmation).
 */
export function scanForFlagBreakout(bars, pattern) {
  requireBars(bars);
  return scanForCloseBreak(bars, {
    level: pattern.breakoutLevel,
    direction: pattern.breakoutDirection,
    fromIndex: pattern.fromIndex,
  });
}

/**
 * Build a trade plan from a confirmed flag/pennant breakout.
 * entry = close of the break candle; stop = the opposite edge of the
 * consolidation range; target = measured move (flagpole height projected
 * from the consolidation's BREAKOUT EDGE — `pattern.breakoutLevel` — the
 * standard "flagpole repeats from the breakout point" rule, not from entry
 * which may already sit past that edge by the time the breakout closes).
 */
export function buildFlagTradePlan({ pattern, breakout, rangeLevel } = {}) {
  if (!pattern?.breakoutLevel) throw new Error('pattern must be a flag_pennant result from findFlagPennant');
  if (!breakout?.bar) throw new Error('breakout must be a confirmed flag breakout (from scanForFlagBreakout)');

  const plan = {
    side: pattern.side,
    entry: breakout.bar.close,
    stop: pattern.stopLevel,
    target: measuredMoveTarget({ entry: pattern.breakoutLevel, height: pattern.height, side: pattern.side }),
  };
  return withAlternateTarget(plan, rangeLevel);
}
