/**
 * Swing Failure Pattern (SFP) detection — pure functions over OHLC bar arrays.
 * Encodes the mechanical spec from the curriculum (cross-validated identically
 * across three independent chapters: conceptual intro, full operationalization,
 * and a dedicated SFP chapter — the most internally-validated single technique
 * in the material):
 *
 *   - A "key" high/low is a swing point marking a trend-reversal/range-start,
 *     not just any minor wiggle.
 *   - SFP = a candle wicks beyond that level but CLOSES back on the origin
 *     side (close-based confirmation — the standard that recurs everywhere
 *     in this curriculum).
 *   - Entry: on the close of the sweep candle. Stop: beyond the sweep candle's
 *     wick. Target: last swing high/low, or the range high/low.
 *   - A subsequent re-test of the same level that also sweeps-and-rejects is a
 *     valid, HIGHER-conviction "second entry" — not a lesser consolation entry.
 *   - Filter out dojis (market indecision undermines the read).
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 */

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
 * A bar is a "key" swing high if its high is the highest within a symmetric
 * lookback window — i.e. a local extreme marking where a trend could reverse
 * or a range could begin (curriculum's "key high/low" definition).
 */
export function findSwingHighs(bars, { lookback = 2 } = {}) {
  requireBars(bars);
  const n = Number.isInteger(lookback) && lookback > 0 ? lookback : (() => { throw new Error('lookback must be a positive integer'); })();
  const swings = [];
  for (let i = n; i < bars.length - n; i++) {
    const window = bars.slice(i - n, i + n + 1);
    const isHighest = window.every(b => bars[i].high >= b.high);
    if (isHighest && window.filter(b => b.high === bars[i].high).length === 1) {
      swings.push({ index: i, price: bars[i].high });
    }
  }
  return swings;
}

export function findSwingLows(bars, { lookback = 2 } = {}) {
  requireBars(bars);
  const n = Number.isInteger(lookback) && lookback > 0 ? lookback : (() => { throw new Error('lookback must be a positive integer'); })();
  const swings = [];
  for (let i = n; i < bars.length - n; i++) {
    const window = bars.slice(i - n, i + n + 1);
    const isLowest = window.every(b => bars[i].low <= b.low);
    if (isLowest && window.filter(b => b.low === bars[i].low).length === 1) {
      swings.push({ index: i, price: bars[i].low });
    }
  }
  return swings;
}

/**
 * Doji filter: the candle's body is small relative to its full range, signaling
 * indecision. The curriculum advises steering clear of SFP sweep candles that
 * print as dojis.
 */
export function isDoji(bar, { maxBodyToRangeRatio = 0.1 } = {}) {
  const range = bar.high - bar.low;
  if (range <= 0) return true;
  const body = Math.abs(bar.close - bar.open);
  return (body / range) <= maxBodyToRangeRatio;
}

/**
 * Mechanical SFP check for a single bar against a key level:
 *   bearish — wicks ABOVE the level (high > level) but CLOSES back below it
 *   bullish — wicks BELOW the level (low < level) but CLOSES back above it
 * Returns the stop-loss price (beyond the sweep wick) when detected.
 */
export function detectSFP({ bar, level, type } = {}) {
  const lvl = requirePositiveFinite(level, 'level');
  const typeLower = String(type).toLowerCase();
  if (!['bullish', 'bearish'].includes(typeLower)) throw new Error('type must be "bullish" or "bearish"');

  if (typeLower === 'bearish') {
    const detected = bar.high > lvl && bar.close < lvl;
    return { detected, stop: detected ? bar.high : undefined, entry: detected ? bar.close : undefined };
  }
  const detected = bar.low < lvl && bar.close > lvl;
  return { detected, stop: detected ? bar.low : undefined, entry: detected ? bar.close : undefined };
}

/**
 * Scan a bar series (occurring AFTER the key level was established) for SFP
 * occurrences at that level. Each hit is tagged "first" or "retest" — a retest
 * that also sweeps-and-rejects is HIGHER conviction per the curriculum, not a
 * lesser consolation entry, so callers should not discount later hits.
 * Dojis are skipped by default (checklist filter — set skipDojis:false to disable).
 */
export function scanForSFP(bars, { level, type, skipDojis = true, dojiOptions } = {}) {
  requireBars(bars);
  const hits = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (skipDojis && isDoji(bar, dojiOptions)) continue;
    const result = detectSFP({ bar, level, type });
    if (result.detected) {
      hits.push({
        index: i,
        kind: hits.length === 0 ? 'first' : 'retest',
        entry: result.entry,
        stop: result.stop,
        bar,
      });
    }
  }
  return hits;
}

/**
 * Build a trade plan from a confirmed SFP hit, in the {entry, stop, target,
 * side} shape that core/risk.evaluateTradeSetup() consumes directly — closing
 * the loop between setup-detection and the deterministic risk gate.
 *
 * type "bearish" SFP -> short trade; type "bullish" SFP -> long trade
 * (an SFP signals failure to continue the existing trend, i.e. a reversal).
 * target: pass lastSwingLevel and/or rangeLevel — the curriculum names both
 * as valid target options; the nearer one (in the trade's favorable direction)
 * is returned as the primary target, the other as an alternate.
 */
export function buildSFPTradePlan({ hit, type, lastSwingLevel, rangeLevel } = {}) {
  if (!hit?.detected && !hit?.entry) throw new Error('hit must be a detected SFP result (from detectSFP/scanForSFP)');
  const typeLower = String(type).toLowerCase();
  if (!['bullish', 'bearish'].includes(typeLower)) throw new Error('type must be "bullish" or "bearish"');

  const side = typeLower === 'bearish' ? 'short' : 'long';
  const candidateTargets = [lastSwingLevel, rangeLevel].filter(t => t !== undefined && t !== null);
  if (candidateTargets.length === 0) throw new Error('at least one of lastSwingLevel or rangeLevel must be provided');

  // Primary target = the nearer one in the trade's favorable direction (the more
  // conservative first target, per the curriculum's "scale out, take the closer
  // area first" guidance); the other becomes the alternate/extended target.
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
    confidence: hit.kind === 'retest' ? 'higher (retest/second entry)' : 'standard (first entry)',
  };
}
