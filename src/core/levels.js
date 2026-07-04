/**
 * Key Levels / Zones detection — pure functions over OHLC bar arrays.
 * Encodes the mechanical spec from the curriculum (Chapters 2, 6, 8 —
 * "Trading: Level to Level", "Levels Final", "Support and Resistance Zones"):
 *
 *   - A zone forms where price consolidates in a tight range and then breaks
 *     out of it: "A support zone is where the price breaks out of a range to
 *     the upside creating a base for the price to return to... A resistance
 *     zone is where price breaks out of a range to the downside" (Ch.8).
 *     Zone extremities = the consolidation range's high/low ("take the
 *     range of extremities... the lowest and highest wicks" — Ch.8).
 *   - Zones are classified purely by what the breakout did to the trend that
 *     was running INTO the range (Ch.8 4.1/4.2):
 *       continuation — breakout direction matches the prior trend
 *       reversal     — breakout direction opposes the prior trend
 *   - "We should be looking for support zones to BUY and resistance zones to
 *     SELL" (Ch.8) — the trade trigger is price RETURNING to (retesting) an
 *     already-confirmed zone; "if price never returns to our zone, we never
 *     jump into the trade" (Ch.8).
 *   - Recency and touch count grade conviction: "Levels with the same role on
 *     multiple touches get weaker and weaker... Weaker level = Requires more
 *     confidence to take trades" (Ch.6) — encoded as the trade plan's
 *     confidence rating (first retest = freshest = highest conviction).
 *   - Entry: close of the retest candle (close-based confirmation, matching
 *     the SFP/Divergence convention). Stop: beyond the FAR boundary of the
 *     zone — "you exit the trade when your idea for entering is invalid"
 *     (Ch.6: stop goes beyond the level whose breach disproves the read).
 *   - Target: the next opposing zone — the curriculum's "First Trouble Area"
 *     (FTA, Ch.6) — or the range extreme as a fallback, mirroring
 *     buildSFPTradePlan / buildDivergenceTradePlan's target convention.
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 */
import { findSwingHighs, findSwingLows } from './sfp.js';

function requireBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('bars must be a non-empty array of OHLC candles');
  return bars;
}

/**
 * A "tight" consolidation range: an adjacent swing-high/swing-low pair (in
 * either order) whose prices sit close enough together to read as one zone of
 * interest rather than a wide trending leg ("each level must be thought of as
 * a zone... a small zone on the weekly TF might be a large zone on the
 * 4-hour TF" — Ch.6 — hence maxRangePercent is left tunable per timeframe).
 */
export function findConsolidationRanges(bars, { swingLookback = 2, maxRangePercent = 3 } = {}) {
  requireBars(bars);
  const highs = findSwingHighs(bars, { lookback: swingLookback }).map(h => ({ ...h, kind: 'high' }));
  const lows = findSwingLows(bars, { lookback: swingLookback }).map(l => ({ ...l, kind: 'low' }));
  const points = [...highs, ...lows].sort((a, b) => a.index - b.index);

  const ranges = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.kind === b.kind) continue; // need an adjacent high/low pair to bound a range
    const high = Math.max(a.price, b.price);
    const low = Math.min(a.price, b.price);
    if (low <= 0) continue;
    const gapPercent = ((high - low) / low) * 100;
    if (gapPercent > maxRangePercent) continue; // too wide to read as one consolidation
    ranges.push({ start_index: Math.min(a.index, b.index), end_index: Math.max(a.index, b.index), high, low });
  }
  return ranges;
}

/**
 * Trend running INTO a range: compares the close at the range's start against
 * the close `trendLookback` bars earlier. Returns 'up', 'down', or null when
 * there isn't enough history or the move is flat (an unclassifiable zone is
 * skipped — the curriculum's continuation/reversal split requires a clear
 * prior trend to compare the breakout against).
 */
function priorTrend(bars, range, trendLookback) {
  const refIndex = range.start_index - trendLookback;
  if (refIndex < 0) return null;
  const before = bars[refIndex].close;
  const atStart = bars[range.start_index].close;
  if (atStart > before) return 'up';
  if (atStart < before) return 'down';
  return null;
}

/** First bar after the range whose CLOSE breaks beyond the range's bounds. */
function findBreakout(bars, range) {
  for (let i = range.end_index + 1; i < bars.length; i++) {
    if (bars[i].close > range.high) return { index: i, bar: bars[i], direction: 'up' };
    if (bars[i].close < range.low) return { index: i, bar: bars[i], direction: 'down' };
  }
  return null;
}

/**
 * Full zone-detection pipeline: finds tight consolidation ranges, confirms
 * each one's breakout (a range with no breakout yet isn't a tradeable zone),
 * and classifies it support/resistance × continuation/reversal per Ch.8's
 * mechanical definitions. Returns confirmed zones, oldest breakout first.
 */
export function detectZones(bars, { swingLookback = 2, maxRangePercent = 3, trendLookback = 5 } = {}) {
  requireBars(bars);
  const ranges = findConsolidationRanges(bars, { swingLookback, maxRangePercent });
  const zones = [];
  for (const range of ranges) {
    const breakout = findBreakout(bars, range);
    if (!breakout) continue;
    const trend = priorTrend(bars, range, trendLookback);
    if (!trend) continue;

    // "Support zone... breaks out... to the upside"; "Resistance zone...
    // breaks out... to the downside" (Ch.8) — the type is decided purely by
    // breakout direction, irrespective of the prior trend.
    const type = breakout.direction === 'up' ? 'support' : 'resistance';
    const matchesTrend = (breakout.direction === 'up' && trend === 'up') || (breakout.direction === 'down' && trend === 'down');
    const classification = matchesTrend ? 'continuation' : 'reversal';

    zones.push({
      type,
      classification,
      high: range.high,
      low: range.low,
      range_start_index: range.start_index,
      range_end_index: range.end_index,
      breakout_index: breakout.index,
      breakout_bar: breakout.bar,
    });
  }
  return zones.sort((a, b) => a.breakout_index - b.breakout_index);
}

/**
 * Scan for bars (after a zone's breakout) whose range overlaps the zone —
 * i.e. price RETURNING to retest it, the curriculum's actual trade trigger
 * ("we should be looking for support zones to buy and resistance zones to
 * sell"; "if price never returns... we never jump into the trade"). Hits are
 * tagged 'first'/'retest' like scanForSFP — later touches aren't discarded,
 * but they do carry less conviction (see buildZoneTradePlan).
 */
export function findZoneRetests(bars, zone) {
  requireBars(bars);
  if (!zone || typeof zone.high !== 'number' || typeof zone.low !== 'number' || !Number.isInteger(zone.breakout_index)) {
    throw new Error('zone must be a detected zone object (from detectZones) with high/low/breakout_index');
  }
  const hits = [];
  for (let i = zone.breakout_index + 1; i < bars.length; i++) {
    const bar = bars[i];
    const overlaps = bar.low <= zone.high && bar.high >= zone.low;
    if (!overlaps) continue;
    // Close-based confirmation: resistance must close ≤ zone.high (rejected at
    // ceiling); support must close ≥ zone.low (held at floor). A close beyond
    // the zone boundary means price broke through, not retested — same
    // close-based principle as SFP and Fibonacci.
    const confirmsDirection = zone.type === 'resistance'
      ? bar.close <= zone.high
      : bar.close >= zone.low;
    if (confirmsDirection) hits.push({ index: i, kind: hits.length === 0 ? 'first' : 'retest', bar });
  }
  return hits;
}

/**
 * Build a trade plan from a confirmed zone retest, in the {side, entry, stop,
 * target, alternate_target, confidence} shape shared with
 * buildSFPTradePlan / buildDivergenceTradePlan.
 *
 * support zone retest -> long ("buy support zones"); resistance zone retest
 * -> short ("sell resistance zones") — Ch.8's core directive.
 * entry: close of the retest candle (close-based confirmation, matching the
 * SFP/Divergence convention). stop: the zone's FAR boundary — crossing all
 * the way through the zone invalidates the "base"/"ceiling" premise the
 * trade depends on (Ch.6: "you exit the trade when your idea... is invalid").
 * target: the nearer of oppositeZoneLevel (the curriculum's "First Trouble
 * Area") and/or rangeLevel — same target duality as the other two strategies.
 */
export function buildZoneTradePlan({ zone, hit, oppositeZoneLevel, rangeLevel } = {}) {
  if (!zone || !['support', 'resistance'].includes(zone.type)) throw new Error('zone must be a detected zone with type "support" or "resistance"');
  if (!hit?.bar) throw new Error('hit must be a confirmed retest hit (from findZoneRetests)');

  const side = zone.type === 'support' ? 'long' : 'short';
  const entry = hit.bar.close;
  const stop = side === 'long' ? zone.low : zone.high;

  const candidateTargets = [oppositeZoneLevel, rangeLevel].filter(t => t !== undefined && t !== null);
  if (candidateTargets.length === 0) throw new Error('at least one of oppositeZoneLevel or rangeLevel must be provided');
  let primary = candidateTargets[0];
  let alternate;
  for (const t of candidateTargets.slice(1)) {
    if (side === 'long' ? t < primary : t > primary) { alternate = primary; primary = t; }
    else alternate = t;
  }

  // "Levels with the same role on multiple touches get weaker and weaker...
  // Weaker level = Requires more confidence to take trades" (Ch.6) — a fresh
  // zone's first retest is the cleanest read; repeat touches dilute it.
  const confidence = hit.kind === 'first'
    ? `fresh zone — first retest of the ${zone.classification} ${zone.type} zone (highest conviction)`
    : `repeat touch — ${zone.type} zone has been retested before and is weakening (demands more confluence)`;

  return { side, entry, stop, target: primary, alternate_target: alternate, confidence, zone_type: zone.type, zone_classification: zone.classification };
}
