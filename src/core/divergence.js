/**
 * RSI Divergence detection — pure functions over OHLC bar arrays.
 * Encodes the mechanical spec from the curriculum (Chapters 10-11, the
 * "Divergence Master-Class"):
 *
 *   - Convergence = price and oscillator move the same way (e.g. both make a
 *     higher high). Divergence = they don't — a sign the move's momentum
 *     doesn't agree with its price action, often preceding a reversal.
 *   - Compare CLOSE-based price swings against RSI swings — RSI is itself
 *     derived from closes, so pairing it with wick-based price extremes would
 *     be apples-to-oranges (curriculum: "Only the closing value is chosen...
 *     since the source for RSI is the closing value" / "look at the body of
 *     the candle, not the wicks").
 *   - Bullish divergence -> compare LOWS only. Bearish divergence -> compare
 *     HIGHS only (curriculum is explicit and repeated on this point).
 *   - Each side has four mechanical patterns, ranked by conviction:
 *       strong : price extreme breaks one way, RSI breaks the OPPOSITE way
 *       medium : price double-tops/bottoms (equal extreme), RSI breaks away
 *       weak   : price breaks one way, RSI double-tops/bottoms (equal extreme)
 *       hidden : price breaks the trend-continuation way, RSI breaks the
 *                opposite way — a continuation signal, not a reversal one;
 *                the curriculum is explicit: "Hidden ... (I don't trade it)"
 *   - Don't look for divergence in a non-trending market — there must be
 *     clear new price levels (this is enforced by requiring two distinct
 *     swing points to compare).
 *   - A minimum 4-hour timeframe is preferred (curriculum guidance).
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
 * Wilder's RSI over closing prices — the standard formulation (and the one
 * the curriculum assumes: "the source for RSI is the closing value").
 * Returns one entry per bar; the first `period` entries are `null` (not yet
 * computable — Wilder smoothing needs a `period`-bar seed average).
 */
export function calculateRSI(bars, { period = 14 } = {}) {
  requireBars(bars);
  if (!Number.isInteger(period) || period <= 0) throw new Error('period must be a positive integer');
  if (bars.length <= period) return bars.map(() => null);

  const values = new Array(bars.length).fill(null);
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) gainSum += change; else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  values[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    values[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return values;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Cumulative Volume Delta over a trailing rolling window — the oscillator
 * side of a CVD divergence comparison (Chapter 18, "Master-Class on
 * Cumulative Volume Delta"):
 *
 *   - Delta = aggressive buy volume - aggressive sell volume for a bar.
 *     Binance klines report `taker_buy_volume` (the aggressive-buy share of
 *     `volume`); aggressive-sell volume is the remainder, so
 *     delta = takerBuy - (volume - takerBuy) = 2*takerBuy - volume.
 *   - CVD "Plots this Delta in a cumulative manner" (Ch.18). A true
 *     since-inception cumulative is unbounded and would make classifyStep's
 *     percent-tolerance comparison meaningless over a long history (a tiny
 *     recent wobble could never register as "higher"/"lower" against a huge
 *     accumulated total). Instead CVD here is the sum of `delta` over a
 *     trailing `window` of bars — bounded, comparable bar-to-bar, and still
 *     exactly "cumulative delta" within the window the divergence is being
 *     read over.
 *   - Mirrors calculateRSI's warm-up convention: the first `window - 1`
 *     entries are `null` (not enough bars yet for a full window).
 *
 * Bars must include `volume` and `taker_buy_volume` (both present on
 * getKlines() output).
 */
export function calculateCVD(bars, { window = 14 } = {}) {
  requireBars(bars);
  if (!Number.isInteger(window) || window <= 0) throw new Error('window must be a positive integer');

  const deltas = bars.map(b => 2 * Number(b.taker_buy_volume) - Number(b.volume));
  const values = new Array(bars.length).fill(null);
  for (let i = window - 1; i < bars.length; i++) {
    let sum = 0;
    let valid = true;
    for (let j = i - window + 1; j <= i; j++) {
      if (!Number.isFinite(deltas[j])) { valid = false; break; }
      sum += deltas[j];
    }
    values[i] = valid ? sum : null;
  }
  return values;
}

/**
 * Local-extreme finder over a plain numeric series (shared by close-based
 * price swings and RSI swings — both are just "find the pivot" over a series
 * of numbers, the only difference is which series and which direction).
 * `null`/`undefined` entries (RSI warm-up) are treated as not-comparable and
 * can never be picked as a pivot.
 */
function findSeriesSwings(series, { lookback = 2, mode } = {}) {
  if (!Number.isInteger(lookback) || lookback <= 0) throw new Error('lookback must be a positive integer');
  if (!['high', 'low'].includes(mode)) throw new Error('mode must be "high" or "low"');
  const swings = [];
  for (let i = lookback; i < series.length - lookback; i++) {
    const v = series[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const window = series.slice(i - lookback, i + lookback + 1);
    if (window.some(w => w === null || w === undefined || !Number.isFinite(w))) continue;
    const isExtreme = mode === 'high' ? window.every(w => v >= w) : window.every(w => v <= w);
    const tieCount = window.filter(w => w === v).length;
    if (isExtreme && tieCount === 1) swings.push({ index: i, value: v });
  }
  return swings;
}

/**
 * Swing highs/lows of the CLOSE series — the price side of a divergence
 * comparison. Each swing carries its source `bar` so buildDivergenceTradePlan
 * can place entry/stop relative to the actual candle, not just its close.
 */
export function findCloseSwingHighs(bars, { lookback = 2 } = {}) {
  requireBars(bars);
  return findSeriesSwings(bars.map(b => b.close), { lookback, mode: 'high' })
    .map(s => ({ ...s, bar: bars[s.index] }));
}
export function findCloseSwingLows(bars, { lookback = 2 } = {}) {
  requireBars(bars);
  return findSeriesSwings(bars.map(b => b.close), { lookback, mode: 'low' })
    .map(s => ({ ...s, bar: bars[s.index] }));
}

/** Swing highs/lows of an RSI series (e.g. from calculateRSI) — the oscillator side. */
export function findRSISwingHighs(rsiValues, { lookback = 2 } = {}) {
  return findSeriesSwings(rsiValues, { lookback, mode: 'high' });
}
export function findRSISwingLows(rsiValues, { lookback = 2 } = {}) {
  return findSeriesSwings(rsiValues, { lookback, mode: 'low' });
}

/**
 * Classify the relationship between two consecutive same-side extremes
 * (older -> newer) as "higher", "lower", or "equal" (within tolerance —
 * real charts rarely print exact double tops/bottoms to the tick).
 */
function classifyStep(older, newer, tolerancePercent) {
  const tolerance = Math.abs(older) * (tolerancePercent / 100);
  if (Math.abs(newer - older) <= tolerance) return 'equal';
  return newer > older ? 'higher' : 'lower';
}

/**
 * Pair the two most recent same-side price-close swings with the RSI values
 * AT THOSE SAME BAR INDICES (the standard, mechanical way to read divergence —
 * it sidesteps the ambiguity of independently-detected RSI pivots landing on
 * different bars than the price pivots they're meant to be compared against),
 * and classify the pairing per the curriculum's four-pattern taxonomy.
 *
 * direction: "bullish" -> compare LOWS; "bearish" -> compare HIGHS (curriculum
 * is explicit that each side ONLY looks at its corresponding extreme).
 */
export function classifyDivergence({ priceSwings, rsiValues, direction, tolerancePercent = 0.05 } = {}) {
  const dir = String(direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('direction must be "bullish" or "bearish"');
  if (!Array.isArray(priceSwings) || priceSwings.length < 2) {
    return { divergence: false, reason: 'fewer than two price-close swing points to compare — need clear new levels first' };
  }
  const older = priceSwings[priceSwings.length - 2];
  const newer = priceSwings[priceSwings.length - 1];
  const rsiOlder = rsiValues[older.index];
  const rsiNewer = rsiValues[newer.index];
  if (rsiOlder === null || rsiOlder === undefined || rsiNewer === null || rsiNewer === undefined) {
    return { divergence: false, reason: 'RSI not yet computable at one of the swing points (warm-up period)' };
  }

  const priceStep = classifyStep(older.value, newer.value, tolerancePercent);
  const rsiStep = classifyStep(rsiOlder, rsiNewer, tolerancePercent);

  // Each side's taxonomy is the mirror image of the other — "the extreme that
  // signals continuation of the prevailing trend" (lower-low for a downtrend's
  // lows, higher-high for an uptrend's highs) vs "the opposite extreme".
  const trendContinuation = dir === 'bullish' ? 'lower' : 'higher';
  const trendReversal = dir === 'bullish' ? 'higher' : 'lower';

  let pattern = null;
  if (priceStep === trendContinuation && rsiStep === trendReversal) pattern = 'strong';
  else if (priceStep === 'equal' && rsiStep === trendReversal) pattern = 'medium';
  else if (priceStep === trendContinuation && rsiStep === 'equal') pattern = 'weak';
  else if (priceStep === trendReversal && rsiStep === trendContinuation) pattern = 'hidden';

  if (!pattern) {
    return { divergence: false, reason: `no divergence — price ${priceStep}, RSI ${rsiStep} (convergent or inconclusive)`, price_step: priceStep, rsi_step: rsiStep };
  }

  return {
    divergence: true,
    pattern, // "strong" | "medium" | "weak" | "hidden"
    direction: dir,
    price_step: priceStep,
    rsi_step: rsiStep,
    older_swing: older,
    newer_swing: newer,
    older_rsi: rsiOlder,
    newer_rsi: rsiNewer,
  };
}

/**
 * Full pipeline: compute RSI, find close-based price swings on the relevant
 * side (lows for bullish, highs for bearish), and classify the divergence
 * between the two most recent swings.
 *
 * Hidden divergences are excluded by default — the curriculum's author is
 * explicit ("I don't trade it"): they're continuation signals, not reversal
 * ones, and mixing them in would invert the meaning of a "divergence found"
 * result. Pass includeHidden:true to see them anyway.
 */
export function scanForDivergence(bars, { type, rsiPeriod = 14, lookback = 2, tolerancePercent = 0.05, includeHidden = false } = {}) {
  requireBars(bars);
  const dir = String(type).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('type must be "bullish" or "bearish"');

  const rsiValues = calculateRSI(bars, { period: rsiPeriod });
  const priceSwings = dir === 'bullish'
    ? findCloseSwingLows(bars, { lookback })
    : findCloseSwingHighs(bars, { lookback });

  const result = classifyDivergence({ priceSwings, rsiValues, direction: dir, tolerancePercent });
  if (!result.divergence) return result;
  if (result.pattern === 'hidden' && !includeHidden) {
    return {
      ...result,
      divergence: false,
      reason: 'hidden divergence found but excluded by default (continuation signal, not traded per curriculum — pass includeHidden:true to include it)',
    };
  }
  return { ...result, rsi_values: rsiValues };
}

/**
 * Full pipeline for CVD divergence — same close-based price swings and the
 * same strong/medium/weak/hidden taxonomy as scanForDivergence, but the
 * oscillator side is rolling-window CVD (calculateCVD) instead of RSI.
 *
 * Per Chapter 18: "Absorption" (CVD makes a new high/low, price doesn't
 * follow) and "Exhaustion" (price makes a new high/low, CVD doesn't follow)
 * are both described as "a divergence between price and the CVD line" —
 * mechanically identical to the RSI divergence comparison, just with a
 * different oscillator. Hidden divergences are excluded by default for the
 * same reason as scanForDivergence (continuation signal, not traded).
 */
export function scanForCVDDivergence(bars, { type, cvdWindow = 14, lookback = 2, tolerancePercent = 0.05, includeHidden = false } = {}) {
  requireBars(bars);
  const dir = String(type).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('type must be "bullish" or "bearish"');

  const cvdValues = calculateCVD(bars, { window: cvdWindow });
  const priceSwings = dir === 'bullish'
    ? findCloseSwingLows(bars, { lookback })
    : findCloseSwingHighs(bars, { lookback });

  const result = classifyDivergence({ priceSwings, rsiValues: cvdValues, direction: dir, tolerancePercent });
  if (!result.divergence) {
    if (result.reason) result.reason = result.reason.replace('RSI', 'CVD');
    return result;
  }
  if (result.pattern === 'hidden' && !includeHidden) {
    return {
      ...result,
      divergence: false,
      reason: 'hidden divergence found but excluded by default (continuation signal, not traded per curriculum — pass includeHidden:true to include it)',
    };
  }

  // Remap the generic "rsi_*" field names from classifyDivergence to "cvd_*"
  // for callers — the comparison logic is identical, only the label differs.
  const { rsi_step, older_rsi, newer_rsi, ...rest } = result;
  return { ...rest, cvd_step: rsi_step, older_cvd: older_rsi, newer_cvd: newer_rsi, cvd_values: cvdValues };
}

/**
 * Build a trade plan from a confirmed divergence, in the {entry, stop, target,
 * side} shape that core/risk.evaluateTradeSetup() consumes directly — mirrors
 * buildSFPTradePlan()'s conventions so both strategies compose identically
 * with the deterministic risk gate and account-translation layer:
 *
 *   - bullish divergence -> long (predicts a bottom); bearish -> short (top)
 *   - entry: close of the bar that completed the newer swing (the confirming
 *     candle — divergence alone isn't an entry, but the curriculum's worked
 *     examples consistently enter once the pivot candle closes and further
 *     confirmation appears; close-based entry keeps this mechanical and
 *     consistent with how SFP entries are coded)
 *   - stop: beyond that pivot candle's wick (low for bullish, high for
 *     bearish) — same "beyond the wick" placement as SFP
 *   - target: prior opposite-side swing level and/or range level, nearer one
 *     primary — identical target convention to buildSFPTradePlan
 */
export function buildDivergenceTradePlan({ hit, lastSwingLevel, rangeLevel } = {}) {
  if (!hit?.divergence || !hit?.newer_swing) throw new Error('hit must be a detected divergence result (from scanForDivergence/classifyDivergence)');
  const dir = String(hit.direction).toLowerCase();
  if (!['bullish', 'bearish'].includes(dir)) throw new Error('hit.direction must be "bullish" or "bearish"');

  const side = dir === 'bullish' ? 'long' : 'short';
  const bar = hit.newer_swing.bar;
  const entry = requirePositiveFinite(bar?.close ?? hit.newer_swing.value, 'entry');
  const stop = requirePositiveFinite(dir === 'bullish' ? (bar?.low ?? entry) : (bar?.high ?? entry), 'stop');

  const candidateTargets = [lastSwingLevel, rangeLevel].filter(t => t !== undefined && t !== null);
  if (candidateTargets.length === 0) throw new Error('at least one of lastSwingLevel or rangeLevel must be provided');

  let primary = candidateTargets[0];
  let alternate;
  for (const t of candidateTargets.slice(1)) {
    if (side === 'long' ? t < primary : t > primary) { alternate = primary; primary = t; }
    else alternate = t;
  }

  const confidenceLabel = {
    strong: 'highest (strong — price/RSI extremes move opposite ways)',
    medium: 'high (medium — price double top/bottom, RSI breaks away)',
    weak: 'standard (weak — price breaks, RSI double tops/bottoms)',
    hidden: 'continuation signal, not a reversal entry',
  }[hit.pattern] ?? hit.pattern;

  return {
    side,
    entry,
    stop,
    target: primary,
    alternate_target: alternate,
    pattern: hit.pattern,
    confidence: confidenceLabel,
  };
}
