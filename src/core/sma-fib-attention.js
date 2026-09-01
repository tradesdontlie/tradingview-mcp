/**
 * Pure, read-only SMA/Fib attention model.
 *
 * This module deliberately separates current observations from transition
 * events. A pre-existing condition remains queryable without being mislabeled
 * as a newly triggered alert.
 */

export const SMA_FIB_ATTENTION_SCHEMA_VERSION = 'sma-fib-attention-observation/v1';
export const SMA_FIB_EVENT_SCHEMA_VERSION = 'sma-fib-attention-event/v1';

export const SMA_FIB_ATTENTION_CONDITIONS = Object.freeze([
  'MA_NEAR',
  'MA_BAR_NEAR',
  'MA_TOUCH',
  'FIB_NEAR',
  'FIB_BAR_NEAR',
  'FIB_INSIDE',
  'FIB_TOUCH',
  'SMA_FIB_ALIGNED',
  'MULTI_FAMILY',
]);

const CONDITION_SET = new Set(SMA_FIB_ATTENTION_CONDITIONS);
const PROFILE_BY_TIMEFRAME = Object.freeze({
  D: Object.freeze({ code: 1, label: '200D' }),
  W: Object.freeze({ code: 2, label: '200W' }),
});
const GOLDEN_TOP_RATIO = 0.618;
const GOLDEN_BOTTOM_RATIO = 0.650;
const GOLDEN_LEVEL_ABSOLUTE_TOLERANCE = 1e-8;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveFinite(value) {
  return finite(value) && value > 0;
}

function requireNonNegativePercent(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new TypeError(`${label} must be a finite, non-negative percentage.`);
  }
  return result;
}

function requireTimestamp(value, label) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer in milliseconds.`);
  }
  return result;
}

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw new TypeError(`Unsupported timeframe: ${value}`);
}

function normalizeSymbol(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!result) throw new TypeError('reading needs a symbol.');
  return result;
}

function roundMetric(value) {
  return finite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function roundEight(value) {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function goldenLevelMatches(actual, expected) {
  if (!positiveFinite(actual) || !positiveFinite(expected)) return false;
  const floatingPointTolerance = Number.EPSILON
    * Math.max(Math.abs(actual), Math.abs(expected))
    * 32;
  return Math.abs(actual - expected)
    <= Math.max(GOLDEN_LEVEL_ABSOLUTE_TOLERANCE, floatingPointTolerance);
}

function percentDistanceToLevel(value, level) {
  if (!positiveFinite(value) || !positiveFinite(level)) return null;
  return Math.abs(value - level) / level * 100;
}

function percentDistanceToRange(value, firstEdge, secondEdge) {
  if (![value, firstEdge, secondEdge].every(positiveFinite)) return null;
  const low = Math.min(firstEdge, secondEdge);
  const high = Math.max(firstEdge, secondEdge);
  if (value >= low && value <= high) return 0;
  const nearestEdge = value < low ? low : high;
  return Math.abs(value - nearestEdge) / nearestEdge * 100;
}

function percentDistanceBetweenRanges(firstLow, firstHigh, secondLow, secondHigh) {
  if (![firstLow, firstHigh, secondLow, secondHigh].every(positiveFinite)) return null;
  const aLow = Math.min(firstLow, firstHigh);
  const aHigh = Math.max(firstLow, firstHigh);
  const bLow = Math.min(secondLow, secondHigh);
  const bHigh = Math.max(secondLow, secondHigh);
  if (aHigh >= bLow && aLow <= bHigh) return 0;
  if (aHigh < bLow) return (bLow - aHigh) / bLow * 100;
  return (aLow - bHigh) / bHigh * 100;
}

function relationToLevel(value, level) {
  if (!positiveFinite(value) || !positiveFinite(level)) return null;
  const tolerance = Number.EPSILON * Math.max(Math.abs(value), Math.abs(level)) * 32;
  if (Math.abs(value - level) <= tolerance) return 'at';
  return value > level ? 'above' : 'below';
}

function relationToRange(value, firstEdge, secondEdge) {
  if (![value, firstEdge, secondEdge].every(positiveFinite)) return null;
  const low = Math.min(firstEdge, secondEdge);
  const high = Math.max(firstEdge, secondEdge);
  if (value < low) return 'below';
  if (value > high) return 'above';
  return 'inside';
}

function resolveBarRange(reading, close) {
  const low = positiveFinite(reading?.current_low)
    ? reading.current_low
    : positiveFinite(reading?.low)
      ? reading.low
      : null;
  const high = positiveFinite(reading?.current_high)
    ? reading.current_high
    : positiveFinite(reading?.high)
      ? reading.high
      : null;
  if (!positiveFinite(low) || !positiveFinite(high) || low > high) {
    return { available: false, low: null, high: null };
  }
  if (positiveFinite(close) && (close < low || close > high)) {
    return { available: false, low: null, high: null };
  }
  return { available: true, low, high };
}

function buildMaObservation(reading, profile, close, barRange, bufferPct) {
  const level = positiveFinite(reading?.prior_sma) ? reading.prior_sma : null;
  if (!level) {
    return {
      family: 'ma',
      status: 'insufficient_history',
      available: false,
      profile: profile.label,
      level: null,
      relation: null,
      price_distance_pct: null,
      bar_range_distance_pct: null,
      within_price_buffer: false,
      within_range_buffer: false,
      active: false,
      touching: null,
    };
  }

  const priceDistance = percentDistanceToLevel(close, level);
  const rangeDistance = barRange.available
    ? percentDistanceBetweenRanges(barRange.low, barRange.high, level, level)
    : null;
  const touching = barRange.available ? barRange.low <= level && barRange.high >= level : null;
  const withinPriceBuffer = priceDistance <= bufferPct;
  const withinRangeBuffer = rangeDistance === null ? withinPriceBuffer : rangeDistance <= bufferPct;

  return {
    family: 'ma',
    status: 'available',
    available: true,
    profile: profile.label,
    level,
    relation: relationToLevel(close, level),
    price_distance_pct: roundMetric(priceDistance),
    bar_range_distance_pct: roundMetric(rangeDistance),
    within_price_buffer: withinPriceBuffer,
    within_range_buffer: withinRangeBuffer,
    active: withinPriceBuffer || withinRangeBuffer || touching === true,
    touching,
  };
}

function invalidFib(reason, extra = {}) {
  return {
    family: 'fib',
    status: 'contract_invalid',
    available: false,
    eligible: true,
    contract_valid: false,
    invalid_reason: reason,
    pair_id: null,
    relation: null,
    price_distance_pct: null,
    bar_range_distance_pct: null,
    within_price_buffer: false,
    within_range_buffer: false,
    inside: false,
    touching: null,
    active: false,
    ...extra,
  };
}

function buildFibObservation(reading, close, barRange, bufferPct, dataAsOfTimeMs) {
  if (reading?.fib_machine_available === false) {
    return {
      family: 'fib',
      status: 'detector_unavailable',
      available: false,
      eligible: null,
      contract_valid: null,
      unavailable_reason: reading.fib_detector_unavailable_reason,
      invalid_reason: null,
      pair_id: null,
      relation: null,
      price_distance_pct: null,
      bar_range_distance_pct: null,
      within_price_buffer: false,
      within_range_buffer: false,
      inside: false,
      touching: null,
      active: false,
      anchors: null,
      pocket: null,
    };
  }
  if (reading?.fib_source_binding_verified === false) {
    return {
      family: 'fib',
      status: 'source_unverified',
      available: false,
      eligible: null,
      contract_valid: null,
      invalid_reason: 'applied_source_unverified',
      pair_id: null,
      relation: null,
      price_distance_pct: null,
      bar_range_distance_pct: null,
      within_price_buffer: false,
      within_range_buffer: false,
      inside: false,
      touching: null,
      active: false,
      anchors: null,
      pocket: null,
    };
  }
  if (reading?.intrabar_pair_suppression_reason === 'bar_range_unproved') {
    return {
      family: 'fib',
      status: 'unavailable',
      available: false,
      eligible: null,
      contract_valid: null,
      unavailable_reason: 'current_bar_range_unproved',
      invalid_reason: null,
      pair_id: null,
      relation: null,
      price_distance_pct: null,
      bar_range_distance_pct: null,
      within_price_buffer: false,
      within_range_buffer: false,
      inside: false,
      touching: null,
      active: false,
      anchors: null,
      pocket: null,
    };
  }
  const eligible = reading?.pair_eligible === true || reading?.pair_eligible === 1;
  if (!eligible) {
    return {
      family: 'fib',
      status: 'no_active_pair',
      available: false,
      eligible: false,
      contract_valid: null,
      invalid_reason: null,
      pair_id: null,
      relation: null,
      price_distance_pct: null,
      bar_range_distance_pct: null,
      within_price_buffer: false,
      within_range_buffer: false,
      inside: false,
      touching: null,
      active: false,
      anchors: null,
      pocket: null,
    };
  }

  const required = [
    reading?.golden_bottom,
    reading?.golden_top,
    reading?.fib_low,
    reading?.fib_high,
  ];
  if (!required.every(positiveFinite)) {
    return invalidFib('active_pair_values_unavailable');
  }

  const pocketLow = Math.min(reading.golden_bottom, reading.golden_top);
  const pocketHigh = Math.max(reading.golden_bottom, reading.golden_top);
  if (!(reading.fib_low < reading.fib_high
    && pocketLow < pocketHigh
    && pocketLow >= reading.fib_low
    && pocketHigh <= reading.fib_high)) {
    return invalidFib('invalid_active_pair_geometry', {
      pocket: { low: pocketLow, high: pocketHigh },
    });
  }

  const fibRange = reading.fib_high - reading.fib_low;
  const expectedTop = roundEight(reading.fib_high - GOLDEN_TOP_RATIO * fibRange);
  const expectedBottom = roundEight(reading.fib_high - GOLDEN_BOTTOM_RATIO * fibRange);
  if (!goldenLevelMatches(reading.golden_top, expectedTop)
    || !goldenLevelMatches(reading.golden_bottom, expectedBottom)) {
    return invalidFib('invalid_active_pair_golden_derivation', {
      pocket: { low: pocketLow, high: pocketHigh },
      expected_pocket: { low: expectedBottom, high: expectedTop },
    });
  }

  const lowPivotTimeMs = reading.fib_low_pivot_time_ms;
  const highPivotTimeMs = reading.fib_high_pivot_time_ms;
  const confirmationTimeMs = reading.fib_high_confirmation_time_ms;
  if (![lowPivotTimeMs, highPivotTimeMs, confirmationTimeMs, dataAsOfTimeMs]
    .every(positiveFinite)
    || !(lowPivotTimeMs < highPivotTimeMs
      && highPivotTimeMs < confirmationTimeMs
      && confirmationTimeMs < dataAsOfTimeMs)) {
    return invalidFib('invalid_active_pair_timestamps', {
      pocket: { low: pocketLow, high: pocketHigh },
    });
  }

  const priceDistance = percentDistanceToRange(close, pocketLow, pocketHigh);
  const rangeDistance = barRange.available
    ? percentDistanceBetweenRanges(barRange.low, barRange.high, pocketLow, pocketHigh)
    : null;
  const touching = barRange.available
    ? barRange.high >= pocketLow && barRange.low <= pocketHigh
    : null;
  const relation = relationToRange(close, pocketLow, pocketHigh);
  const withinPriceBuffer = priceDistance <= bufferPct;
  const withinRangeBuffer = rangeDistance === null ? withinPriceBuffer : rangeDistance <= bufferPct;
  const pairId = [
    lowPivotTimeMs,
    highPivotTimeMs,
    confirmationTimeMs,
    roundEight(reading.fib_low),
    roundEight(reading.fib_high),
  ].join('|');

  return {
    family: 'fib',
    status: 'available',
    available: true,
    eligible: true,
    contract_valid: true,
    invalid_reason: null,
    pair_id: pairId,
    relation,
    price_distance_pct: roundMetric(priceDistance),
    bar_range_distance_pct: roundMetric(rangeDistance),
    within_price_buffer: withinPriceBuffer,
    within_range_buffer: withinRangeBuffer,
    inside: relation === 'inside',
    touching,
    active: withinPriceBuffer || withinRangeBuffer || relation === 'inside' || touching === true,
    anchors: {
      low: { price: reading.fib_low, pivot_time_ms: lowPivotTimeMs },
      high: {
        price: reading.fib_high,
        pivot_time_ms: highPivotTimeMs,
        confirmation_time_ms: confirmationTimeMs,
      },
    },
    pocket: { low: pocketLow, high: pocketHigh },
  };
}

function conditionList(ma, fib, confluence) {
  const result = [];
  // `*_NEAR` answers the user's point-in-time question: the current price is
  // inside the configured buffer. Preserve an earlier same-bar approach as an
  // explicitly different condition so it cannot masquerade as "within 5% now".
  if (ma.within_price_buffer) result.push('MA_NEAR');
  if (ma.within_range_buffer && !ma.within_price_buffer && ma.touching !== true) {
    result.push('MA_BAR_NEAR');
  }
  if (ma.touching === true) result.push('MA_TOUCH');
  if (fib.within_price_buffer) result.push('FIB_NEAR');
  if (fib.within_range_buffer && !fib.within_price_buffer && fib.touching !== true) {
    result.push('FIB_BAR_NEAR');
  }
  if (fib.inside) result.push('FIB_INSIDE');
  if (fib.touching === true) result.push('FIB_TOUCH');
  if (confluence.structurally_aligned) result.push('SMA_FIB_ALIGNED');
  if (confluence.primitive_family_count >= 2) result.push('MULTI_FAMILY');
  return result;
}

/** Build one independently queryable MA/Fib observation for a D or W route. */
export function buildSmaFibObservation(reading, {
  maBufferPct = 5,
  fibBufferPct = 5,
  alignmentTolerancePct = 0,
  scanAsOfTimeMs = reading?.scan_as_of_time_ms ?? Date.now(),
  barClosed = reading?.bar_closed === true,
  observationKind = 'current',
  source = null,
} = {}) {
  const maBuffer = requireNonNegativePercent(maBufferPct, 'maBufferPct');
  const fibBuffer = requireNonNegativePercent(fibBufferPct, 'fibBufferPct');
  const alignmentTolerance = requireNonNegativePercent(
    alignmentTolerancePct,
    'alignmentTolerancePct',
  );
  const observedAtMs = requireTimestamp(scanAsOfTimeMs, 'scanAsOfTimeMs');
  const timeframe = normalizeTimeframe(reading?.timeframe);
  const profile = PROFILE_BY_TIMEFRAME[timeframe];
  const symbol = normalizeSymbol(
    reading?.requested_symbol ?? reading?.symbol ?? reading?.chart_symbol,
  );
  const close = positiveFinite(reading?.current_price)
    ? reading.current_price
    : positiveFinite(reading?.close)
      ? reading.close
      : null;
  if (!close) throw new TypeError('reading needs a positive current price.');
  const barRange = resolveBarRange(reading, close);
  const dataAsOfTimeMs = positiveFinite(reading?.data_as_of_time_ms)
    ? reading.data_as_of_time_ms
    : finite(reading?.current_bar_time_s)
      ? reading.current_bar_time_s * 1000
      : null;
  if (!positiveFinite(dataAsOfTimeMs)) {
    throw new TypeError('reading needs a positive data bar timestamp.');
  }

  const ma = buildMaObservation(reading, profile, close, barRange, maBuffer);
  const fib = buildFibObservation(reading, close, barRange, fibBuffer, dataAsOfTimeMs);
  const smaToPocketDistance = ma.available && fib.available
    ? percentDistanceToRange(ma.level, fib.pocket.low, fib.pocket.high)
    : null;
  const primitiveFamilies = [
    ...(ma.active ? ['ma'] : []),
    ...(fib.active ? ['fib'] : []),
  ];
  const structurallyAligned = smaToPocketDistance !== null
    && smaToPocketDistance <= alignmentTolerance;
  const confluence = {
    // Two independently active families are useful as MULTI_FAMILY even when
    // their levels are far apart. Reserve derived SMA/Fib confluence for the
    // stricter structural-alignment contract controlled by the tolerance.
    active: primitiveFamilies.length === 2 && structurallyAligned,
    primitive_families: primitiveFamilies,
    primitive_family_count: primitiveFamilies.length,
    sma_to_pocket_pct: roundMetric(smaToPocketDistance),
    structurally_aligned: structurallyAligned,
  };
  const activeConditions = conditionList(ma, fib, confluence);
  const exactConditionCount = Number(ma.touching === true)
    + Number(fib.touching === true)
    + Number(fib.inside);
  const candidateDistances = [ma.price_distance_pct, fib.price_distance_pct]
    .filter(finite);

  return {
    schema_version: SMA_FIB_ATTENTION_SCHEMA_VERSION,
    symbol,
    timeframe,
    profile: profile.label,
    observation_kind: String(observationKind),
    observed_at_ms: observedAtMs,
    data_bar_time_ms: dataAsOfTimeMs,
    bar_status: barClosed ? 'closed' : 'provisional',
    provisional: !barClosed,
    source,
    price: close,
    bar_range: barRange,
    criteria: {
      ma_buffer_pct: maBuffer,
      fib_buffer_pct: fibBuffer,
      alignment_tolerance_pct: alignmentTolerance,
    },
    ma,
    fib,
    confluence,
    active_conditions: activeConditions,
    priority: {
      primitive_family_count: primitiveFamilies.length,
      exact_condition_count: exactConditionCount,
      nearest_price_distance_pct: candidateDistances.length
        ? Math.min(...candidateDistances)
        : null,
    },
  };
}

function assertObservation(value, label) {
  if (value?.schema_version !== SMA_FIB_ATTENTION_SCHEMA_VERSION) {
    throw new TypeError(`${label} is not a ${SMA_FIB_ATTENTION_SCHEMA_VERSION} observation.`);
  }
}

function makeEvent(current, type, family, details = {}) {
  const fibIdentity = family === 'fib' ? current.fib.pair_id : null;
  return {
    schema_version: SMA_FIB_EVENT_SCHEMA_VERSION,
    type,
    family,
    symbol: current.symbol,
    timeframe: current.timeframe,
    profile: current.profile,
    observed_at_ms: current.observed_at_ms,
    data_bar_time_ms: current.data_bar_time_ms,
    provisional: current.provisional,
    event_key: [
      current.symbol,
      current.timeframe,
      family,
      type,
      current.data_bar_time_ms,
      fibIdentity ?? '-',
    ].join('|'),
    details,
  };
}

/**
 * Derive rising/falling edges between two observations.
 *
 * Passing no previous observation is bootstrap: current conditions remain
 * visible, but no transition event is fabricated.
 */
export function deriveSmaFibTransitions(previous, current) {
  assertObservation(current, 'current');
  if (previous === null || previous === undefined) return [];
  assertObservation(previous, 'previous');
  if (previous.symbol !== current.symbol || previous.timeframe !== current.timeframe) {
    throw new TypeError('previous and current observations must address the same symbol/timeframe.');
  }
  if (current.observed_at_ms < previous.observed_at_ms) {
    throw new TypeError('current observation cannot precede previous observation.');
  }

  const events = [];
  if (previous.ma.available && current.ma.available) {
    if (!previous.ma.active && current.ma.active) {
      events.push(makeEvent(current, 'ENTERED_MA_BUFFER', 'ma', {
        distance_pct: current.ma.price_distance_pct,
        level: current.ma.level,
      }));
    }
    if (previous.ma.active && !current.ma.active) {
      events.push(makeEvent(current, 'EXITED_MA_BUFFER', 'ma', {
        distance_pct: current.ma.price_distance_pct,
        level: current.ma.level,
      }));
    }
    if (previous.ma.touching !== true && current.ma.touching === true) {
      events.push(makeEvent(current, 'TOUCHED_MA', 'ma', { level: current.ma.level }));
    }
    if (previous.ma.relation === 'below' && current.ma.relation !== 'below') {
      events.push(makeEvent(current, 'CROSSED_MA_UP', 'ma', { level: current.ma.level }));
    }
    if (previous.ma.relation === 'above' && current.ma.relation !== 'above') {
      events.push(makeEvent(current, 'CROSSED_MA_DOWN', 'ma', { level: current.ma.level }));
    }
  }

  const samePair = previous.fib.available
    && current.fib.available
    && previous.fib.pair_id === current.fib.pair_id;
  const newPair = current.fib.available && !samePair;
  if (!previous.fib.available && current.fib.available) {
    events.push(makeEvent(current, 'FIB_PAIR_BECAME_ELIGIBLE', 'fib', {
      pair_id: current.fib.pair_id,
      pocket: current.fib.pocket,
    }));
  } else if (previous.fib.available && !current.fib.available) {
    events.push(makeEvent(current, 'FIB_PAIR_CLEARED', 'fib', {
      previous_pair_id: previous.fib.pair_id,
    }));
  } else if (previous.fib.available && current.fib.available && !samePair) {
    events.push(makeEvent(current, 'FIB_PAIR_BECAME_ELIGIBLE', 'fib', {
      pair_id: current.fib.pair_id,
      previous_pair_id: previous.fib.pair_id,
      pocket: current.fib.pocket,
    }));
  }

  if (samePair || newPair) {
    const previousFibActive = samePair && previous.fib.active;
    const previousFibInside = samePair && previous.fib.inside;
    const previousFibTouching = samePair && previous.fib.touching === true;
    if (!previousFibActive && current.fib.active) {
      events.push(makeEvent(current, 'ENTERED_FIB_BUFFER', 'fib', {
        distance_pct: current.fib.price_distance_pct,
        pocket: current.fib.pocket,
      }));
    }
    if (samePair && previous.fib.active && !current.fib.active) {
      events.push(makeEvent(current, 'EXITED_FIB_BUFFER', 'fib', {
        distance_pct: current.fib.price_distance_pct,
        pocket: current.fib.pocket,
      }));
    }
    if (!previousFibInside && current.fib.inside) {
      events.push(makeEvent(current, 'ENTERED_FIB_POCKET', 'fib', {
        pocket: current.fib.pocket,
      }));
    }
    if (samePair && previous.fib.inside && !current.fib.inside) {
      events.push(makeEvent(current, 'EXITED_FIB_POCKET', 'fib', {
        pocket: current.fib.pocket,
      }));
    }
    if (!previousFibTouching && current.fib.touching === true) {
      events.push(makeEvent(current, 'TOUCHED_FIB_POCKET', 'fib', {
        pocket: current.fib.pocket,
      }));
    }
  }

  if (!previous.confluence.active && current.confluence.active) {
    events.push(makeEvent(current, 'CONFLUENCE_ACTIVATED', 'derived', {
      primitive_families: current.confluence.primitive_families,
    }));
  }
  if (previous.confluence.active && !current.confluence.active) {
    events.push(makeEvent(current, 'CONFLUENCE_CLEARED', 'derived', {
      primitive_families: previous.confluence.primitive_families,
    }));
  }
  return events;
}

/** Deterministic, transparent priority ordering. */
export function rankSmaFibObservations(left, right) {
  const leftDistance = finite(left?.priority?.nearest_price_distance_pct)
    ? left.priority.nearest_price_distance_pct
    : Number.POSITIVE_INFINITY;
  const rightDistance = finite(right?.priority?.nearest_price_distance_pct)
    ? right.priority.nearest_price_distance_pct
    : Number.POSITIVE_INFINITY;
  return (right?.priority?.primitive_family_count ?? 0)
      - (left?.priority?.primitive_family_count ?? 0)
    || (right?.priority?.exact_condition_count ?? 0)
      - (left?.priority?.exact_condition_count ?? 0)
    || leftDistance - rightDistance
    || String(left?.symbol ?? '').localeCompare(String(right?.symbol ?? ''))
    || String(left?.timeframe ?? '').localeCompare(String(right?.timeframe ?? ''));
}

function normalizeStringList(value, label, transform = item => String(item)) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const result = [...new Set(value.map(item => transform(item)))];
  return result.length ? result : null;
}

/** Filter and rank observations with AND/OR condition semantics. */
export function querySmaFibObservations(observations, {
  symbols,
  timeframes,
  observationKinds,
  conditions,
  operator = 'or',
  minimumFamilyCount = 0,
  includeProvisional = true,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array.');
  observations.forEach((observation, index) => assertObservation(observation, `observations[${index}]`));
  const symbolFilter = normalizeStringList(symbols, 'symbols', item => normalizeSymbol(item));
  const timeframeFilter = normalizeStringList(
    timeframes,
    'timeframes',
    item => normalizeTimeframe(item),
  );
  const observationKindFilter = normalizeStringList(
    observationKinds,
    'observationKinds',
    item => String(item).trim().toLowerCase(),
  );
  if (observationKindFilter) {
    const unknownKinds = observationKindFilter
      .filter(kind => kind !== 'current' && kind !== 'last_closed');
    if (unknownKinds.length) {
      throw new TypeError(`Unknown observation kinds: ${unknownKinds.join(', ')}.`);
    }
  }
  const conditionFilter = normalizeStringList(
    conditions,
    'conditions',
    item => String(item).trim().toUpperCase(),
  );
  if (conditionFilter) {
    const unknown = conditionFilter.filter(condition => !CONDITION_SET.has(condition));
    if (unknown.length) throw new TypeError(`Unknown attention conditions: ${unknown.join(', ')}.`);
  }
  const normalizedOperator = String(operator).trim().toLowerCase();
  if (normalizedOperator !== 'and' && normalizedOperator !== 'or') {
    throw new TypeError('operator must be "and" or "or".');
  }
  if (!Number.isSafeInteger(minimumFamilyCount)
    || minimumFamilyCount < 0
    || minimumFamilyCount > 2) {
    throw new TypeError('minimumFamilyCount must be an integer from 0 to 2.');
  }
  if (typeof includeProvisional !== 'boolean') {
    throw new TypeError('includeProvisional must be boolean.');
  }

  return observations.filter(observation => {
    if (symbolFilter && !symbolFilter.includes(observation.symbol)) return false;
    if (timeframeFilter && !timeframeFilter.includes(observation.timeframe)) return false;
    if (observationKindFilter
      && !observationKindFilter.includes(observation.observation_kind)) return false;
    if (!includeProvisional && observation.provisional) return false;
    if (observation.confluence.primitive_family_count < minimumFamilyCount) return false;
    if (!conditionFilter || conditionFilter.length === 0) return true;
    const matches = conditionFilter.map(condition => observation.active_conditions.includes(condition));
    return normalizedOperator === 'and' ? matches.every(Boolean) : matches.some(Boolean);
  }).sort(rankSmaFibObservations);
}
