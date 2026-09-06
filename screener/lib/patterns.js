/**
 * Heuristic bullish chart-pattern detectors over zigzag pivots + raw bars.
 * These are geometric approximations with tolerance bands, NOT guaranteed
 * pattern recognition — every match reports which textbook rule it satisfied
 * so a human can sanity-check it before acting.
 *
 * Each detector requires the textbook volume signature for its pattern (not
 * just the price shape) — a breakout with no volume confirmation is a much
 * weaker signal and is deliberately excluded.
 */
import { avgVolume } from './zigzag.js';

const near = (a, b, tolPct) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tolPct;

// A breakout above some historical level is only a live, actionable signal if
// it just happened. Over a 500-bar (~2yr) lookback, price will have crossed
// above almost any old resistance/neckline eventually — checking only
// "is price above it now" without a recency bound turns any long-surpassed
// level into a false "breakout today", with stale measured-move targets that
// can sit BELOW the current price. Require the actual crossing to have
// happened within the last `maxAgeBars`.
const MAX_PATTERN_BREAKOUT_AGE_BARS = 20;
function brokeOutRecently(bars, level, maxAgeBars = MAX_PATTERN_BREAKOUT_AGE_BARS) {
  const last = bars[bars.length - 1];
  if (last.close <= level) return false;
  const windowStart = Math.max(0, bars.length - 1 - maxAgeBars);
  for (let i = bars.length - 1; i >= windowStart; i--) {
    if (bars[i].close <= level) return true; // found the crossing inside the recent window
  }
  return false; // price has been above `level` for the entire recent window — stale breakout
}

/** Double bottom: low - high(neckline) - low(similar), breakout above neckline on volume. */
export function detectDoubleBottom(bars, pivots) {
  const lows = pivots.filter(p => p.type === 'low');
  const highs = pivots.filter(p => p.type === 'high');
  if (lows.length < 2 || highs.length < 1) return null;

  const breakoutBar = bars[bars.length - 1];
  if (!(breakoutBar.close > breakoutBar.open)) return null; // breakout day itself must close green
  const avgVol = avgVolume(bars.slice(0, -1), 20);

  // Search every adjacent pair, most recent first — not just the last two —
  // so a stray minor pivot between two genuine bottoms doesn't hide the pattern.
  for (let i = lows.length - 1; i >= 1; i--) {
    const l1 = lows[i], l2 = lows[i - 1];
    if (!near(l1.price, l2.price, 0.04)) continue;

    const neckline = highs.find(h => h.index > l2.index && h.index < l1.index);
    if (!neckline) continue;
    if (neckline.price - Math.max(l1.price, l2.price) < 0.03 * neckline.price) continue;
    if (!brokeOutRecently(bars, neckline.price)) continue;
    if (avgVol > 0 && breakoutBar.volume < avgVol * 1.2) continue; // breakout needs volume confirmation

    const depth = neckline.price - (l1.price + l2.price) / 2;
    return {
      matched: true,
      pattern: 'double_bottom',
      neckline: Math.round(neckline.price * 1e6) / 1e6,
      bottom_avg: Math.round(((l1.price + l2.price) / 2) * 1e6) / 1e6,
      measured_move_target: Math.round((neckline.price + depth) * 1e6) / 1e6,
      invalidation_level: Math.min(l1.price, l2.price),
      breakout_volume_ratio: avgVol > 0 ? Math.round((breakoutBar.volume / avgVol) * 100) / 100 : null,
    };
  }
  return null;
}

/** Inverted head & shoulders: low(shoulder) - high - low(head, lowest) - high - low(shoulder), breakout on volume. */
export function detectInverseHeadAndShoulders(bars, pivots) {
  const lows = pivots.filter(p => p.type === 'low');
  const highs = pivots.filter(p => p.type === 'high');
  if (lows.length < 3 || highs.length < 2) return null;

  const breakoutBar = bars[bars.length - 1];
  if (!(breakoutBar.close > breakoutBar.open)) return null; // breakout day itself must close green
  const avgVol = avgVolume(bars.slice(0, -1), 20);

  // Search every consecutive triple of lows, most recent first.
  for (let i = lows.length - 1; i >= 2; i--) {
    const rShoulder = lows[i], head = lows[i - 1], lShoulder = lows[i - 2];
    if (!(head.price < lShoulder.price && head.price < rShoulder.price)) continue;
    if (!near(lShoulder.price, rShoulder.price, 0.06)) continue;

    const neck1 = highs.find(h => h.index > lShoulder.index && h.index < head.index);
    const neck2 = highs.find(h => h.index > head.index && h.index < rShoulder.index);
    if (!neck1 || !neck2) continue;

    const neckline = (neck1.price + neck2.price) / 2;
    if (!brokeOutRecently(bars, neckline)) continue;
    if (avgVol > 0 && breakoutBar.volume < avgVol * 1.2) continue;

    const depth = neckline - head.price;
    return {
      matched: true,
      pattern: 'inverse_head_and_shoulders',
      neckline: Math.round(neckline * 1e6) / 1e6,
      head_low: head.price,
      measured_move_target: Math.round((neckline + depth) * 1e6) / 1e6,
      invalidation_level: head.price,
      breakout_volume_ratio: avgVol > 0 ? Math.round((breakoutBar.volume / avgVol) * 100) / 100 : null,
    };
  }
  return null;
}

/**
 * Cup and handle: a ROUNDED decline+recovery back near the prior high (cup —
 * not a sharp V, real cups spend time near the bottom), then a shallow
 * pullback (handle), then a volume-confirmed breakout.
 */
export function detectCupAndHandle(bars, pivots) {
  if (bars.length < 40) return null;
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');
  if (highs.length < 2 || lows.length < 1) return null;

  const rimRight = highs[highs.length - 1];
  const cupLow = [...lows].reverse().find(l => l.index < rimRight.index);
  if (!cupLow) return null;
  const rimLeft = [...highs].reverse().find(h => h.index < cupLow.index);
  if (!rimLeft) return null;

  if (!near(rimLeft.price, rimRight.price, 0.08)) return null; // rims roughly level
  const cupDepth = ((rimLeft.price + rimRight.price) / 2) - cupLow.price;
  if (cupDepth < 0.12 * rimRight.price) return null; // cup should be a meaningful pullback, not noise

  // Roundedness: a true cup lingers near its low across several bars. A sharp
  // single-bar V-spike and immediate recovery is a different pattern (a V
  // bottom / double bottom), not a cup and handle.
  const cupSpan = bars.slice(rimLeft.index, rimRight.index + 1);
  const nearBottomBand = cupLow.price * 1.08;
  const barsNearBottom = cupSpan.filter(b => b.low <= nearBottomBand).length;
  if (barsNearBottom < Math.max(3, Math.round(cupSpan.length * 0.1))) return null;

  // Handle: a shallow pullback after the right rim, retracing well under the
  // cup's full depth, and short in duration — handles run days-to-weeks, not
  // months. An uncapped "all bars since the rim" window let a rim from ages
  // ago pass as a "handle" spanning most of the lookback.
  const afterRim = bars.slice(rimRight.index + 1);
  if (afterRim.length < 3 || afterRim.length > 40) return null;
  const handleLow = Math.min(...afterRim.map(b => b.low));
  const handleRetrace = (rimRight.price - handleLow) / cupDepth;
  if (handleRetrace > 0.5) return null; // handle deeper than half the cup — not a handle anymore

  const breakoutLevel = Math.max(rimLeft.price, rimRight.price);
  if (!brokeOutRecently(bars, breakoutLevel)) return null;

  // Volume should generally dry up through the cup and pick back up on breakout.
  const breakoutBar = bars[bars.length - 1];
  if (!(breakoutBar.close > breakoutBar.open)) return null; // breakout day itself must close green
  const cupAvgVol = avgVolume(cupSpan, cupSpan.length);
  if (cupAvgVol > 0 && breakoutBar.volume < cupAvgVol * 1.2) return null;

  return {
    matched: true,
    pattern: 'cup_and_handle',
    rim_level: Math.round(breakoutLevel * 1e6) / 1e6,
    cup_depth: Math.round(cupDepth * 1e6) / 1e6,
    measured_move_target: Math.round((breakoutLevel + cupDepth) * 1e6) / 1e6,
    invalidation_level: Math.round(handleLow * 1e6) / 1e6,
    breakout_volume_ratio: cupAvgVol > 0 ? Math.round((breakoutBar.volume / cupAvgVol) * 100) / 100 : null,
  };
}

/**
 * Bullish flag/pennant: sharp impulsive rally (flagpole), a tight
 * consolidation on CONTRACTING volume (the defining characteristic — without
 * it this is just a random sideways chop, not a flag/pennant), then a
 * volume-confirmed breakout that resumes the trend.
 */
export function detectBullishFlagOrPennant(bars, pivots) {
  if (bars.length < 20) return null;
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');
  if (highs.length < 1 || lows.length < 1) return null;

  const poleTop = highs[highs.length - 1];
  const poleBase = [...lows].reverse().find(l => l.index < poleTop.index);
  if (!poleBase) return null;

  const poleHeight = poleTop.price - poleBase.price;
  const poleBars = poleTop.index - poleBase.index;
  if (poleHeight <= 0 || poleBars <= 0 || poleBars > 15) return null; // pole must be a sharp, short move
  const poleMovePct = poleHeight / poleBase.price;
  if (poleMovePct < 0.08) return null; // needs to be a real impulsive rally

  const consolidation = bars.slice(poleTop.index + 1);
  if (consolidation.length < 3 || consolidation.length > 25) return null;

  const conHigh = Math.max(...consolidation.map(b => b.high));
  const conLow = Math.min(...consolidation.map(b => b.low));
  const conRange = conHigh - conLow;
  if (conRange > poleHeight * 0.6) return null; // consolidation should be much tighter than the pole
  if (conHigh > poleTop.price * 1.02) return null; // shouldn't make a big new high mid-consolidation

  const poleVol = avgVolume(bars.slice(poleBase.index, poleTop.index + 1), poleBars || 1);
  const conVol = avgVolume(consolidation.slice(0, -1), consolidation.length - 1 || 1);
  if (!(conVol < poleVol)) return null; // volume MUST contract during consolidation — the pattern's defining trait

  const lastClose = bars[bars.length - 1].close;
  const breakoutBar = bars[bars.length - 1];
  if (!(breakoutBar.close > breakoutBar.open)) return null; // breakout day itself must close green
  const breakout = lastClose > conHigh;
  if (!breakout) return null;
  if (breakoutBar.volume < conVol * 1.2) return null; // and pick back up on the breakout itself

  // Contracting range (pennant) vs roughly parallel channel (flag) — first half vs second half range.
  const half = Math.floor(consolidation.length / 2) || 1;
  const firstRange = Math.max(...consolidation.slice(0, half).map(b => b.high)) - Math.min(...consolidation.slice(0, half).map(b => b.low));
  const secondRange = Math.max(...consolidation.slice(half).map(b => b.high)) - Math.min(...consolidation.slice(half).map(b => b.low));
  const isPennant = secondRange < firstRange * 0.7;

  return {
    matched: true,
    pattern: isPennant ? 'bullish_pennant' : 'bullish_flag',
    flagpole_height: Math.round(poleHeight * 1e6) / 1e6,
    breakout_level: Math.round(conHigh * 1e6) / 1e6,
    measured_move_target: Math.round((conHigh + poleHeight) * 1e6) / 1e6,
    invalidation_level: Math.round(conLow * 1e6) / 1e6,
    breakout_volume_ratio: conVol > 0 ? Math.round((breakoutBar.volume / conVol) * 100) / 100 : null,
  };
}

export function detectAllPatterns(bars, pivots) {
  const detectors = [detectDoubleBottom, detectInverseHeadAndShoulders, detectCupAndHandle, detectBullishFlagOrPennant];
  const matches = [];
  for (const fn of detectors) {
    try {
      const result = fn(bars, pivots);
      if (result) matches.push(result);
    } catch { /* pattern didn't apply to this bar set — skip */ }
  }
  return matches;
}
