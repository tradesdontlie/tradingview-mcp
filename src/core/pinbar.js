/**
 * Pinbar Reversal Bias detection — pure functions over OHLC bar arrays.
 * Encodes Chapter 3 ("HTF Bias and LTF Execution"), Type 1 (Pinbar/Reversal
 * candles) — the one reversal-bias pattern in that chapter with a complete,
 * self-contained mechanical spec end to end:
 *
 *   - Context (criterion #1): "It should be at the end of a trend or a swing
 *     ... this ensures that our thesis of over-excited sellers or late
 *     shorters get punished during the formation of a bullish pinbar [and
 *     vice versa]." Encoded as: the pinbar candle IS the confirmed swing
 *     extreme — a bullish pinbar at the most recent swing low, a bearish one
 *     at the most recent swing high.
 *   - Shape (criterion #2): "a genuine bullish pin bar has a noticeably long
 *     wick compared to surrounding bars... and should have minimal or no
 *     upper wick" (bearish mirrors this). The curriculum gives no numeric
 *     spec, so — exactly like isDoji's documented body/range threshold —
 *     this is encoded as configurable wick/body and wick/range ratios with
 *     conservative defaults grounded in "focus on the wick formation, not
 *     the body."
 *   - Entry (Ch.3 step 3): "The best entry for a pinbar is the retest of the
 *     low of the candle before the pinbar" (bullish; mirror for bearish) —
 *     confirmed the same CLOSE-based way every reaction in this codebase is
 *     confirmed (wicks to the level, closes back beyond it — never a wick
 *     alone), generalizing the SFP/Fibonacci sweep-and-reject mechanic to
 *     this single reference level.
 *   - Stop (Ch.3 step 3, precisely quoted): "stop is to be placed below the
 *     low of the pinbar and used on a closing basis" (bearish: above the high).
 *   - Target: "Once all the levels are identified, our bias is clear, it
 *     becomes a level to level trade" — the same nearer-of-lastSwing/range
 *     duality every other strategy here uses.
 *   - "Trading reversals inherently has some risk... always be looking for
 *     confluence" — one independently-coded signal among several, never
 *     acted on alone.
 *
 * Deliberately NOT encoded: the chapter's other bias pattern, the Engulfing
 * Candle. Its entry ("we wait for a break above this level and a retest")
 * depends on an externally-identified HTF level the curriculum gives no
 * mechanical rule for locating — encoding a guess at which level would be
 * live judgment wearing code's clothing, the same reasoning that kept
 * Fibonacci scoped to the golden pocket alone.
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 * Swing points are {index, price} objects (e.g. from findSwingHighs/Lows).
 */
import { isDoji } from './sfp.js';

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

/**
 * Mechanical pinbar test: the dominant wick (lower for bullish, upper for
 * bearish) must clearly dominate both the body and the candle's full range,
 * while the opposite wick stays minimal — "noticeably long wick... minimal
 * or no [opposite] wick". Ratios are deliberately conservative defaults
 * (configurable, like isDoji's maxBodyToRangeRatio) since the curriculum
 * describes the shape qualitatively, not numerically.
 */
export function detectPinbar(bar, {
  direction,
  minDominantWickToBodyRatio = 2,
  minDominantWickToRangeRatio = 0.5,
  maxOppositeWickToRangeRatio = 0.15,
} = {}) {
  if (!bar || typeof bar.high !== 'number') throw new Error('bar must be an OHLC candle object');
  const dir = String(direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('direction must be "bullish" or "bearish"');

  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const [dominantWick, oppositeWick] = dir === 'bullish' ? [lowerWick, upperWick] : [upperWick, lowerWick];

  const detected = range > 0
    && dominantWick >= minDominantWickToBodyRatio * body
    && dominantWick >= minDominantWickToRangeRatio * range
    && oppositeWick <= maxOppositeWickToRangeRatio * range;

  return { detected, direction: dir, body, dominantWick, oppositeWick, range };
}

/**
 * Shared close-based retest primitive — "the best entry... is the retest of
 * the low of the candle before the pinbar": price wicks to/through the
 * reference level but CLOSES back beyond it in the bias direction, the same
 * sweep-and-reject confirmation mechanic as detectSFP/detectFibReaction,
 * generalized from a swing/zone to this single reference level.
 */
export function detectLevelRetest(bar, { level, direction }) {
  if (!bar || typeof bar.close !== 'number') throw new Error('bar must be an OHLC candle object');
  const lvl = Number(level);
  if (!Number.isFinite(lvl)) throw new Error(`level must be a finite number, got: ${level}`);
  const dir = String(direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('direction must be "bullish" or "bearish"');

  const detected = dir === 'bullish'
    ? (bar.low <= lvl && bar.close > lvl)
    : (bar.high >= lvl && bar.close < lvl);

  return { detected, entry: detected ? bar.close : null };
}

/**
 * Full pipeline: finds a pinbar forming AT the most recent swing extreme in
 * each direction (criterion #1 — "the end of a trend or a swing"; a bullish
 * pinbar must BE the latest confirmed swing low, a bearish one the latest
 * swing high), then scans forward for the close-based retest of its
 * reference level — the low/high of the candle immediately preceding it
 * ("price always has a tendency to reach back to it during reversals").
 * Returns ready-to-trade hits, mirroring scanForFibReaction's shape.
 */
export function scanForPinbarSetup(bars, { swingHighs, swingLows, skipDojis = true, pinbarOptions } = {}) {
  requireBars(bars);
  requireSwingPointArray(swingHighs, 'swingHighs');
  requireSwingPointArray(swingLows, 'swingLows');

  const candidates = [
    ...swingLows.slice(-1).map(p => ({ swingPoint: p, direction: 'bullish' })),
    ...swingHighs.slice(-1).map(p => ({ swingPoint: p, direction: 'bearish' })),
  ];

  const hits = [];
  for (const { swingPoint, direction } of candidates) {
    const index = swingPoint.index;
    if (index <= 0 || index >= bars.length) continue; // need a "candle before" for the reference level
    const bar = bars[index];
    if (skipDojis && isDoji(bar)) continue;
    const pin = detectPinbar(bar, { direction, ...pinbarOptions });
    if (!pin.detected) continue;

    const priorBar = bars[index - 1];
    const level = direction === 'bullish' ? priorBar.low : priorBar.high;
    const stop = direction === 'bullish' ? bar.low : bar.high;

    for (let i = index + 1; i < bars.length; i++) {
      const retestBar = bars[i];
      if (skipDojis && isDoji(retestBar)) continue;
      const retest = detectLevelRetest(retestBar, { level, direction });
      if (retest.detected) {
        hits.push({ index: i, bar: retestBar, direction, level, entry: retest.entry, stop, biasIndex: index, biasBar: bar });
        break; // one confirmed retest entry per bias candle
      }
    }
  }
  return { hits };
}

/**
 * Build a trade plan from a confirmed pinbar retest setup (from
 * scanForPinbarSetup), in the exact shape consumed by risk.evaluateTradeSetup
 * — identically to every other strategy's buildXTradePlan. Bullish pinbar at
 * a swing low -> long; bearish at a swing high -> short. entry = close of the
 * retest candle; stop = beyond the pinbar's defining wick on a closing basis
 * ("stop is to be placed below the low of the pinbar"); target = the nearer
 * of lastSwingLevel/rangeLevel — "it becomes a level to level trade".
 */
export function buildPinbarTradePlan({ hit, lastSwingLevel, rangeLevel } = {}) {
  if (!hit?.bar || typeof hit.entry !== 'number') throw new Error('hit must be a confirmed pinbar retest setup (from scanForPinbarSetup)');
  const dir = String(hit.direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('hit.direction must be "bullish" or "bearish"');

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
    confidence: 'reversal pattern — "trading reversals inherently has some risk", treat as bias context and demand confluence',
  };
}
