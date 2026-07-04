/**
 * Market Structure (BOS / CHoCH) detection — pure functions over OHLC bar
 * arrays. Encodes Chapters 4 and 5 ("Market Structure Basics", "Completing
 * the Foundation"):
 *
 *   - Vocabulary (Ch.4 §2): HH/HL/LL/LH label each swing point relative to the
 *     PRIOR swing point of the same type — "A bullish MS is identified when
 *     the price makes a series of [HH and HL]... every time price takes out a
 *     high to form a HH, we get a break of structure (BOS)." Bearish MS mirrors
 *     this with LL/LH.
 *   - BOS is a CLOSE-based break (Ch.5: "I only use them if the candle closes
 *     below the low") of the prior same-type swing extreme — exactly the
 *     close-based-confirmation mechanic shared with SFP/Levels/Fibonacci,
 *     just applied to the swing-point sequence instead of a single level/zone.
 *   - "Deep" vs "minor" swings (Ch.5 §3, the Q2 clarification: "once a BOS
 *     happens, we take the lowest low that has led to our HH to be broken,
 *     and call it HL[;] every price movement happening in between... is
 *     substructure"): the swing point immediately preceding a confirmed
 *     BOS-forming point is the deep counter-point (the structural HL/LH);
 *     any opposing-type swing point that forms AFTER it is, by that same
 *     definition, substructure — a minor/retracement pivot.
 *   - CHoCH = "the first switch turning the substructure from bullish to
 *     bearish [or vice versa]" — the FIRST close-based break of one of those
 *     minor pivots, opposing the established trend ("the first sign of
 *     weakness before a break of structure occurs"). A second, realigning
 *     CHoCH is the curriculum's actual entry trigger (Ch.5 fig.8: "we enter
 *     on the first green candle closing above the bullish CHoCH").
 *   - "CHoCH is not a guarantee... use it in confluence with other tools" —
 *     this module is one independently-coded signal among several, never
 *     acted on alone.
 *
 * Bars are expected in {open, high, low, close} shape (matches getKlines()).
 * Swing points are {index, price} objects (e.g. from findSwingHighs/Lows).
 */

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
 * Merge swing highs and swing lows into one chronological, strictly-
 * alternating sequence (consecutive same-type points collapse to the more
 * extreme one — one continuous move makes one meaningful pivot, not several),
 * and label each point HH/HL/LH/LL by comparing it with the PRIOR point of
 * the same type (Ch.4 §2's vocabulary, applied mechanically). The first
 * occurrence of each type has no prior comparison and is labeled null.
 */
export function buildSwingSequence(swingHighs, swingLows) {
  requireSwingPointArray(swingHighs, 'swingHighs');
  requireSwingPointArray(swingLows, 'swingLows');

  const merged = [
    ...swingHighs.map(p => ({ index: p.index, price: p.price, bar: p.bar, type: 'high' })),
    ...swingLows.map(p => ({ index: p.index, price: p.price, bar: p.bar, type: 'low' })),
  ].sort((a, b) => a.index - b.index);

  const alternated = [];
  for (const point of merged) {
    const last = alternated[alternated.length - 1];
    if (last && last.type === point.type) {
      const moreExtreme = point.type === 'high'
        ? (point.price >= last.price ? point : last)
        : (point.price <= last.price ? point : last);
      alternated[alternated.length - 1] = moreExtreme;
    } else {
      alternated.push(point);
    }
  }

  const lastByType = {};
  return alternated.map(point => {
    const prior = lastByType[point.type] ?? null;
    let label = null;
    if (prior) {
      label = point.type === 'high'
        ? (point.price > prior.price ? 'HH' : 'LH')
        : (point.price < prior.price ? 'LL' : 'HL');
    }
    lastByType[point.type] = point;
    return { ...point, label, prior };
  });
}

/**
 * Shared close-based break primitive — both BOS and CHoCH are, per the
 * curriculum, "the candle that CLOSES beyond" a swing level, never a wick
 * alone. Returns the first matching bar at/after fromIndex (and at/before
 * toIndex, if given), or null.
 */
export function scanForCloseBreak(bars, { level, direction, fromIndex = 0, toIndex } = {}) {
  requireBars(bars);
  const lvl = Number(level);
  if (!Number.isFinite(lvl)) throw new Error(`level must be a finite number, got: ${level}`);
  const dir = String(direction).toLowerCase();
  if (!['above', 'below'].includes(dir)) throw new Error('direction must be "above" or "below"');

  const end = toIndex === undefined ? bars.length - 1 : Math.min(toIndex, bars.length - 1);
  for (let i = Math.max(0, fromIndex); i <= end; i++) {
    const bar = bars[i];
    const broke = dir === 'above' ? bar.close > lvl : bar.close < lvl;
    if (broke) return { index: i, bar };
  }
  return null;
}

/**
 * Full pipeline: labels the swing sequence, confirms BOS at every HH/LL
 * formation (a close-based break of the prior same-type extreme — both
 * trend continuations and structure-flipping reversals fall out of this one
 * comparison), then — within the leg defined by the most recent BOS — walks
 * the minor opposing-type pivots that formed after its deep counter-point and
 * flags each close-based break that opposes the established trend as a CHoCH,
 * alternating direction each time (first = "first sign of weakness", second =
 * the realigning "pullback may be ending" signal the curriculum trades off).
 */
export function detectMarketStructure(bars, { swingHighs, swingLows } = {}) {
  requireBars(bars);
  const sequence = buildSwingSequence(swingHighs, swingLows);

  const bos = [];
  for (let i = 1; i < sequence.length; i++) {
    const point = sequence[i];
    if (point.label !== 'HH' && point.label !== 'LL') continue;
    const direction = point.type === 'high' ? 'bullish' : 'bearish';
    const brk = scanForCloseBreak(bars, {
      level: point.prior.price,
      direction: point.type === 'high' ? 'above' : 'below',
      fromIndex: point.prior.index + 1,
      toIndex: point.index,
    });
    if (!brk) continue;
    // The deep counter-point (HL for a bullish BOS / LH for a bearish one) —
    // "the lowest low that has led to our HH to be broken, we call it HL"
    // (Ch.5 Q2) — is the opposing-type point immediately preceding it.
    const priorIdx = sequence.indexOf(point) - 1;
    const deepCounterPoint = priorIdx >= 0 && sequence[priorIdx].type !== point.type ? sequence[priorIdx] : null;
    bos.push({ direction, index: brk.index, bar: brk.bar, level: point.prior.price, swingPoint: point, deepCounterPoint });
  }

  const lastBOS = bos[bos.length - 1] ?? null;
  const trend = lastBOS?.direction ?? null;

  const choch = [];
  if (lastBOS) {
    // The pullback's depth is defined by the type that opposes the trend
    // (lows in an uptrend's retracement, highs in a downtrend's) — but a
    // CHoCH cycle alternates between BOTH pivot types: the first CHoCH
    // (opposing the trend) breaks a minor pivot of the opposing type, and
    // the realigning second CHoCH breaks a minor pivot of the trend's own
    // type that formed *during* that same pullback (Ch.5 fig.8: bearish
    // CHoCH breaks a retracement low, bullish CHoCH later breaks the
    // retracement high that formed on the way back down).
    const oppositeType = lastBOS.swingPoint.type === 'high' ? 'low' : 'high';
    const minorPoints = sequence.filter(p => p.index > lastBOS.swingPoint.index);

    let pullbackExtreme = null;
    let expectedDirection = trend === 'bullish' ? 'bearish' : 'bullish'; // CHoCH #1 always opposes the trend
    for (const point of minorPoints) {
      if (point.type === oppositeType) {
        pullbackExtreme = pullbackExtreme === null ? point.price
          : (oppositeType === 'low' ? Math.min(pullbackExtreme, point.price) : Math.max(pullbackExtreme, point.price));
      }

      const expectedPointType = expectedDirection === 'bearish' ? 'low' : 'high';
      if (point.type !== expectedPointType) continue;

      const brk = scanForCloseBreak(bars, {
        level: point.price,
        direction: expectedDirection === 'bullish' ? 'above' : 'below',
        fromIndex: point.index + 1,
      });
      if (brk) {
        choch.push({
          direction: expectedDirection,
          sequenceNumber: choch.length + 1,
          index: brk.index,
          bar: brk.bar,
          entry: brk.bar.close,
          level: point.price,
          swingPoint: point,
          pullbackExtreme,
        });
        expectedDirection = expectedDirection === 'bullish' ? 'bearish' : 'bullish'; // alternates each cycle
      }
    }
  }

  return { sequence, bos, choch, trend };
}

/**
 * Build a trade plan from a CHoCH that REALIGNS with the established trend —
 * the curriculum's actual entry trigger ("we enter on the first green candle
 * closing above the bullish CHoCH and we target the previous HH"; "second
 * CHoCH breach is a bullish sign indicating the pullback might end"). A CHoCH
 * opposing the trend is only the *first* sign of weakness, not a signal —
 * passing one here is rejected; that's confluence's "stand down" territory,
 * not a trade plan.
 *
 * direction "bullish" CHoCH in a bullish trend -> long; "bearish" in a
 * bearish trend -> short. entry = close of the break candle; stop = beyond
 * the pullback's extreme (the deepest retracement point reached — "stop above
 * the last lower high" generalized to "stop beyond the pullback's structure-
 * defining extreme"); target = the nearer of lastSwingLevel/rangeLevel, same
 * duality as the other three strategies ("target the previous HH"/"target
 * previous swing levels").
 */
export function buildStructureTradePlan({ choch, trend, lastSwingLevel, rangeLevel } = {}) {
  if (!choch?.bar) throw new Error('choch must be a confirmed Change-of-Character event (from detectMarketStructure)');
  const trendLower = String(trend).toLowerCase();
  if (!['bullish', 'bearish'].includes(trendLower)) throw new Error('trend must be "bullish" or "bearish"');
  if (choch.direction !== trendLower) throw new Error('only a CHoCH that realigns with the established trend is a trade trigger — an opposing CHoCH is merely "the first sign of weakness", not a signal');

  const side = trendLower === 'bullish' ? 'long' : 'short';
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
    entry: choch.entry,
    stop: choch.pullbackExtreme,
    target: primary,
    alternate_target: alternate,
    confidence: choch.sequenceNumber === 2
      ? 'clean single pullback — textbook CHoCH cycle (first sign of weakness, then realignment)'
      : 'late-cycle CHoCH — choppier substructure with multiple swings (demands more confluence)',
  };
}
