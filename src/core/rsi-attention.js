import { createHash } from 'node:crypto';

export const RSI_ATTENTION_SCHEMA_VERSION = 'rsi-attention-observation/v1';
export const RSI_ATTENTION_EVENT_SCHEMA_VERSION = 'rsi-attention-event/v1';

export const RSI_BULLISH_CONDITIONS = Object.freeze([
  'RSI_WATCH_REGULAR_BULL',
  'RSI_WATCH_HIDDEN_BULL',
  'RSI_DEVELOPING_REGULAR_BULL',
  'RSI_DEVELOPING_HIDDEN_BULL',
  'RSI_NEW_DEVELOPING_REGULAR_BULL',
  'RSI_NEW_DEVELOPING_HIDDEN_BULL',
  'RSI_CONFIRMED_REGULAR_BULL',
  'RSI_CONFIRMED_HIDDEN_BULL',
]);

const BOOLEAN_FIELDS = Object.freeze([
  'watch_regular_bull',
  'watch_hidden_bull',
  'developing_regular_bull',
  'developing_hidden_bull',
  'new_developing_regular_bull',
  'new_developing_hidden_bull',
  'confirmed_regular_bull',
  'confirmed_hidden_bull',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw new TypeError(`Unsupported RSI attention timeframe: ${value}`);
}

function requireTimestamp(value, label) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer in milliseconds.`);
  }
  return result;
}

function normalizeSymbol(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!result) throw new TypeError('reading needs a symbol.');
  return result;
}

function booleanField(reading, field) {
  if (typeof reading?.[field] !== 'boolean') {
    throw new TypeError(`RSI machine output ${field} must be explicitly boolean.`);
  }
  return reading[field];
}

function conditionList(values) {
  const mapping = [
    ['watch_regular_bull', 'RSI_WATCH_REGULAR_BULL'],
    ['watch_hidden_bull', 'RSI_WATCH_HIDDEN_BULL'],
    ['developing_regular_bull', 'RSI_DEVELOPING_REGULAR_BULL'],
    ['developing_hidden_bull', 'RSI_DEVELOPING_HIDDEN_BULL'],
    ['new_developing_regular_bull', 'RSI_NEW_DEVELOPING_REGULAR_BULL'],
    ['new_developing_hidden_bull', 'RSI_NEW_DEVELOPING_HIDDEN_BULL'],
    ['confirmed_regular_bull', 'RSI_CONFIRMED_REGULAR_BULL'],
    ['confirmed_hidden_bull', 'RSI_CONFIRMED_HIDDEN_BULL'],
  ];
  return mapping.filter(([field]) => values[field]).map(([, condition]) => condition);
}

function eventFor(observation, type, kind) {
  const eventKeyBase = [
    observation.source.source_sha256,
    observation.symbol,
    observation.timeframe,
    observation.data_bar_time_ms,
    type,
    kind,
  ].join('|');
  return {
    schema_version: RSI_ATTENTION_EVENT_SCHEMA_VERSION,
    type,
    family: 'rsi',
    direction: 'bullish',
    kind,
    symbol: observation.symbol,
    timeframe: observation.timeframe,
    profile: observation.profile,
    observed_at_ms: observation.observed_at_ms,
    data_bar_time_ms: observation.data_bar_time_ms,
    provisional: observation.provisional,
    event_key: createHash('sha256').update(eventKeyBase).digest('hex'),
  };
}

/** Normalize the exact typed Pine machine outputs without reproducing RSI offline. */
export function buildRsiAttentionObservation(reading, {
  scanAsOfTimeMs = reading?.scan_as_of_time_ms ?? Date.now(),
  barClosed = reading?.bar_closed === true,
  observationKind = 'current',
  sourceHash = reading?.source_sha256,
  sourceTitle = 'RSI Divergence',
} = {}) {
  if (!SHA256_PATTERN.test(sourceHash ?? '')) {
    throw new TypeError('sourceHash must be the exact lowercase SHA-256 of the RSI Pine source.');
  }
  const values = Object.fromEntries(
    BOOLEAN_FIELDS.map(field => [field, booleanField(reading, field)]),
  );
  const timeframe = normalizeTimeframe(reading?.timeframe);
  const symbol = normalizeSymbol(
    reading?.requested_symbol ?? reading?.symbol ?? reading?.chart_symbol,
  );
  const observedAtMs = requireTimestamp(scanAsOfTimeMs, 'scanAsOfTimeMs');
  const dataBarTimeMs = requireTimestamp(
    reading?.data_bar_time_ms
      ?? (Number.isFinite(reading?.current_bar_time_s)
        ? reading.current_bar_time_s * 1000
        : null),
    'dataBarTimeMs',
  );
  const activeConditions = conditionList(values);
  const states = [
    ...(values.watch_regular_bull ? [{ stage: 'WATCH', kind: 'regular', direction: 'bullish' }] : []),
    ...(values.watch_hidden_bull ? [{ stage: 'WATCH', kind: 'hidden', direction: 'bullish' }] : []),
    ...(values.developing_regular_bull
      ? [{ stage: 'DEVELOPING_ACTIVE', kind: 'regular', direction: 'bullish' }]
      : []),
    ...(values.developing_hidden_bull
      ? [{ stage: 'DEVELOPING_ACTIVE', kind: 'hidden', direction: 'bullish' }]
      : []),
  ];
  const observation = {
    schema_version: RSI_ATTENTION_SCHEMA_VERSION,
    symbol,
    timeframe,
    profile: timeframe === 'D' ? 'RSI_D' : 'RSI_W',
    observation_kind: String(observationKind),
    observed_at_ms: observedAtMs,
    data_bar_time_ms: dataBarTimeMs,
    bar_status: barClosed ? 'closed' : 'provisional',
    provisional: !barClosed,
    source: {
      title: sourceTitle,
      source_sha256: sourceHash,
      applied_live_binding_verified: false,
    },
    direction: 'bullish',
    values,
    states,
    active_conditions: activeConditions,
    active: activeConditions.length > 0,
    highest_stage: values.confirmed_regular_bull || values.confirmed_hidden_bull
      ? 'CONFIRMED'
      : values.new_developing_regular_bull || values.new_developing_hidden_bull
        ? 'NEW_DEVELOPING'
        : values.developing_regular_bull || values.developing_hidden_bull
          ? 'DEVELOPING_ACTIVE'
          : values.watch_regular_bull || values.watch_hidden_bull
            ? 'WATCH'
            : 'NONE',
    events: [],
  };
  observation.events = [
    ...(values.new_developing_regular_bull
      ? [eventFor(observation, 'NEW_DEVELOPING', 'regular')]
      : []),
    ...(values.new_developing_hidden_bull
      ? [eventFor(observation, 'NEW_DEVELOPING', 'hidden')]
      : []),
    ...(values.confirmed_regular_bull
      ? [eventFor(observation, 'CONFIRMED', 'regular')]
      : []),
    ...(values.confirmed_hidden_bull
      ? [eventFor(observation, 'CONFIRMED', 'hidden')]
      : []),
  ];
  return observation;
}

/** Derive queryable state edges; direct NEW/CONFIRMED pulses remain in current.events. */
export function deriveRsiStateTransitions(previous, current) {
  if (current?.schema_version !== RSI_ATTENTION_SCHEMA_VERSION) {
    throw new TypeError('current is not a versioned RSI attention observation.');
  }
  if (previous === null || previous === undefined) return [];
  if (previous?.schema_version !== RSI_ATTENTION_SCHEMA_VERSION
    || previous.symbol !== current.symbol
    || previous.timeframe !== current.timeframe) {
    throw new TypeError('previous and current must be matching RSI attention observations.');
  }
  const transitions = [];
  for (const kind of ['regular', 'hidden']) {
    const suffix = `${kind}_bull`;
    const watchField = `watch_${suffix}`;
    const developingField = `developing_${suffix}`;
    if (!previous.values[watchField] && current.values[watchField]) {
      transitions.push({ stage: 'WATCH_ENTERED', direction: 'bullish', kind });
    }
    if (previous.values[watchField] && !current.values[watchField]) {
      transitions.push({ stage: 'WATCH_CLEARED', direction: 'bullish', kind });
    }
    if (!previous.values[developingField] && current.values[developingField]) {
      transitions.push({ stage: 'DEVELOPING_ENTERED', direction: 'bullish', kind });
    }
    if (previous.values[developingField] && !current.values[developingField]) {
      transitions.push({ stage: 'DEVELOPING_CLEARED', direction: 'bullish', kind });
    }
  }
  return transitions;
}
