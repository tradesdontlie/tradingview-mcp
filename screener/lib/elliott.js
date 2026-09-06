/**
 * Elliott Wave (5-wave impulse, bullish) detection using Fibonacci confluence.
 *
 * This is a rule-based HEURISTIC, not a certified wave count. Real Elliott
 * Wave analysis is subjective even between professional analysts — this
 * checks the textbook Fibonacci/structure rules (Frost & Prechter,
 * "Elliott Wave Principle") mechanically against zigzag pivots:
 *
 *   Rule (hard, must hold):
 *     - Wave 2 never retraces more than 100% of wave 1.
 *     - Wave 3 is never the shortest of waves 1/3/5.
 *     - Wave 4 does not enter wave 1's price territory.
 *   Guideline (soft, used for confidence/Fibonacci confirmation):
 *     - Wave 2 typically retraces 50%-78.6% of wave 1.
 *     - Wave 3 is often 1.618x wave 1 (allow 1.0x-2.618x).
 *     - Wave 4 typically retraces 23.6%-38.2% of wave 3.
 *     - Wave 5 projects 0.618x-1.618x of wave 1's length from the wave 4 low.
 */

const FIB = { w2min: 0.382, w2max: 0.786, w4min: 0.236, w4max: 0.5, w3minMult: 1.0 };

// A wave count is only a live, actionable signal if it topped/broke out
// recently. Over a long lookback, an old-but-structurally-valid impulse can
// sit far behind current price with a "target" already left behind —
// bounding how many bars ago the count's most recent point occurred keeps
// matches fresh.
const MAX_WAVE_AGE_BARS = 20;

export function detectElliottImpulse(bars, pivots) {
  if (pivots.length < 6) return null;
  const lastBar = bars[bars.length - 1];
  const lastClose = lastBar.close;
  if (!(lastBar.close > lastBar.open)) return null; // require today's candle to close green — a live bounce, not a stale/declining read

  // Look at the most recent 6 alternating pivots: 0(low) 1(high) 2(low) 3(high) 4(low) 5(high)
  const last6 = pivots.slice(-6);
  const types = last6.map(p => p.type);
  const expected = ['low', 'high', 'low', 'high', 'low', 'high'];
  if (types.join(',') !== expected.join(',')) return null;

  const [w0, w1, w2, w3, w4, w5] = last6;
  if (bars.length - 1 - w5.index > MAX_WAVE_AGE_BARS) return null; // wave 5 topped too long ago — stale

  const wave1Len = w1.price - w0.price;
  const wave2Len = w1.price - w2.price;
  const wave3Len = w3.price - w2.price;
  const wave4Len = w3.price - w4.price;
  const wave5Len = w5.price - w4.price;

  if (wave1Len <= 0 || wave3Len <= 0 || wave5Len <= 0) return null;

  // Hard rules
  const w2RetraceRatio = wave2Len / wave1Len;
  if (w2RetraceRatio >= 1) return null; // wave2 retraced 100%+ of wave1 — invalid
  if (w4.price <= w1.price) return null; // wave4 overlapped wave1 territory — invalid
  const lengths = [wave1Len, wave3Len, wave5Len];
  if (wave3Len === Math.min(...lengths)) return null; // wave3 is the shortest — invalid

  // Fibonacci confluence checks — previously scored as an informational
  // "N/3" confidence label that never actually filtered anything, so a
  // count that failed every guideline still matched just as readily as a
  // textbook-perfect one. Now required in full: all three must hold or the
  // count is rejected outright, not flagged "low confidence" and shown anyway.
  const w4RetraceRatio = wave4Len / wave3Len;
  const w3Multiple = wave3Len / wave1Len;
  const w2FibOk = w2RetraceRatio >= FIB.w2min && w2RetraceRatio <= FIB.w2max;
  const w3FibOk = w3Multiple >= FIB.w3minMult;
  const w4FibOk = w4RetraceRatio >= FIB.w4min && w4RetraceRatio <= FIB.w4max;
  if (!w2FibOk || !w3FibOk || !w4FibOk) return null;

  const uptrendConfirmed = lastClose > w4.price && w5.price > w3.price;
  if (!uptrendConfirmed) return null;

  const wave5TargetsFromWave1 = {
    tp1_0618: Math.round((w4.price + 0.618 * wave1Len) * 1e6) / 1e6,
    tp2_1000: Math.round((w4.price + 1.0 * wave1Len) * 1e6) / 1e6,
    extended_1618: Math.round((w4.price + 1.618 * wave1Len) * 1e6) / 1e6,
  };

  return {
    matched: true,
    confirmed_uptrend: true,
    confidence: '3/3 fib checks (wave2/wave3/wave4 semua dalam zona ideal)',
    wave_points: { w0, w1, w2, w3, w4, w5 },
    wave2_retrace_pct: Math.round(w2RetraceRatio * 1000) / 10,
    wave3_multiple_of_wave1: Math.round(w3Multiple * 100) / 100,
    wave4_retrace_pct: Math.round(w4RetraceRatio * 1000) / 10,
    invalidation_level: w4.price, // wave 4 low — a close below this breaks the count
    wave5_targets: wave5TargetsFromWave1,
  };
}

/**
 * Wave 2 defended — the earliest, most aggressive entry of the three Elliott
 * screens. Wave 1 (impulse up) is confirmed; price has pulled back since
 * without ever exceeding wave 1's high (the pullback prints a structural
 * "lower high" against wave 1); and today's candle closes green — the first
 * sign buyers are defending the correction and the uptrend character is
 * being preserved rather than reversing into a new downtrend.
 *
 * This is the LEAST confirmed of the three reads: wave 2 may not have
 * finished falling yet, so the pullback low used for cutloss/targets is
 * "the lowest point so far," not a guaranteed final bottom.
 *
 *   Hard rule: wave 2 must not retrace 100%+ of wave 1 (else it's a trend
 *              reversal, not a correction).
 *   Trigger:   pullback hasn't exceeded wave 1's high, AND today's candle
 *              closed green (close > open).
 *   Guideline: wave 2 retracing 38.2%-78.6% of wave 1 is the classic zone;
 *              tracked as a confidence flag, not a hard filter.
 */
export function detectElliottWave2Support(bars, pivots) {
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');
  if (highs.length < 1 || lows.length < 1) return null;

  const w1 = highs[highs.length - 1]; // most recent confirmed high = wave 1 top candidate
  const w0 = [...lows].reverse().find(l => l.index < w1.index); // the low before it = wave 1 start
  if (!w0) return null;
  if (bars.length - 1 - w1.index > MAX_WAVE_AGE_BARS) return null; // wave 1 top happened too long ago — stale

  const wave1Len = w1.price - w0.price;
  if (wave1Len <= 0) return null;

  const afterW1 = bars.slice(w1.index + 1);
  if (afterW1.length < 2) return null; // need at least a little pullback to read anything

  const maxHighAfter = Math.max(...afterW1.map(b => b.high));
  if (maxHighAfter > w1.price) return null; // already broke above wave 1 — that's wave 3 territory, not wave 2

  const lastBar = bars[bars.length - 1];
  if (!(lastBar.close > lastBar.open)) return null; // need today's candle actively defending the pullback

  const pullbackLow = Math.min(...afterW1.map(b => b.low));
  const wave2Len = w1.price - pullbackLow;
  const w2RetraceRatio = wave2Len / wave1Len;
  if (w2RetraceRatio >= 1) return null; // retraced 100%+ of wave1 — invalid, this is a reversal not a correction

  // Previously a soft "confidence" label that still returned a match even
  // outside the classic zone ("waspada" but shown anyway). Now required —
  // a retrace outside 38.2%-78.6% doesn't fit the textbook wave 2 profile
  // closely enough to surface as a signal.
  const fibOk = w2RetraceRatio >= FIB.w2min && w2RetraceRatio <= FIB.w2max;
  if (!fibOk) return null;

  return {
    matched: true,
    confirmed_uptrend: true,
    confidence: 'wave2 retrace dalam zona fib 38.2%-78.6%',
    wave_points: { w0, w1 },
    pullback_low: pullbackLow,
    wave2_retrace_pct: Math.round(w2RetraceRatio * 1000) / 10,
    invalidation_level: pullbackLow, // a close back below the pullback-so-far low breaks the "defended" read
    wave3_targets: {
      // Backtest (100 symbols, N=252) showed only a 25.6% win rate against
      // the tight stop below — 1.618x wave 1 as TP1 was too far to reach
      // before the stop typically got hit, even when the eventual direction
      // was right. Nearer first target (0.618x), the old TP1/TP2 shifted out
      // to TP2/extended.
      tp0_0618: Math.round((pullbackLow + 0.618 * wave1Len) * 1e6) / 1e6,
      tp1_1618: Math.round((pullbackLow + 1.618 * wave1Len) * 1e6) / 1e6,
      tp2_2618: Math.round((pullbackLow + 2.618 * wave1Len) * 1e6) / 1e6,
      extended_4236: Math.round((pullbackLow + 4.236 * wave1Len) * 1e6) / 1e6,
    },
  };
}

// Named Fibonacci retracement zones for classifying how deep a wave 2
// pullback went, per the four categories requested: shallow (strong trend),
// deep pullback, the wide golden zone, and the tight golden pocket right at
// 61.8%. Bands are non-overlapping; a retracement outside all four (too
// shallow to be a real pullback, or beyond ~65%) doesn't qualify for THIS
// criterion — it may still qualify for the broader detectElliottWave2Support
// above, which tolerates up to 78.6%.
const FIB_ZONES = [
  { min: 0.236, max: 0.382, label: 'Retracement Dangkal 23.6%-38.2% (trend kuat)' },
  { min: 0.382, max: 0.5, label: 'Retracement Dalam 38.2%+ (deep pullback)' },
  { min: 0.5, max: 0.618, label: 'Golden Zone Lebar 50%-61.8%' },
  { min: 0.618, max: 0.65, label: 'Golden Pocket 61.8%' },
];

function classifyFibZone(ratio) {
  return FIB_ZONES.find(z => ratio >= z.min && ratio <= z.max) ?? null;
}

/**
 * Uptrend pullback reversal — wave 1 confirmed, a wave 2 correction landed in
 * one of the four named Fibonacci retracement zones, and today's candle
 * closes green, confirming buyers stepped back in. Reports which Elliott
 * wave the move sits in (always "wave 2" here by construction — if price
 * already broke above wave 1's high that's wave 3+ territory and this
 * detector intentionally does not fire; there is no wave 5 case to report
 * since this only looks at the wave 1->2 stage).
 *
 * Confirmation is Fibonacci-only — an earlier version also accepted a
 * retracement landing near a known horizontal support zone as an
 * alternative trigger with no depth limit of its own, which let a ~95-96%
 * retracement (barely short of fully invalidating wave 1) through as a
 * "wave 2." That's outside where Elliott Wave theory still calls it a
 * correction rather than a failed count, so the support-zone path was
 * dropped; the classify-by-fib-zone path already implicitly caps depth at
 * 65% (the widest zone, Golden Pocket).
 *
 *   Hard rule:  wave 2 must not retrace 100%+ of wave 1.
 *   Trigger:    pullback hasn't exceeded wave 1's high, AND today's candle
 *               closed green, AND the pullback lands in a named fib zone.
 */
export function detectPullbackReversal(bars, pivots) {
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');
  if (highs.length < 1 || lows.length < 1) return null;

  const w1 = highs[highs.length - 1];
  const w0 = [...lows].reverse().find(l => l.index < w1.index);
  if (!w0) return null;
  if (bars.length - 1 - w1.index > MAX_WAVE_AGE_BARS) return null;

  const wave1Len = w1.price - w0.price;
  if (wave1Len <= 0) return null;

  const afterW1 = bars.slice(w1.index + 1);
  if (afterW1.length < 2) return null;

  const maxHighAfter = Math.max(...afterW1.map(b => b.high));
  if (maxHighAfter > w1.price) return null; // already in wave 3+ territory, not a fresh wave 2 pullback

  const lastBar = bars[bars.length - 1];
  if (!(lastBar.close > lastBar.open)) return null; // must be a green reversal candle

  const pullbackLow = Math.min(...afterW1.map(b => b.low));
  const wave2Len = w1.price - pullbackLow;
  const retraceRatio = wave2Len / wave1Len;
  if (retraceRatio >= 1) return null;

  const fibZone = classifyFibZone(retraceRatio);
  if (!fibZone) return null; // must land in one of the four named zones

  return {
    matched: true,
    elliott_wave_position: 'Wave 2 (koreksi setelah impuls wave 1)',
    wave_points: { w0, w1 },
    pullback_low: pullbackLow,
    retrace_pct: Math.round(retraceRatio * 1000) / 10,
    fib_zone: fibZone.label,
    invalidation_level: pullbackLow,
    targets: (() => {
      // #1/#2: standard Fibonacci expansion off the pullback low, as
      // multiples of wave 1's length.
      const wave3Target = pullbackLow + 1.618 * wave1Len;
      const wave3Length = wave3Target - pullbackLow; // == 1.618 * wave1Len, kept explicit for readability below

      // #4: wave 5 target — necessarily a rough, early ballpark since waves
      // 3 and 4 haven't happened yet. Assumes a textbook-typical wave 4
      // retrace (38.2% of wave 3's length) as a stand-in for wave 4's
      // (unknown) low, then applies the "wave 5 = wave 1" equality rule from
      // there. This is a directional guess, not a level to plan an exit
      // around — it moves once wave 3/4 actually print.
      const estimatedWave4Low = wave3Target - 0.382 * wave3Length;
      const wave5TargetRough = estimatedWave4Low + 1.0 * wave1Len;

      return {
        // Backtest (100 symbols, N=195) showed only a 21.4% win rate with
        // 161.8% as the near target against a tight stop — too far to reach
        // before the stop hit. 61.8% added as a nearer, more reachable first
        // target; the rest shift out to become TP2/wave3/extended.
        expansion_0618: Math.round((pullbackLow + 0.618 * wave1Len) * 1e6) / 1e6,
        expansion_1618: Math.round(wave3Target * 1e6) / 1e6,
        expansion_2618: Math.round((pullbackLow + 2.618 * wave1Len) * 1e6) / 1e6,
        // #3: wave 3 target — identical figure to the 161.8% expansion above
        // (that IS the standard wave 3 projection); kept as a separate named
        // field only because it was asked for by name.
        wave3_target: Math.round(wave3Target * 1e6) / 1e6,
        wave5_target_rough: Math.round(wave5TargetRough * 1e6) / 1e6,
      };
    })(),
  };
}
