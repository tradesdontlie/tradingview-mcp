import {
  SMA_FIB_ATTENTION_CONDITIONS,
  SMA_FIB_ATTENTION_SCHEMA_VERSION,
} from './sma-fib-attention.js';
import {
  RSI_ATTENTION_SCHEMA_VERSION,
  RSI_BULLISH_CONDITIONS,
} from './rsi-attention.js';

export const ATTENTION_CARD_SCHEMA_VERSION = 'investment-attention-card/v1';

const CONDITION_SET = new Set([
  ...SMA_FIB_ATTENTION_CONDITIONS,
  ...RSI_BULLISH_CONDITIONS,
]);
const FAMILY_SET = new Set(['ma', 'fib', 'rsi']);
const RSI_KIND_SET = new Set(['regular', 'hidden']);
const RSI_STAGE_SET = new Set([
  'WATCH',
  'DEVELOPING_ACTIVE',
  'NEW_DEVELOPING',
  'CONFIRMED',
]);

function normalizeSymbol(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!result) throw new TypeError('symbol must be a non-empty string.');
  return result;
}

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw new TypeError(`Unsupported timeframe: ${value}`);
}

function normalizeList(value, label, transform) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const result = [...new Set(value.map(transform))];
  return result.length ? result : null;
}

function routeBarKey(observation) {
  return [
    normalizeSymbol(observation.symbol),
    normalizeTimeframe(observation.timeframe),
    observation.observation_kind,
    observation.data_bar_time_ms,
  ].join('|');
}

function assertCommonObservation(observation, label) {
  if (!observation || typeof observation !== 'object') {
    throw new TypeError(`${label} must be an observation object.`);
  }
  normalizeSymbol(observation.symbol);
  normalizeTimeframe(observation.timeframe);
  if (observation.observation_kind !== 'current'
    && observation.observation_kind !== 'last_closed') {
    throw new TypeError(`${label} has an unsupported observation kind.`);
  }
  if (!Number.isSafeInteger(observation.data_bar_time_ms)
    || observation.data_bar_time_ms <= 0) {
    throw new TypeError(`${label} needs a positive data_bar_time_ms.`);
  }
  if (!Array.isArray(observation.active_conditions)) {
    throw new TypeError(`${label} needs active_conditions.`);
  }
}

function rsiStageScore(observation) {
  if (!observation) return 0;
  return {
    NONE: 0,
    WATCH: 1,
    DEVELOPING_ACTIVE: 2,
    NEW_DEVELOPING: 3,
    CONFIRMED: 4,
  }[observation.highest_stage] ?? 0;
}

function exactConditionCount(smaFib) {
  if (!smaFib) return 0;
  return Number(smaFib.ma?.touching === true)
    + Number(smaFib.fib?.touching === true)
    + Number(smaFib.fib?.inside === true);
}

function nearestDistance(smaFib) {
  if (!smaFib) return null;
  const candidates = [
    smaFib.ma?.price_distance_pct,
    smaFib.fib?.price_distance_pct,
  ].filter(value => typeof value === 'number' && Number.isFinite(value));
  return candidates.length ? Math.min(...candidates) : null;
}

function buildCard(entry) {
  const smaFib = entry.sma_fib ?? null;
  const rsi = entry.rsi ?? null;
  const primitiveFamilies = [
    ...(smaFib?.ma?.active ? ['ma'] : []),
    ...(smaFib?.fib?.active ? ['fib'] : []),
    ...(rsi?.active ? ['rsi'] : []),
  ];
  const conditions = [...new Set([
    ...(smaFib?.active_conditions ?? []),
    ...(rsi?.active_conditions ?? []),
  ])].sort();
  const provisional = Boolean(smaFib?.provisional || rsi?.provisional);
  const observedAtMs = Math.max(
    smaFib?.observed_at_ms ?? 0,
    rsi?.observed_at_ms ?? 0,
  );
  return {
    schema_version: ATTENTION_CARD_SCHEMA_VERSION,
    symbol: normalizeSymbol(smaFib?.symbol ?? rsi.symbol),
    timeframe: normalizeTimeframe(smaFib?.timeframe ?? rsi.timeframe),
    observation_kind: smaFib?.observation_kind ?? rsi.observation_kind,
    data_bar_time_ms: smaFib?.data_bar_time_ms ?? rsi.data_bar_time_ms,
    observed_at_ms: observedAtMs,
    provisional,
    sources_present: [
      ...(smaFib ? ['sma_fib'] : []),
      ...(rsi ? ['rsi'] : []),
    ],
    observations: {
      sma_fib: smaFib,
      rsi,
    },
    active_conditions: conditions,
    primitive_families: primitiveFamilies,
    primitive_family_count: primitiveFamilies.length,
    derived_confluence: {
      sma_fib_active: Boolean(smaFib?.confluence?.active),
      three_family_active: primitiveFamilies.length === 3,
    },
    priority: {
      primitive_family_count: primitiveFamilies.length,
      rsi_stage_score: rsiStageScore(rsi),
      exact_condition_count: exactConditionCount(smaFib),
      nearest_price_distance_pct: nearestDistance(smaFib),
    },
  };
}

/**
 * Join independently collected signal observations only when they describe the
 * exact same symbol, timeframe, observation kind, and target bar. A stale RSI
 * row is therefore never presented as simultaneous confluence with a newer MA
 * or Fib row.
 */
export function buildAttentionCards({
  smaFibObservations = [],
  rsiObservations = [],
} = {}) {
  if (!Array.isArray(smaFibObservations) || !Array.isArray(rsiObservations)) {
    throw new TypeError('attention observations must be arrays.');
  }
  const entries = new Map();
  const add = (observation, family, schema, label) => {
    assertCommonObservation(observation, label);
    if (observation.schema_version !== schema) {
      throw new TypeError(`${label} uses an unsupported schema version.`);
    }
    const key = routeBarKey(observation);
    const entry = entries.get(key) ?? {};
    if (entry[family]) {
      throw new Error(`duplicate ${family} observation for ${key}.`);
    }
    entry[family] = observation;
    entries.set(key, entry);
  };
  smaFibObservations.forEach((observation, index) => add(
    observation,
    'sma_fib',
    SMA_FIB_ATTENTION_SCHEMA_VERSION,
    `smaFibObservations[${index}]`,
  ));
  rsiObservations.forEach((observation, index) => add(
    observation,
    'rsi',
    RSI_ATTENTION_SCHEMA_VERSION,
    `rsiObservations[${index}]`,
  ));
  return [...entries.values()].map(buildCard).sort(rankAttentionCards);
}

export function rankAttentionCards(left, right) {
  const leftDistance = Number.isFinite(left?.priority?.nearest_price_distance_pct)
    ? left.priority.nearest_price_distance_pct
    : Number.POSITIVE_INFINITY;
  const rightDistance = Number.isFinite(right?.priority?.nearest_price_distance_pct)
    ? right.priority.nearest_price_distance_pct
    : Number.POSITIVE_INFINITY;
  return (right?.priority?.primitive_family_count ?? 0)
      - (left?.priority?.primitive_family_count ?? 0)
    || (right?.priority?.rsi_stage_score ?? 0) - (left?.priority?.rsi_stage_score ?? 0)
    || (right?.priority?.exact_condition_count ?? 0)
      - (left?.priority?.exact_condition_count ?? 0)
    || leftDistance - rightDistance
    || String(left?.symbol ?? '').localeCompare(String(right?.symbol ?? ''))
    || String(left?.timeframe ?? '').localeCompare(String(right?.timeframe ?? ''));
}

/** Query cross-family cards with exact AND/OR semantics. */
export function queryAttentionCards(cards, {
  symbols,
  timeframes,
  observationKinds,
  conditions,
  families,
  rsiKinds,
  rsiStages,
  operator = 'or',
  minimumFamilyCount = 0,
  includeProvisional = true,
  requireCompleteSources = false,
} = {}) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array.');
  for (const [index, card] of cards.entries()) {
    if (card?.schema_version !== ATTENTION_CARD_SCHEMA_VERSION) {
      throw new TypeError(`cards[${index}] uses an unsupported schema version.`);
    }
  }
  const symbolFilter = normalizeList(symbols, 'symbols', normalizeSymbol);
  const timeframeFilter = normalizeList(timeframes, 'timeframes', normalizeTimeframe);
  const kindFilter = normalizeList(
    observationKinds,
    'observationKinds',
    value => String(value).trim().toLowerCase(),
  );
  const conditionFilter = normalizeList(
    conditions,
    'conditions',
    value => String(value).trim().toUpperCase(),
  );
  const familyFilter = normalizeList(
    families,
    'families',
    value => String(value).trim().toLowerCase(),
  );
  const rsiKindFilter = normalizeList(
    rsiKinds,
    'rsiKinds',
    value => String(value).trim().toLowerCase(),
  );
  const rsiStageFilter = normalizeList(
    rsiStages,
    'rsiStages',
    value => String(value).trim().toUpperCase(),
  );
  const unknownConditions = (conditionFilter ?? []).filter(value => !CONDITION_SET.has(value));
  const unknownFamilies = (familyFilter ?? []).filter(value => !FAMILY_SET.has(value));
  const unknownRsiKinds = (rsiKindFilter ?? []).filter(value => !RSI_KIND_SET.has(value));
  const unknownRsiStages = (rsiStageFilter ?? []).filter(value => !RSI_STAGE_SET.has(value));
  if (unknownConditions.length) {
    throw new TypeError(`Unknown attention conditions: ${unknownConditions.join(', ')}.`);
  }
  if (unknownFamilies.length) {
    throw new TypeError(`Unknown attention families: ${unknownFamilies.join(', ')}.`);
  }
  if (unknownRsiKinds.length) {
    throw new TypeError(`Unknown RSI kinds: ${unknownRsiKinds.join(', ')}.`);
  }
  if (unknownRsiStages.length) {
    throw new TypeError(`Unknown RSI stages: ${unknownRsiStages.join(', ')}.`);
  }
  if ((kindFilter ?? []).some(value => value !== 'current' && value !== 'last_closed')) {
    throw new TypeError('observationKinds supports only current and last_closed.');
  }
  const normalizedOperator = String(operator).trim().toLowerCase();
  if (normalizedOperator !== 'and' && normalizedOperator !== 'or') {
    throw new TypeError('operator must be "and" or "or".');
  }
  if (!Number.isSafeInteger(minimumFamilyCount)
    || minimumFamilyCount < 0
    || minimumFamilyCount > 3) {
    throw new TypeError('minimumFamilyCount must be an integer from 0 to 3.');
  }
  if (typeof requireCompleteSources !== 'boolean') {
    throw new TypeError('requireCompleteSources must be boolean.');
  }
  if (typeof includeProvisional !== 'boolean') {
    throw new TypeError('includeProvisional must be boolean.');
  }

  return cards.filter(card => {
    if (symbolFilter && !symbolFilter.includes(card.symbol)) return false;
    if (timeframeFilter && !timeframeFilter.includes(card.timeframe)) return false;
    if (kindFilter && !kindFilter.includes(card.observation_kind)) return false;
    if (!includeProvisional && card.provisional) return false;
    if (requireCompleteSources && card.sources_present.length !== 2) return false;
    if (card.primitive_family_count < minimumFamilyCount) return false;
    if (familyFilter) {
      const familyMatches = familyFilter.map(family => card.primitive_families.includes(family));
      if (!(normalizedOperator === 'and'
        ? familyMatches.every(Boolean)
        : familyMatches.some(Boolean))) return false;
    }
    if (conditionFilter) {
      const conditionMatches = conditionFilter
        .map(condition => card.active_conditions.includes(condition));
      if (!(normalizedOperator === 'and'
        ? conditionMatches.every(Boolean)
        : conditionMatches.some(Boolean))) return false;
    }
    if (rsiKindFilter || rsiStageFilter) {
      const rsiStates = card.observations.rsi?.states ?? [];
      const directEvents = card.observations.rsi?.events ?? [];
      const typedStages = [
        ...rsiStates,
        ...directEvents.map(event => ({
          stage: event.type,
          kind: event.kind,
          direction: event.direction,
        })),
      ];
      const typedMatch = typedStages.some(value =>
        (!rsiKindFilter || rsiKindFilter.includes(value.kind))
        && (!rsiStageFilter || rsiStageFilter.includes(value.stage)));
      if (!typedMatch) return false;
    }
    return true;
  }).sort(rankAttentionCards);
}
