import { createHash } from 'node:crypto';

export const RSI_ALERT_BATCH_SCHEMA_VERSION = 'rsi-watchlist-alert-batch/v1';
export const RSI_ALERT_STATE_SCHEMA_VERSION = 'rsi-watchlist-alert-state/v1';

export const RSI_ALERT_EVENT_BITS = Object.freeze({
  NEW_DEVELOPING_REGULAR_BULL: 1,
  NEW_DEVELOPING_HIDDEN_BULL: 2,
  CONFIRMED_REGULAR_BULL: 4,
  CONFIRMED_HIDDEN_BULL: 8,
});

export const RSI_ALERT_EVENT_TYPES = Object.freeze(Object.keys(RSI_ALERT_EVENT_BITS));
export const RSI_ALERT_EVENT_MASK_MAX = 15;

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw new TypeError(`RSI alert profile must be D or W, received: ${value}`);
}

function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) {
    throw new TypeError('RSI alert routes require exchange-qualified TradingView symbols.');
  }
  return symbol;
}

function requireBarTime(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer in milliseconds.`);
  }
  return result;
}

function requireMask(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > RSI_ALERT_EVENT_MASK_MAX) {
    throw new TypeError(`${label} must be an integer event bitmask from 0 through 15.`);
  }
  return result;
}

export function decodeRsiAlertEventMask(mask) {
  const checkedMask = requireMask(mask, 'mask');
  return RSI_ALERT_EVENT_TYPES.filter(type => (checkedMask & RSI_ALERT_EVENT_BITS[type]) !== 0);
}

function eventKey({ definitionVersion, sourceSha256, symbol, timeframe, dataBarTimeMs, type }) {
  return createHash('sha256').update([
    definitionVersion,
    sourceSha256,
    symbol,
    timeframe,
    dataBarTimeMs,
    type,
  ].join('|')).digest('hex');
}

export function createRsiAlertScannerState({ definitionVersion, sourceSha256 }) {
  if (typeof definitionVersion !== 'string' || !definitionVersion) {
    throw new TypeError('definitionVersion is required.');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 ?? '')) {
    throw new TypeError('sourceSha256 must be a lowercase SHA-256.');
  }
  return {
    schema_version: RSI_ALERT_STATE_SCHEMA_VERSION,
    definition_version: definitionVersion,
    source_sha256: sourceSha256,
    routes: {},
    emitted_event_keys: [],
  };
}

function assertState(state, definitionVersion, sourceSha256) {
  if (state?.schema_version !== RSI_ALERT_STATE_SCHEMA_VERSION) {
    throw new TypeError('state is not a versioned RSI alert scanner state.');
  }
  if (state.definition_version !== definitionVersion || state.source_sha256 !== sourceSha256) {
    throw new Error('RSI alert state namespace does not match the scanner definition/source.');
  }
}

function normalizeLeg(leg, label, { provisional }) {
  if (leg === null || leg === undefined) return null;
  return {
    mask: requireMask(leg.mask, `${label}.mask`),
    data_bar_time_ms: requireBarTime(leg.data_bar_time_ms, `${label}.data_bar_time_ms`),
    provisional,
  };
}

function normalizeRoute(route, expectedTimeframe) {
  const timeframe = normalizeTimeframe(route?.timeframe);
  if (timeframe !== expectedTimeframe) {
    throw new TypeError('Every RSI scanner route must match the one D/W instance profile.');
  }
  return {
    symbol: normalizeSymbol(route.symbol),
    timeframe,
    current: normalizeLeg(route.current, 'current', { provisional: true }),
    last_closed: normalizeLeg(route.last_closed, 'last_closed', { provisional: false }),
  };
}

function candidatesForRoute(route, includeProvisional) {
  const candidates = [];
  // Closed first: if synthetic fixtures carry the same identity in both legs,
  // the durable closed form wins over the provisional form.
  if (route.last_closed?.mask) candidates.push(route.last_closed);
  if (includeProvisional && route.current?.mask) candidates.push(route.current);
  const byIdentity = new Map();
  for (const leg of candidates) {
    for (const type of decodeRsiAlertEventMask(leg.mask)) {
      const identity = `${route.symbol}|${route.timeframe}|${leg.data_bar_time_ms}|${type}`;
      if (!byIdentity.has(identity)) {
        byIdentity.set(identity, { ...leg, type });
      }
    }
  }
  return [...byIdentity.values()];
}

/**
 * Pure model of the Pine scanner's bootstrap, event identity, dedupe, and
 * single-batch coalescing behavior. Query calls should use the study adapter;
 * this monitor path consumes only the four approved notification pulses.
 */
export function reconcileRsiAlertScanner(state, routes, {
  definitionVersion,
  sourceSha256,
  timeframe,
  includeProvisional = true,
  observedAtMs = Date.now(),
} = {}) {
  assertState(state, definitionVersion, sourceSha256);
  if (!Array.isArray(routes) || routes.length > 30) {
    throw new TypeError('routes must be an array with at most 30 symbols.');
  }
  const profile = normalizeTimeframe(timeframe);
  const observedAt = requireBarTime(observedAtMs, 'observedAtMs');
  const emitted = new Set(state.emitted_event_keys);
  const nextState = structuredClone(state);
  const events = [];
  const seenSymbols = new Set();
  for (const rawRoute of routes) {
    const route = normalizeRoute(rawRoute, profile);
    if (seenSymbols.has(route.symbol)) {
      throw new TypeError(`Duplicate RSI scanner route: ${route.symbol}`);
    }
    seenSymbols.add(route.symbol);
    const candidates = candidatesForRoute(route, includeProvisional);
    const routeState = nextState.routes[route.symbol];
    if (!routeState) {
      nextState.routes[route.symbol] = {
        bootstrapped: true,
        seeded_event_keys: candidates.map(candidate => eventKey({
          definitionVersion,
          sourceSha256,
          symbol: route.symbol,
          timeframe: profile,
          dataBarTimeMs: candidate.data_bar_time_ms,
          type: candidate.type,
        })),
      };
      for (const key of nextState.routes[route.symbol].seeded_event_keys) emitted.add(key);
      continue;
    }
    for (const candidate of candidates) {
      const key = eventKey({
        definitionVersion,
        sourceSha256,
        symbol: route.symbol,
        timeframe: profile,
        dataBarTimeMs: candidate.data_bar_time_ms,
        type: candidate.type,
      });
      if (emitted.has(key)) continue;
      emitted.add(key);
      events.push({
        schema_version: 'rsi-watchlist-alert-event/v1',
        event_key: key,
        family: 'rsi',
        direction: 'bullish',
        type: candidate.type,
        symbol: route.symbol,
        timeframe: profile,
        data_bar_time_ms: candidate.data_bar_time_ms,
        provisional: candidate.provisional,
      });
    }
  }
  events.sort((left, right) => (
    left.symbol.localeCompare(right.symbol)
      || left.data_bar_time_ms - right.data_bar_time_ms
      || left.type.localeCompare(right.type)
  ));
  nextState.emitted_event_keys = [...emitted].sort();
  return {
    state: nextState,
    notification: events.length
      ? {
          schema_version: RSI_ALERT_BATCH_SCHEMA_VERSION,
          definition_version: definitionVersion,
          source_sha256: sourceSha256,
          timeframe: profile,
          observed_at_ms: observedAt,
          event_count: events.length,
          events,
        }
      : null,
  };
}
