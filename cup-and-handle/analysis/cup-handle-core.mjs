const ACTIVE_STAGE_ORDER = Object.freeze({
  NONE: 0,
  CUP_FORMING: 1,
  RIM_APPROACH: 2,
  HANDLE_FORMING: 3,
  HANDLE_READY: 4,
  BREAKOUT_CONFIRMED: 5,
});

const TERMINAL_STAGES = new Set(['BREAKOUT_CONFIRMED', 'INVALIDATED', 'EXPIRED']);

const CONFIG_SIGNATURE_FIELDS = Object.freeze([
  ['lb', 'lookback_bars'],
  ['pl', 'pivot_left_bars'],
  ['pr', 'pivot_right_bars'],
  ['cmin', 'minimum_cup_bars'],
  ['cmax', 'maximum_cup_bars'],
  ['center', 'center_tolerance_fraction_of_half_width'],
  ['rim', 'rim_deviation_fraction_of_cup_height'],
  ['dmin', 'minimum_cup_depth_fraction_of_rim'],
  ['dmax', 'maximum_cup_depth_fraction_of_rim'],
  ['ushape', 'minimum_u_shape_score'],
  ['bottom', 'bottom_width_target_fraction'],
  ['forming', 'forming_recovery_fraction'],
  ['approach', 'rim_approach_recovery_fraction'],
  ['handle', 'maximum_handle_rollback_fraction_of_cup_height'],
  ['hmin', 'minimum_handle_bars'],
  ['pivots', 'maximum_pivots_per_kind'],
  ['trend', 'prior_trend_gate_enabled'],
]);

export const STAGES = Object.freeze([
  'NONE',
  'CUP_FORMING',
  'RIM_APPROACH',
  'HANDLE_FORMING',
  'HANDLE_READY',
  'BREAKOUT_CONFIRMED',
  'INVALIDATED',
  'EXPIRED',
]);

export const DEFAULT_CONFIG = Object.freeze({
  config_id: 'ch-v0-default',
  detector_version: '0.1.1-cleanroom',
  lookback_bars: 600,
  pivot_left_bars: 5,
  pivot_right_bars: 5,
  minimum_cup_bars: 20,
  maximum_cup_bars: 240,
  center_tolerance_fraction_of_half_width: 0.35,
  rim_deviation_fraction_of_cup_height: 0.15,
  minimum_cup_depth_fraction_of_rim: 0.08,
  maximum_cup_depth_fraction_of_rim: 0.5,
  minimum_u_shape_score: 0.5,
  bottom_width_target_fraction: 0.12,
  forming_recovery_fraction: 0.65,
  rim_approach_recovery_fraction: 0.85,
  maximum_handle_rollback_fraction_of_cup_height: 0.4,
  minimum_handle_bars: 3,
  prior_trend_gate_enabled: false,
  maximum_pivots_per_kind: 64,
});

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function integer(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function fraction(value, name, { inclusiveZero = false } = {}) {
  const lowerOkay = inclusiveZero ? value >= 0 : value > 0;
  if (!Number.isFinite(value) || !lowerOkay || value > 1) {
    throw new TypeError(`${name} must be ${inclusiveZero ? 'between 0 and 1' : '> 0 and <= 1'}`);
  }
  return value;
}

export function validateConfig(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('config must be an object');
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  integer(config.lookback_bars, 'lookback_bars', 20);
  integer(config.pivot_left_bars, 'pivot_left_bars', 1);
  integer(config.pivot_right_bars, 'pivot_right_bars', 1);
  integer(config.minimum_cup_bars, 'minimum_cup_bars', 2);
  integer(config.maximum_cup_bars, 'maximum_cup_bars', config.minimum_cup_bars);
  integer(config.minimum_handle_bars, 'minimum_handle_bars', 1);
  integer(config.maximum_pivots_per_kind, 'maximum_pivots_per_kind', 8);
  if (config.maximum_cup_bars >= config.lookback_bars) {
    throw new RangeError('maximum_cup_bars must be below lookback_bars');
  }
  fraction(config.center_tolerance_fraction_of_half_width, 'center_tolerance_fraction_of_half_width');
  fraction(config.rim_deviation_fraction_of_cup_height, 'rim_deviation_fraction_of_cup_height');
  fraction(config.minimum_cup_depth_fraction_of_rim, 'minimum_cup_depth_fraction_of_rim');
  fraction(config.maximum_cup_depth_fraction_of_rim, 'maximum_cup_depth_fraction_of_rim');
  fraction(config.minimum_u_shape_score, 'minimum_u_shape_score', { inclusiveZero: true });
  fraction(config.bottom_width_target_fraction, 'bottom_width_target_fraction');
  fraction(config.forming_recovery_fraction, 'forming_recovery_fraction');
  fraction(config.rim_approach_recovery_fraction, 'rim_approach_recovery_fraction');
  fraction(
    config.maximum_handle_rollback_fraction_of_cup_height,
    'maximum_handle_rollback_fraction_of_cup_height',
  );
  if (config.minimum_cup_depth_fraction_of_rim >= config.maximum_cup_depth_fraction_of_rim) {
    throw new RangeError('minimum cup depth must be below maximum cup depth');
  }
  if (config.forming_recovery_fraction >= config.rim_approach_recovery_fraction) {
    throw new RangeError('forming recovery must be below rim-approach recovery');
  }
  if (typeof config.config_id !== 'string' || !config.config_id.trim()) {
    throw new TypeError('config_id must be a non-empty string');
  }
  if (typeof config.detector_version !== 'string' || !config.detector_version.trim()) {
    throw new TypeError('detector_version must be a non-empty string');
  }
  if (typeof config.prior_trend_gate_enabled !== 'boolean') {
    throw new TypeError('prior_trend_gate_enabled must be boolean');
  }
  if (config.prior_trend_gate_enabled) {
    throw new RangeError('prior_trend_gate_enabled is not implemented in clean-room v0');
  }
  const baseConfigId = config.config_id.split('|settings:')[0];
  const signature = CONFIG_SIGNATURE_FIELDS
    .map(([label, key]) => `${label}=${String(config[key])}`)
    .join(',');
  config.config_id = `${baseConfigId}|settings:${signature}`;
  return Object.freeze(config);
}

export function normalizeTimeframe(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  const aliases = new Map([
    ['240', '4H'],
    ['4H', '4H'],
    ['D', '1D'],
    ['1D', '1D'],
    ['W', '1W'],
    ['1W', '1W'],
  ]);
  const timeframe = aliases.get(normalized);
  if (!timeframe) throw new RangeError('timeframe must be 4H, 1D, or 1W');
  return timeframe;
}

export function normalizeBars(rows) {
  if (!Array.isArray(rows)) throw new TypeError('bars must be an array');
  const bars = [];
  let previousTime = -Infinity;
  let sawIncompleteBar = false;
  for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex += 1) {
    const row = rows[sourceIndex];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`bar ${sourceIndex} must be an object`);
    }
    if (row.complete_bar === false) {
      sawIncompleteBar = true;
      continue;
    }
    if (sawIncompleteBar) {
      throw new RangeError('incomplete bars are only allowed as a terminal suffix');
    }
    const time = finiteNumber(row.time, `bar ${sourceIndex} time`);
    const timeClose = row.time_close === undefined || row.time_close === null
      ? null
      : finiteNumber(row.time_close, `bar ${sourceIndex} time_close`);
    const open = finiteNumber(row.open, `bar ${sourceIndex} open`);
    const high = finiteNumber(row.high, `bar ${sourceIndex} high`);
    const low = finiteNumber(row.low, `bar ${sourceIndex} low`);
    const close = finiteNumber(row.close, `bar ${sourceIndex} close`);
    if (time <= previousTime) {
      throw new RangeError(`bars must have unique, strictly increasing times; failed at source index ${sourceIndex}`);
    }
    if (timeClose !== null && timeClose <= time) {
      throw new RangeError(`bar ${sourceIndex} time_close must be after time`);
    }
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new RangeError(`bar ${sourceIndex} has invalid OHLC bounds`);
    }
    bars.push({
      index: bars.length,
      time,
      time_close: timeClose,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(row.volume) ? row.volume : null,
    });
    previousTime = time;
  }
  return bars;
}

function isPivotHigh(bars, index, left, right) {
  const price = bars[index].high;
  for (let offset = 1; offset <= left; offset += 1) {
    if (bars[index - offset].high > price) return false;
  }
  // Equal highs on the right suppress this point, selecting the rightmost point
  // of a plateau deterministically.
  for (let offset = 1; offset <= right; offset += 1) {
    if (bars[index + offset].high >= price) return false;
  }
  return true;
}

function isPivotLow(bars, index, left, right) {
  const price = bars[index].low;
  for (let offset = 1; offset <= left; offset += 1) {
    if (bars[index - offset].low < price) return false;
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (bars[index + offset].low <= price) return false;
  }
  return true;
}

export function findConfirmedPivots(rows, configOverrides = {}) {
  const config = validateConfig(configOverrides);
  const bars = rows.length > 0 && Number.isInteger(rows[0]?.index) ? rows : normalizeBars(rows);
  const highs = [];
  const lows = [];
  const left = config.pivot_left_bars;
  const right = config.pivot_right_bars;
  for (let index = left; index + right < bars.length; index += 1) {
    const confirmedIndex = index + right;
    if (isPivotHigh(bars, index, left, right)) {
      highs.push({
        kind: 'high',
        index,
        time: bars[index].time,
        price: bars[index].high,
        confirmed_index: confirmedIndex,
        confirmed_time: bars[confirmedIndex].time,
      });
    }
    if (isPivotLow(bars, index, left, right)) {
      lows.push({
        kind: 'low',
        index,
        time: bars[index].time,
        price: bars[index].low,
        confirmed_index: confirmedIndex,
        confirmed_time: bars[confirmedIndex].time,
      });
    }
  }
  return { highs, lows };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function minimumLow(bars, startIndex, endIndex) {
  if (startIndex > endIndex) return null;
  let value = Infinity;
  for (let index = startIndex; index <= endIndex; index += 1) {
    value = Math.min(value, bars[index].low);
  }
  return Number.isFinite(value) ? value : null;
}

function lineValue(pointA, pointB, index) {
  const span = pointB.index - pointA.index;
  if (span <= 0) return pointB.price;
  return pointA.price + ((pointB.price - pointA.price) * (index - pointA.index)) / span;
}

export function computeUShapeScore(bars, p1, p2, p3, configOverrides = {}) {
  const config = validateConfig(configOverrides);
  return computeUShapeScoreWithConfig(bars, p1, p2, p3, config);
}

function computeUShapeScoreWithConfig(bars, p1, p2, p3, config) {
  const width = p3.index - p1.index;
  const rim = (p1.price + p3.price) / 2;
  const cupHeight = rim - p2.price;
  if (width <= 0 || cupHeight <= 0) return 0;
  let absoluteError = 0;
  let samples = 0;
  let bottomSamples = 0;
  for (let index = p1.index; index <= p3.index; index += 1) {
    const x = (index - p1.index) / width;
    const idealDepth = 1 - (2 * x - 1) ** 2;
    const bar = bars[index];
    const representativePrice = (bar.high + bar.low + bar.close) / 3;
    const observedDepth = clamp((rim - representativePrice) / cupHeight, -0.25, 1.25);
    absoluteError += Math.abs(observedDepth - idealDepth);
    samples += 1;
    if (observedDepth >= 0.75) bottomSamples += 1;
  }
  const fitScore = clamp(1 - absoluteError / Math.max(samples, 1), 0, 1);
  const bottomWidthFraction = bottomSamples / Math.max(samples, 1);
  const bottomWidthScore = clamp(bottomWidthFraction / config.bottom_width_target_fraction, 0, 1);
  return clamp(0.8 * fitScore + 0.2 * bottomWidthScore, 0, 1);
}

function chooseBottomPivot(lows, p1, p3, config) {
  const midpoint = (p1.index + p3.index) / 2;
  const halfWidth = (p3.index - p1.index) / 2;
  const eligible = lows.filter((pivot) => (
    pivot.index > p1.index
    && pivot.index < p3.index
    && Math.abs(pivot.index - midpoint) / halfWidth
      <= config.center_tolerance_fraction_of_half_width
  ));
  eligible.sort((a, b) => a.price - b.price || a.index - b.index);
  return eligible[0] ?? null;
}

function cupMetrics(bars, p1, p2, p3, config, { provisional = false } = {}) {
  const cupWidth = p3.index - p1.index;
  const leftWidth = p2.index - p1.index;
  const rightWidth = p3.index - p2.index;
  const rim = (p1.price + p3.price) / 2;
  const cupHeight = rim - p2.price;
  const centerError = Math.abs(p2.index - (p1.index + p3.index) / 2) / (cupWidth / 2);
  const depthFraction = cupHeight / Math.max(Math.abs(rim), Number.EPSILON);
  const rimError = Math.abs(p1.price - p3.price) / Math.max(cupHeight, Number.EPSILON);
  const symmetryScore = clamp(1 - Math.abs(leftWidth - rightWidth) / Math.max(cupWidth, 1), 0, 1);
  const uShapeScore = computeUShapeScoreWithConfig(bars, p1, p2, p3, config);
  const rejectionReasons = [];
  if (cupWidth < config.minimum_cup_bars) rejectionReasons.push('CUP_TOO_SHORT');
  if (cupWidth > config.maximum_cup_bars) rejectionReasons.push('CUP_TOO_LONG');
  if (leftWidth <= 0 || rightWidth <= 0) rejectionReasons.push('BOTTOM_OUTSIDE_CUP');
  if (centerError > config.center_tolerance_fraction_of_half_width) {
    rejectionReasons.push('BOTTOM_OFF_CENTER');
  }
  if (!(cupHeight > 0)) rejectionReasons.push('NONPOSITIVE_CUP_HEIGHT');
  if (rimError > config.rim_deviation_fraction_of_cup_height) {
    rejectionReasons.push('RIMS_MISALIGNED');
  }
  if (depthFraction < config.minimum_cup_depth_fraction_of_rim) {
    rejectionReasons.push('CUP_TOO_SHALLOW');
  }
  if (depthFraction > config.maximum_cup_depth_fraction_of_rim) {
    rejectionReasons.push('CUP_TOO_DEEP');
  }
  if (uShapeScore < config.minimum_u_shape_score) rejectionReasons.push('NOT_U_SHAPED');

  const rimScore = clamp(1 - rimError / config.rim_deviation_fraction_of_cup_height, 0, 1);
  const centerScore = clamp(
    1 - centerError / config.center_tolerance_fraction_of_half_width,
    0,
    1,
  );
  const depthMidpoint = (
    config.minimum_cup_depth_fraction_of_rim + config.maximum_cup_depth_fraction_of_rim
  ) / 2;
  const depthHalfRange = (
    config.maximum_cup_depth_fraction_of_rim - config.minimum_cup_depth_fraction_of_rim
  ) / 2;
  const depthScore = clamp(1 - Math.abs(depthFraction - depthMidpoint) / depthHalfRange, 0, 1);
  const qualityScore = Math.round(100 * (
    0.4 * uShapeScore
    + 0.2 * rimScore
    + 0.15 * centerScore
    + 0.15 * symmetryScore
    + 0.1 * depthScore
  ));
  return {
    valid: rejectionReasons.length === 0,
    provisional,
    cup_width_bars: cupWidth,
    left_width_bars: leftWidth,
    right_width_bars: rightWidth,
    rim,
    cup_height: cupHeight,
    depth_fraction: depthFraction,
    rim_error: rimError,
    center_error: centerError,
    symmetry_score: symmetryScore,
    u_shape_score: uShapeScore,
    quality_score: qualityScore,
    rejection_reasons: rejectionReasons,
  };
}

function identityPart(value) {
  return String(value).replaceAll('|', '_');
}

function familyId(symbol, timeframe, p1, p2, config) {
  return [
    config.detector_version,
    config.config_id,
    identityPart(symbol),
    timeframe,
    p1.time,
    p2.time,
  ].join('|');
}

function provisionalPatternId(patternFamilyId) {
  return `${patternFamilyId}|p3=pending`;
}

function confirmedPatternId(patternFamilyId, p3) {
  return `${patternFamilyId}|p3=${p3.time}`;
}

function eventId(patternId, stage, detectionTime, config) {
  return [patternId, stage, detectionTime, config.config_id].join('|');
}

function anchor(pivot) {
  if (!pivot) return null;
  return {
    index: pivot.index,
    time: pivot.time,
    price: pivot.price,
    confirmed_index: pivot.confirmed_index ?? null,
    confirmed_time: pivot.confirmed_time ?? null,
  };
}

function activeRank(stage) {
  return ACTIVE_STAGE_ORDER[stage] ?? -1;
}

function compareCandidates(a, b) {
  const stageDifference = activeRank(b.stage) - activeRank(a.stage);
  if (stageDifference !== 0) return stageDifference;
  if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
  if (b.anchors.left_rim.time !== a.anchors.left_rim.time) {
    return b.anchors.left_rim.time - a.anchors.left_rim.time;
  }
  return a.pattern_id.localeCompare(b.pattern_id);
}

function confirmedCandidatesAt({ bars, pivots, barIndex, symbol, timeframe, config, locks }) {
  const cutoff = Math.max(0, barIndex - config.lookback_bars + 1);
  const highs = pivots.highs
    .filter((pivot) => pivot.confirmed_index <= barIndex && pivot.index >= cutoff)
    .slice(-config.maximum_pivots_per_kind);
  const lows = pivots.lows
    .filter((pivot) => pivot.confirmed_index <= barIndex && pivot.index >= cutoff)
    .slice(-config.maximum_pivots_per_kind);
  const candidates = [];

  for (let rightIndex = 0; rightIndex < highs.length; rightIndex += 1) {
    const p3 = highs[rightIndex];
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const p1 = highs[leftIndex];
      const width = p3.index - p1.index;
      if (width < config.minimum_cup_bars || width > config.maximum_cup_bars) continue;
      const p2 = chooseBottomPivot(lows, p1, p3, config);
      if (!p2) continue;
      const metrics = cupMetrics(bars, p1, p2, p3, config);
      if (!metrics.valid) continue;
      const patternFamilyId = familyId(symbol, timeframe, p1, p2, config);
      const patternId = confirmedPatternId(patternFamilyId, p3);
      const locked = locks.get(patternId);
      if (locked && locked.p3.index !== p3.index) continue;
      const handle = deriveHandleState({
        bars,
        pivots,
        barIndex,
        p3,
        metrics,
        config,
        lockedP4: locked?.p4 ?? null,
      });
      candidates.push({
        schema_version: 'cup-handle-observation-v0',
        detector_version: config.detector_version,
        config_id: config.config_id,
        symbol,
        timeframe,
        pattern_id: patternId,
        family_id: patternFamilyId,
        stage: handle.stage,
        provisional: false,
        detection_index: barIndex,
        detection_bar_open_time: bars[barIndex].time,
        detection_bar_close_time: bars[barIndex].time_close,
        first_known_index: Math.max(p1.confirmed_index, p2.confirmed_index, p3.confirmed_index),
        first_known_time: bars[Math.max(p1.confirmed_index, p2.confirmed_index, p3.confirmed_index)].time,
        quality_score: metrics.quality_score,
        reasons: handle.reasons,
        anchors: {
          left_rim: anchor(p1),
          cup_bottom: anchor(p2),
          right_rim: anchor(p3),
          handle: anchor(handle.p4),
          breakout: handle.breakout_anchor,
        },
        levels: {
          rim: metrics.rim,
          pivot: handle.handle_line,
          invalidation: handle.invalidation_level,
          target: handle.target_level,
        },
        metrics: {
          cup_width_bars: metrics.cup_width_bars,
          cup_height: metrics.cup_height,
          depth_fraction: metrics.depth_fraction,
          rim_error: metrics.rim_error,
          center_error: metrics.center_error,
          symmetry_score: metrics.symmetry_score,
          u_shape_score: metrics.u_shape_score,
          handle_age_bars: handle.handle_age_bars,
          handle_rollback_fraction: handle.handle_rollback_fraction,
        },
        already_broken_when_discovered: handle.already_broken_when_discovered,
        _p1: p1,
        _p2: p2,
        _p3: p3,
        _p4: handle.p4,
      });
    }
  }
  return candidates;
}

function deriveHandleState({ bars, pivots, barIndex, p3, metrics, config, lockedP4 }) {
  const handleAge = barIndex - p3.index;
  const handleLow = minimumLow(bars, p3.index + 1, barIndex);
  const rollback = handleLow === null
    ? 0
    : (p3.price - handleLow) / Math.max(metrics.cup_height, Number.EPSILON);
  const invalidationLevel = p3.price
    - metrics.cup_height * config.maximum_handle_rollback_fraction_of_cup_height;
  if (handleAge > metrics.cup_width_bars) {
    return {
      stage: 'EXPIRED',
      reasons: ['HANDLE_OUTLIVED_CUP'],
      p4: lockedP4,
      handle_age_bars: handleAge,
      handle_rollback_fraction: rollback,
      invalidation_level: invalidationLevel,
      handle_line: null,
      target_level: null,
      breakout_anchor: null,
      already_broken_when_discovered: false,
    };
  }
  if (handleLow !== null && handleLow < invalidationLevel) {
    return {
      stage: 'INVALIDATED',
      reasons: ['HANDLE_ROLLBACK_EXCEEDED'],
      p4: lockedP4,
      handle_age_bars: handleAge,
      handle_rollback_fraction: rollback,
      invalidation_level: invalidationLevel,
      handle_line: null,
      target_level: null,
      breakout_anchor: null,
      already_broken_when_discovered: false,
    };
  }

  let p4 = lockedP4;
  if (!p4) {
    const handleHighs = pivots.highs.filter((pivot) => (
      pivot.confirmed_index <= barIndex
      && pivot.index - p3.index >= config.minimum_handle_bars
      && pivot.price <= p3.price
      && pivot.index <= barIndex
    ));
    for (let index = handleHighs.length - 1; index >= 0; index -= 1) {
      const candidate = handleHighs[index];
      const beforeLow = minimumLow(bars, p3.index + 1, candidate.index);
      const afterLow = minimumLow(bars, candidate.index + 1, barIndex);
      if (beforeLow !== null && afterLow !== null && beforeLow > afterLow) {
        p4 = candidate;
        break;
      }
    }
  }

  if (!p4 && barIndex > p3.index && bars[barIndex].close > p3.price) {
    return {
      stage: 'INVALIDATED',
      reasons: ['PRE_HANDLE_UPSIDE_ESCAPE'],
      p4: null,
      handle_age_bars: handleAge,
      handle_rollback_fraction: rollback,
      invalidation_level: invalidationLevel,
      handle_line: null,
      target_level: null,
      breakout_anchor: null,
      already_broken_when_discovered: false,
    };
  }

  if (!p4 || handleAge < config.minimum_handle_bars) {
    return {
      stage: 'HANDLE_FORMING',
      reasons: ['CONFIRMED_CUP', 'HANDLE_NOT_READY'],
      p4: null,
      handle_age_bars: handleAge,
      handle_rollback_fraction: rollback,
      invalidation_level: invalidationLevel,
      handle_line: null,
      target_level: null,
      breakout_anchor: null,
      already_broken_when_discovered: false,
    };
  }

  const currentLine = lineValue(p3, p4, barIndex);
  const previousLine = lineValue(p3, p4, Math.max(p4.index, barIndex - 1));
  const currentAbove = bars[barIndex].close > currentLine;
  const previousAbove = barIndex > p4.index && bars[barIndex - 1].close > previousLine;
  const breakout = currentAbove && (!previousAbove || barIndex === p4.confirmed_index);
  return {
    stage: breakout ? 'BREAKOUT_CONFIRMED' : 'HANDLE_READY',
    reasons: breakout ? ['CLOSE_ABOVE_HANDLE_LINE'] : ['HANDLE_GEOMETRY_READY'],
    p4,
    handle_age_bars: handleAge,
    handle_rollback_fraction: rollback,
    invalidation_level: invalidationLevel,
    handle_line: currentLine,
    target_level: currentLine + metrics.cup_height,
    breakout_anchor: breakout
      ? { index: barIndex, time: bars[barIndex].time, price: bars[barIndex].close }
      : null,
    already_broken_when_discovered: breakout && barIndex === p4.confirmed_index,
  };
}

function approachCandidatesAt({ bars, pivots, barIndex, symbol, timeframe, config, confirmedIds }) {
  const cutoff = Math.max(0, barIndex - config.lookback_bars + 1);
  const highs = pivots.highs
    .filter((pivot) => pivot.confirmed_index <= barIndex && pivot.index >= cutoff)
    .slice(-config.maximum_pivots_per_kind);
  const lows = pivots.lows
    .filter((pivot) => pivot.confirmed_index <= barIndex && pivot.index >= cutoff)
    .slice(-config.maximum_pivots_per_kind);
  const candidates = [];
  const provisionalP3 = {
    kind: 'provisional_high',
    index: barIndex,
    time: bars[barIndex].time,
    price: bars[barIndex].high,
    confirmed_index: null,
    confirmed_time: null,
  };

  for (const p1 of highs) {
    const width = barIndex - p1.index;
    if (width < config.minimum_cup_bars || width > config.maximum_cup_bars) continue;
    const p2 = chooseBottomPivot(lows, p1, provisionalP3, config);
    if (!p2) continue;
    const metrics = cupMetrics(bars, p1, p2, provisionalP3, config, { provisional: true });
    const heightFromLeftRim = p1.price - p2.price;
    if (!(heightFromLeftRim > 0)) continue;
    const recovery = (provisionalP3.price - p2.price) / heightFromLeftRim;
    const permittedOvershoot = heightFromLeftRim * config.rim_deviation_fraction_of_cup_height;
    if (provisionalP3.price > p1.price + permittedOvershoot) continue;
    const structuralRejections = metrics.rejection_reasons.filter((reason) => reason !== 'RIMS_MISALIGNED');
    if (structuralRejections.length > 0 || recovery < config.forming_recovery_fraction) continue;
    const patternFamilyId = familyId(symbol, timeframe, p1, p2, config);
    const patternId = provisionalPatternId(patternFamilyId);
    if (confirmedIds.has(patternFamilyId)) continue;
    const stage = recovery >= config.rim_approach_recovery_fraction
      ? 'RIM_APPROACH'
      : 'CUP_FORMING';
    candidates.push({
      schema_version: 'cup-handle-observation-v0',
      detector_version: config.detector_version,
      config_id: config.config_id,
      symbol,
      timeframe,
      pattern_id: patternId,
      family_id: patternFamilyId,
      stage,
      provisional: true,
      detection_index: barIndex,
      detection_bar_open_time: bars[barIndex].time,
      detection_bar_close_time: bars[barIndex].time_close,
      first_known_index: Math.max(p1.confirmed_index, p2.confirmed_index),
      first_known_time: bars[Math.max(p1.confirmed_index, p2.confirmed_index)].time,
      quality_score: metrics.quality_score,
      reasons: stage === 'RIM_APPROACH'
        ? ['RIGHT_SIDE_NEAR_LEFT_RIM']
        : ['RIGHT_SIDE_RECOVERING'],
      anchors: {
        left_rim: anchor(p1),
        cup_bottom: anchor(p2),
        right_rim: anchor(provisionalP3),
        handle: null,
        breakout: null,
      },
      levels: {
        rim: p1.price,
        pivot: p1.price,
        invalidation: null,
        target: null,
      },
      metrics: {
        cup_width_bars: metrics.cup_width_bars,
        cup_height: heightFromLeftRim,
        depth_fraction: metrics.depth_fraction,
        rim_error: metrics.rim_error,
        center_error: metrics.center_error,
        symmetry_score: metrics.symmetry_score,
        u_shape_score: metrics.u_shape_score,
        right_side_recovery_fraction: recovery,
        handle_age_bars: 0,
        handle_rollback_fraction: 0,
      },
      already_broken_when_discovered: false,
      _p1: p1,
      _p2: p2,
      _p3: null,
      _p4: null,
    });
  }
  return candidates;
}

function publicObservation(pattern) {
  if (!pattern) return null;
  const {
    _p1,
    _p2,
    _p3,
    _p4,
    ...observation
  } = pattern;
  return observation;
}

export function detectCupAndHandle({
  bars: rows,
  symbol,
  timeframe,
  config: configOverrides = {},
}) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TypeError('symbol must be a non-empty exchange-qualified string');
  }
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const config = validateConfig(configOverrides);
  const bars = normalizeBars(rows);
  const pivots = findConfirmedPivots(bars, config);
  const minimumHistory = config.pivot_left_bars
    + config.minimum_cup_bars
    + config.pivot_right_bars
    + 1;
  const transitions = [];
  const latestById = new Map();
  const stageById = new Map();
  const locks = new Map();
  const completedFamilyIds = new Set();
  let activePatternId = null;

  for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
    if (barIndex + 1 < minimumHistory) continue;
    const confirmed = confirmedCandidatesAt({
      bars,
      pivots,
      barIndex,
      symbol: symbol.trim(),
      timeframe: normalizedTimeframe,
      config,
      locks,
    });
    const confirmedIds = new Set(
      confirmed
        .filter((candidate) => !TERMINAL_STAGES.has(candidate.stage))
        .map((candidate) => candidate.family_id),
    );
    const approaches = approachCandidatesAt({
      bars,
      pivots,
      barIndex,
      symbol: symbol.trim(),
      timeframe: normalizedTimeframe,
      config,
      confirmedIds,
    });
    const allCandidates = [...confirmed, ...approaches]
      .filter((candidate) => !completedFamilyIds.has(candidate.family_id));
    let selected = activePatternId
      ? allCandidates.find((candidate) => candidate.pattern_id === activePatternId)
      : null;
    if (!selected && activePatternId) {
      const activeObservation = latestById.get(activePatternId);
      if (activeObservation?.provisional) {
        selected = allCandidates
          .filter((candidate) => candidate.family_id === activeObservation.family_id)
          .sort(compareCandidates)[0] ?? null;
      }
    }
    if (activePatternId && !selected) {
      const previousObservation = latestById.get(activePatternId);
      const previousStage = stageById.get(activePatternId) ?? 'NONE';
      const terminalStage = 'INVALIDATED';
      const transition = {
        schema_version: 'cup-handle-transition-v0',
        detector_version: config.detector_version,
        config_id: config.config_id,
        event_id: eventId(activePatternId, terminalStage, bars[barIndex].time, config),
        pattern_id: activePatternId,
        family_id: previousObservation?.family_id ?? null,
        symbol: symbol.trim(),
        timeframe: normalizedTimeframe,
        from_stage: previousStage,
        to_stage: terminalStage,
        detection_index: barIndex,
        detection_bar_open_time: bars[barIndex].time,
        detection_bar_close_time: bars[barIndex].time_close,
        provisional: previousObservation?.provisional ?? true,
        pivot: previousObservation?.levels.pivot ?? null,
        invalidation: previousObservation?.levels.invalidation ?? null,
        quality_score: previousObservation?.quality_score ?? null,
        already_broken_when_discovered: false,
        anchors: previousObservation?.anchors ?? null,
      };
      transitions.push(transition);
      stageById.set(activePatternId, terminalStage);
      latestById.set(activePatternId, {
        ...previousObservation,
        stage: terminalStage,
        reasons: ['ACTIVE_GEOMETRY_NO_LONGER_VALID'],
        detection_index: barIndex,
        detection_bar_open_time: bars[barIndex].time,
        detection_bar_close_time: bars[barIndex].time_close,
        last_transition: transition,
      });
      activePatternId = null;
      continue;
    }
    if (!selected) {
      selected = allCandidates
        .filter((candidate) => (
          !TERMINAL_STAGES.has(candidate.stage)
          && !TERMINAL_STAGES.has(stageById.get(candidate.pattern_id))
        ))
        .sort(compareCandidates)[0] ?? null;
    }
    if (!selected) {
      activePatternId = null;
      continue;
    }

    const activeObservation = activePatternId ? latestById.get(activePatternId) : null;
    const isPromotion = Boolean(
      activeObservation?.provisional
      && !selected.provisional
      && activeObservation.family_id === selected.family_id,
    );
    const previousStage = isPromotion
      ? activeObservation.stage
      : stageById.get(selected.pattern_id) ?? 'NONE';
    const previousObservation = isPromotion
      ? activeObservation
      : latestById.get(selected.pattern_id) ?? null;
    if (isPromotion) {
      stageById.set(activePatternId, 'EXPIRED');
      latestById.delete(activePatternId);
    }
    const isTerminal = TERMINAL_STAGES.has(selected.stage);
    const progressed = isTerminal
      ? !TERMINAL_STAGES.has(previousStage)
      : activeRank(selected.stage) > activeRank(previousStage);

    if (!isTerminal && activeRank(selected.stage) < activeRank(previousStage)) {
      selected = {
        ...selected,
        stage: previousStage,
        anchors: previousObservation?.anchors ?? selected.anchors,
        levels: { ...selected.levels, ...previousObservation?.levels },
      };
    }

    if (selected._p3 && !locks.has(selected.pattern_id)) {
      locks.set(selected.pattern_id, { p3: selected._p3, p4: null });
    }
    if (selected._p4) {
      const locked = locks.get(selected.pattern_id) ?? { p3: selected._p3, p4: null };
      if (!locked.p4) locks.set(selected.pattern_id, { ...locked, p4: selected._p4 });
    }

    if (progressed) {
      const transition = {
        schema_version: 'cup-handle-transition-v0',
        detector_version: config.detector_version,
        config_id: config.config_id,
        event_id: eventId(selected.pattern_id, selected.stage, bars[barIndex].time, config),
        pattern_id: selected.pattern_id,
        family_id: selected.family_id,
        symbol: symbol.trim(),
        timeframe: normalizedTimeframe,
        from_stage: previousStage,
        to_stage: selected.stage,
        detection_index: barIndex,
        detection_bar_open_time: bars[barIndex].time,
        detection_bar_close_time: bars[barIndex].time_close,
        provisional: selected.provisional,
        pivot: selected.levels.pivot,
        invalidation: selected.levels.invalidation,
        quality_score: selected.quality_score,
        already_broken_when_discovered: selected.already_broken_when_discovered,
        anchors: selected.anchors,
      };
      transitions.push(transition);
      stageById.set(selected.pattern_id, selected.stage);
      if (selected.stage === 'BREAKOUT_CONFIRMED') {
        completedFamilyIds.add(selected.family_id);
      }
      selected = { ...selected, last_transition: transition };
    } else if (previousStage !== 'NONE') {
      selected = { ...selected, stage: previousStage };
    }
    if (!previousObservation) {
      selected = {
        ...selected,
        first_seen_index: barIndex,
        first_seen_time: bars[barIndex].time,
      };
    } else {
      selected = {
        ...selected,
        first_seen_index: previousObservation.first_seen_index,
        first_seen_time: previousObservation.first_seen_time,
      };
    }
    latestById.set(selected.pattern_id, selected);
    activePatternId = isTerminal ? null : selected.pattern_id;
  }

  const patterns = [...latestById.values()]
    .map(publicObservation)
    .sort((a, b) => a.first_seen_time - b.first_seen_time || a.pattern_id.localeCompare(b.pattern_id));
  const currentPattern = activePatternId ? publicObservation(latestById.get(activePatternId)) : null;
  return {
    schema_version: 'cup-handle-detection-result-v0',
    detector_version: config.detector_version,
    config_id: config.config_id,
    symbol: symbol.trim(),
    timeframe: normalizedTimeframe,
    closed_bars: bars.length,
    pivots: {
      highs: pivots.highs.map(anchor),
      lows: pivots.lows.map(anchor),
    },
    patterns,
    transitions,
    current_pattern: currentPattern,
  };
}
