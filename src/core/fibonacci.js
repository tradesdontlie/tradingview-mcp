/**
 * Fibonacci confluence detection — pure functions over OHLC bar arrays.
 * Encodes the mechanical spec from the curriculum (Chapters 7, 9 — the
 * "Fibonacci" / "Fibs Advanced" series):
 *
 *   - Levels are measured from a clear swing: point A (the prior extreme) to
 *     point B (the most recent extreme). In an uptrend, A = swing low,
 *     B = swing high, and retracement levels below B are SUPPORT candidates;
 *     in a downtrend, A = swing high, B = swing low, and retracement levels
 *     above B are RESISTANCE candidates ("In an uptrend, identify your
 *     previous LOW and previous HIGH... use the retracement to identify
 *     possible SUPPORT levels"; the downtrend case is the mirror).
 *   - Level formula: level = B - (B - A) * ratio — this is the curriculum's
 *     "percentage of how much of a prior move the price has retraced".
 *   - The "golden pocket" (0.618-0.66) is THE named, emphasized reaction
 *     zone: "the numerical values/percentages that price usually respects
 *     as an area of support or resistance... My personal preference for the
 *     golden pocket is the region between the 0.618 and the 0.66" (Ch.9).
 *     This module focuses on that single, precisely-specified zone — the
 *     curriculum names other levels (0.236/0.382/0.5/0.702/0.786) and
 *     extension/negative-fib targets too, but gives no single canonical
 *     formula for them, and "Fibonacci tools act as a CONFLUENCE... it is
 *     not advisable to use fib retracement on their own" anyway (Ch.7) —
 *     encoding a shakier formula just to have more levels would be live
 *     judgment wearing code's clothing, the exact thing Approach A avoids.
 *   - A reaction = price wicks INTO the golden pocket but CLOSES back out
 *     the trend-continuation side — the same close-based sweep-and-reject
 *     mechanic as SFP (Ch.6 itself draws this connection: "Keeping in mind
 *     the SFP tutorial... how... do you decide till where the [reaction]
 *     wick could go"), generalized from a single level to a zone.
 *   - "It is not advisable to use fib levels for stops" (Ch.7) — stops here
 *     are placed beyond the reaction candle's wick (market-structure based,
 *     mirroring buildSFPTradePlan), never at a fib level.
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 */
import { isDoji } from './sfp.js';

function requireBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('bars must be a non-empty array of OHLC candles');
  return bars;
}

function requirePositiveFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number, got: ${value}`);
  return n;
}

/**
 * A single Fibonacci retracement level between swing points A (start, the
 * prior extreme) and B (end, the most recent extreme): "percentage of how
 * much of a prior move the price has retraced" (Ch.7). 0 -> at B (the most
 * recent extreme, "0% retraced"); 1 -> at A (fully retraced).
 */
export function calculateRetracementLevel({ start, end, ratio } = {}) {
  const a = requirePositiveFinite(start, 'start');
  const b = requirePositiveFinite(end, 'end');
  const r = Number(ratio);
  if (!Number.isFinite(r)) throw new Error(`ratio must be a finite number, got: ${ratio}`);
  return b - (b - a) * r;
}

/**
 * The golden pocket — "the area where certain fib levels lie... the region
 * between the 0.618 and the 0.66" (Ch.9), the curriculum's single named,
 * precisely-bounded high-conviction reaction zone. Returns price bounds
 * regardless of swing direction (low <= high).
 */
export function findGoldenPocket({ start, end, ratios = [0.618, 0.66] } = {}) {
  if (!Array.isArray(ratios) || ratios.length !== 2) throw new Error('ratios must be a two-element array, e.g. [0.618, 0.66]');
  const levels = ratios.map(ratio => calculateRetracementLevel({ start, end, ratio }));
  return { high: Math.max(...levels), low: Math.min(...levels) };
}

/**
 * Mechanical reaction check for a single bar against the golden-pocket zone —
 * the same close-based sweep-and-reject mechanic as detectSFP, generalized
 * from a single level to a zone:
 *   bullish (uptrend retracement, expecting support) — wicks INTO/through the
 *     zone (low <= zone.high) but CLOSES back above it (rejection off support)
 *   bearish (downtrend retracement, expecting resistance) — wicks INTO/through
 *     the zone (high >= zone.low) but CLOSES back below it (rejection off resistance)
 * Returns the stop-loss price (beyond the reaction wick — market-structure
 * based, never the fib level itself per the curriculum's explicit caution).
 */
export function detectFibReaction({ bar, zone, direction } = {}) {
  if (!zone || typeof zone.high !== 'number' || typeof zone.low !== 'number') throw new Error('zone must be an object with numeric {high, low} bounds');
  const dir = String(direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('direction must be "bullish" or "bearish"');

  if (dir === 'bullish') {
    const detected = bar.low <= zone.high && bar.close > zone.high;
    return { detected, stop: detected ? bar.low : undefined, entry: detected ? bar.close : undefined };
  }
  const detected = bar.high >= zone.low && bar.close < zone.low;
  return { detected, stop: detected ? bar.high : undefined, entry: detected ? bar.close : undefined };
}

/**
 * Full pipeline: given the most recent swing high and swing low (e.g. from
 * findSwingHighs/findSwingLows), determines the prevailing trend by which
 * swing point is more recent, anchors the Fibonacci swing on it (A = the
 * prior extreme, B = the most recent one — exactly the curriculum's "previous
 * LOW and previous HIGH" / "previous HIGH and previous LOW" framing for up-
 * and downtrends respectively), computes the golden pocket, and scans bars
 * AFTER the swing for a reaction. Hits are tagged 'first'/'retest' like
 * scanForSFP — a retest that reacts again is not a lesser read.
 */
export function scanForFibReaction(bars, { swingHigh, swingLow, ratios, skipDojis = true, dojiOptions } = {}) {
  requireBars(bars);
  if (!swingHigh || !Number.isInteger(swingHigh.index)) throw new Error('swingHigh must be a swing point object with a numeric index');
  if (!swingLow || !Number.isInteger(swingLow.index)) throw new Error('swingLow must be a swing point object with a numeric index');
  if (swingHigh.index === swingLow.index) throw new Error('swingHigh and swingLow must be distinct swing points');

  // Whichever swing point is most recent marks the extreme price is currently
  // retracing FROM — that determines the trend and the fib anchor direction.
  const uptrend = swingHigh.index > swingLow.index;
  const direction = uptrend ? 'bullish' : 'bearish';
  const start = uptrend ? swingLow.price : swingHigh.price; // point A — the prior extreme
  const end = uptrend ? swingHigh.price : swingLow.price;   // point B — the most recent extreme
  const anchorIndex = Math.max(swingHigh.index, swingLow.index);

  const zone = findGoldenPocket({ start, end, ratios });

  const hits = [];
  for (let i = anchorIndex + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (skipDojis && isDoji(bar, dojiOptions)) continue;
    const result = detectFibReaction({ bar, zone, direction });
    if (result.detected) {
      hits.push({ index: i, kind: hits.length === 0 ? 'first' : 'retest', entry: result.entry, stop: result.stop, bar });
    }
  }
  return { direction, zone, swing: { start, end }, hits };
}

/**
 * Build a trade plan from a confirmed Fibonacci-reaction hit, in the
 * {side, entry, stop, target, alternate_target, confidence} shape shared
 * with buildSFPTradePlan / buildDivergenceTradePlan / buildZoneTradePlan.
 *
 * direction "bullish" (golden-pocket support reaction) -> long;
 * "bearish" (golden-pocket resistance reaction) -> short.
 * entry: close of the reaction candle. stop: beyond that candle's wick —
 * market-structure based, NEVER the fib level ("It is not advisable to use
 * fib levels for stops" — Ch.7). target: the nearer of lastSwingLevel and/or
 * rangeLevel, the same target duality as the other three strategies (the
 * curriculum names fib extensions/negative-fibs as alternative target tools,
 * but — per this module's docblock — without a single canonical formula to
 * encode, the established target convention is the honest, deterministic fit).
 */
export function buildFibTradePlan({ hit, direction, lastSwingLevel, rangeLevel } = {}) {
  if (!hit?.entry && !hit?.detected) throw new Error('hit must be a confirmed reaction result (from detectFibReaction/scanForFibReaction)');
  const dir = String(direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('direction must be "bullish" or "bearish"');

  const side = dir === 'bullish' ? 'long' : 'short';
  const candidateTargets = [lastSwingLevel, rangeLevel].filter(t => t !== undefined && t !== null);
  if (candidateTargets.length === 0) throw new Error('at least one of lastSwingLevel or rangeLevel must be provided');

  let primary = candidateTargets[0];
  let alternate;
  for (const t of candidateTargets.slice(1)) {
    if (side === 'long' ? t < primary : t > primary) { alternate = primary; primary = t; }
    else alternate = t;
  }

  return {
    side,
    entry: hit.entry,
    stop: hit.stop,
    target: primary,
    alternate_target: alternate,
    confidence: hit.kind === 'retest' ? 'higher (retest of the golden pocket)' : 'standard (first golden-pocket reaction)',
  };
}
