/**
 * VN Structure v2 — rolling-channel owner.
 * Pure computation: no filesystem, network, clock, or TradingView dependency.
 * Constants match approved spec exactly: window 20, lag 3, epsilon 0.005, 2 confirmations.
 */

// ── Constants ──
const WIN = 20;
const LAG = 3;
// ponytail: EPS = 0.005 = 1/200 encoded as integer comparison in classifyBoundary
const CONFIRM = 2;

export const VN_STRUCTURE_VERSION = 'vn-structure-v2-channel-20-3-005-2';

// ── Boundary direction ──

/**
 * Classify boundary direction: current vs reference with 0.5% band.
 *   UP   if current > reference * 1.005
 *   DOWN if current < reference * 0.995
 *   FLAT otherwise
 *   UNKNOWN for non-finite inputs
 *
 * ponytail: 0.005 = 1/200 → integer comparison avoids IEEE 754 drift
 *   current > reference * 1.005 ⟺ current * 200 > reference * 201
 *   current < reference * 0.995 ⟺ current * 200 < reference * 199
 */
export function classifyBoundary(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference)) return 'UNKNOWN';
  if (current * 200 > reference * 201) return 'UP';
  if (current * 200 < reference * 199) return 'DOWN';
  return 'FLAT';
}

// ── State derivation ──

/**
 * Derive trend/range from boundary directions and MA order.
 * Pure function — no side effects, no mutation.
 */
export function deriveCandidate({ upperDirection, lowerDirection, sma20, sma100 }) {
  const u = upperDirection;
  const l = lowerDirection;
  const maFinite = Number.isFinite(sma20) && Number.isFinite(sma100);

  // Missing/non-finite input → UNKNOWN
  if (!maFinite || u === 'UNKNOWN' || l === 'UNKNOWN') {
    return { trendState: 'UNKNOWN', rangeState: 'UNKNOWN' };
  }

  if (u === 'UP' && l === 'UP') {
    if (sma20 > sma100) return { trendState: 'UP', rangeState: 'SHIFTING' };
    return { trendState: 'MIXED', rangeState: 'SHIFTING' };
  }
  if (u === 'DOWN' && l === 'DOWN') {
    if (sma20 < sma100) return { trendState: 'DOWN', rangeState: 'SHIFTING' };
    return { trendState: 'MIXED', rangeState: 'SHIFTING' };
  }
  if (u === 'FLAT' && l === 'FLAT') {
    return { trendState: 'RANGE', rangeState: 'STABLE' };
  }
  if (u === 'UP' && l === 'DOWN') return { trendState: 'MIXED', rangeState: 'EXPANDING' };
  if (u === 'DOWN' && l === 'UP') return { trendState: 'MIXED', rangeState: 'CONTRACTING' };

  // Other finite combination → MIXED/SHIFTING
  return { trendState: 'MIXED', rangeState: 'SHIFTING' };
}

// ── Compatibility display ──

/**
 * Compatibility display mapping from v2 trend_state to legacy labels.
 */
export function compatibilityStructure(trendState) {
  const map = {
    UP: 'UPTREND',
    DOWN: 'DOWNTREND',
    RANGE: 'SIDEWAYS',
    MIXED: 'MIXED',
    UNKNOWN: 'INSUFFICIENT_DATA',
  };
  return map[trendState] || 'INSUFFICIENT_DATA';
}

// ── Core computation ──

/**
 * Compute VN structure v2 from completed H6 bars and MAs.
 *
 * @param {Array} completedBars — array of {time, high, low}
 * @param {Object} mas — {sma20, sma100}
 * @returns {{ version, trend_state, range_state, confirmed, upper, upper_ref, lower, lower_ref, as_of }}
 */
export function computeVnStructure(completedBars, { sma20, sma100 }) {
  const n = completedBars.length;
  const empty = {
    version: VN_STRUCTURE_VERSION,
    trend_state: 'UNKNOWN',
    range_state: 'UNKNOWN',
    confirmed: false,
    upper: null,
    upper_ref: null,
    lower: null,
    lower_ref: null,
    as_of: null,
  };

  if (n < 23) return empty;

  // Compute bounds for a given end index t
  const boundsAt = (t) => {
    // Current window: bars[t-19..t]
    const curHighs = [];
    const curLows = [];
    for (let i = t - 19; i <= t; i++) {
      curHighs.push(completedBars[i].high);
      curLows.push(completedBars[i].low);
    }
    // Reference window: bars[t-22..t-3]
    const refHighs = [];
    const refLows = [];
    for (let i = t - 22; i <= t - 3; i++) {
      refHighs.push(completedBars[i].high);
      refLows.push(completedBars[i].low);
    }

    const inputsFinite = [...curHighs, ...curLows, ...refHighs, ...refLows]
      .every(Number.isFinite);
    if (!inputsFinite) {
      return {
        upper: null,
        lower: null,
        upperRef: null,
        lowerRef: null,
        upperDirection: 'UNKNOWN',
        lowerDirection: 'UNKNOWN',
      };
    }

    const upper = Math.max(...curHighs);
    const lower = Math.min(...curLows);
    const upperRef = Math.max(...refHighs);
    const lowerRef = Math.min(...refLows);

    return {
      upper,
      lower,
      upperRef,
      lowerRef,
      upperDirection: classifyBoundary(upper, upperRef),
      lowerDirection: classifyBoundary(lower, lowerRef),
    };
  };

  const cur = boundsAt(n - 1);
  const candidate = deriveCandidate({
    upperDirection: cur.upperDirection,
    lowerDirection: cur.lowerDirection,
    sma20,
    sma100,
  });

  // First evaluation only → provisional
  if (n < 24) {
    return {
      version: VN_STRUCTURE_VERSION,
      trend_state: candidate.trendState,
      range_state: candidate.rangeState,
      confirmed: false,
      upper: cur.upper,
      upper_ref: cur.upperRef,
      lower: cur.lower,
      lower_ref: cur.lowerRef,
      as_of: completedBars[n - 1] ? completedBars[n - 1].time : null,
    };
  }

  // Two consecutive evaluations needed for confirmation
  const prev = boundsAt(n - 2);
  const confirmed = candidate.trendState !== 'UNKNOWN'
    && cur.upperDirection === prev.upperDirection
    && cur.lowerDirection === prev.lowerDirection;

  return {
    version: VN_STRUCTURE_VERSION,
    trend_state: candidate.trendState,
    range_state: candidate.rangeState,
    confirmed,
    upper: cur.upper,
    upper_ref: cur.upperRef,
    lower: cur.lower,
    lower_ref: cur.lowerRef,
    as_of: completedBars[n - 1] ? completedBars[n - 1].time : null,
  };
}
