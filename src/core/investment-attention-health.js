import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  buildMetalsRouteUniverse,
  CUP_TARGETS,
  FEED_SUBSTITUTIONS,
} from './investment-attention-config.js';
import {
  readInvestmentAttentionLedgerRecords,
  canonicalJson,
  sha256,
} from './investment-attention-ledger.js';

export const INVESTMENT_ATTENTION_HEALTH_SCHEMA_VERSION = 'investment-attention-health/v1';
export const INVESTMENT_ATTENTION_ROUTE_RECEIPT_SCHEMA_VERSION = 'investment-attention-route-receipt/v1';
export const INVESTMENT_ATTENTION_WEEKLY_REVIEW_SCHEMA_VERSION = 'investment-attention-weekly-review/v1';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAMILY_SET = new Set(['sma_fib', 'rsi', 'cup_and_handle']);
const TIMEFRAME_SET = new Set(['D', 'W', '4H']);
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}

function iso(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function timestamp(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be an ISO timestamp`);
  return date.valueOf();
}

function normalizeFamily(value, label = 'family') {
  const result = nonempty(value, label).toLowerCase();
  if (!FAMILY_SET.has(result)) throw new TypeError(`${label} is unsupported: ${value}`);
  return result;
}

function normalizeTimeframe(value, label = 'timeframe') {
  const raw = nonempty(value, label).toUpperCase();
  const result = raw === '1D' || raw === 'DAY' ? 'D'
    : raw === '1W' || raw === 'WEEK' ? 'W'
      : raw === '240' || raw === '240M' ? '4H' : raw;
  if (!TIMEFRAME_SET.has(result)) throw new TypeError(`${label} is unsupported: ${value}`);
  return result;
}

function normalizeSymbol(value, label = 'symbol') {
  const result = nonempty(value, label).toUpperCase();
  if (!/^[^:\s]+:[^:\s]+$/u.test(result)) throw new TypeError(`${label} must be exchange-qualified`);
  return result;
}

function routeKey(family, symbol, timeframe) {
  return `${normalizeFamily(family)}|${normalizeSymbol(symbol)}|${normalizeTimeframe(timeframe)}`;
}

function routeKeyFromRow(row, label = 'row') {
  return routeKey(row.family, row.symbol ?? row.requested_symbol, row.timeframe);
}

function hashObject(value) {
  return sha256(canonicalJson(value));
}

function sourceIdentityFromAlert(alert) {
  const condition = alert?.condition ?? alert?.conditions?.[0] ?? null;
  const series = condition?.series?.[0] ?? condition?.series ?? null;
  const source = series && !Array.isArray(series) ? series : {};
  return {
    script_id: source.pine_id ?? source.script_id ?? alert?.script_id ?? null,
    script_version: source.pine_version ?? source.script_version ?? alert?.script_version ?? null,
    source_sha256: alert?.source_sha256 ?? null,
    definition_version: alert?.definition_version ?? null,
  };
}

function inputIdentityFromAlert(alert) {
  const condition = alert?.condition ?? alert?.conditions?.[0] ?? null;
  const series = condition?.series?.[0] ?? condition?.series ?? null;
  const inputs = alert?.input_values
    ?? (series && !Array.isArray(series) ? series.inputs ?? {} : alert?.input_identity ?? {});
  return {
    sha256: alert?.input_sha256 ?? hashObject(inputs),
    values: clone(inputs),
  };
}

function alertRoute(alert) {
  const family = normalizeFamily(alert.family ?? (
    String(alert.condition_name ?? alert.name ?? '').toLowerCase().includes('cup')
      ? 'cup_and_handle' : String(alert.name ?? '').toLowerCase().includes('rsi') ? 'rsi' : 'sma_fib'
  ));
  const symbol = normalizeSymbol(
    alert.route_symbol ?? alert.symbol ?? alert.requested_symbol ?? alert.pro_symbol,
    'alert symbol',
  );
  const timeframe = normalizeTimeframe(
    alert.route_timeframe ?? alert.timeframe ?? alert.resolution,
    'alert timeframe',
  );
  return { family, symbol, timeframe, route_key: routeKey(family, symbol, timeframe) };
}

function normalizeAlert(alert, index) {
  plain(alert, `alerts[${index}]`);
  const route = alertRoute(alert);
  const source = sourceIdentityFromAlert(alert);
  const input = inputIdentityFromAlert(alert);
  return {
    ...clone(alert),
    alert_id: nonempty(String(alert.alert_id ?? `alert-${index}`), `alerts[${index}].alert_id`),
    ...route,
    source_identity: source,
    input_identity: input,
    feed_symbol: alert.feed_symbol ?? alert.pro_symbol ?? alert.symbol ?? null,
    active: alert.active !== false,
    expiration: alert.expiration ?? null,
    popup: alert.popup ?? null,
    mobile_push: alert.mobile_push ?? null,
    web_hook: alert.web_hook ?? null,
  };
}

function expectedKey(row) {
  return nonempty(row.expected_key ?? row.route_key ?? routeKeyFromRow(row), 'expected_key');
}

function normalizeExpected(row, index) {
  plain(row, `expected_alerts[${index}]`);
  const family = normalizeFamily(row.family ?? 'sma_fib');
  const symbol = normalizeSymbol(row.symbol ?? row.requested_symbol, `expected_alerts[${index}].symbol`);
  const timeframe = normalizeTimeframe(row.timeframe, `expected_alerts[${index}].timeframe`);
  const expected = {
    ...clone(row),
    family,
    symbol,
    timeframe,
    route_key: routeKey(family, symbol, timeframe),
    expected_key: expectedKey({ ...row, family, symbol, timeframe }),
    active: row.active !== false,
    source_identity: clone(row.source_identity ?? row.source ?? {}),
    input_identity: clone(row.input_identity ?? row.input ?? {}),
    feed_symbol: row.feed_symbol ?? row.symbol ?? null,
    expiration: row.expiration ?? row.maximum_expiry_at_creation ?? null,
    maximum_expiry_at_creation: row.maximum_expiry_at_creation ?? row.expiration ?? null,
  };
  return expected;
}

function normalizeExclusion(value, index) {
  plain(value, `excluded_routes[${index}]`);
  const family = normalizeFamily(value.family, `excluded_routes[${index}].family`);
  const symbol = normalizeSymbol(value.symbol, `excluded_routes[${index}].symbol`);
  const timeframe = normalizeTimeframe(value.timeframe, `excluded_routes[${index}].timeframe`);
  const reason = nonempty(value.reason, `excluded_routes[${index}].reason`);
  return { ...clone(value), family, symbol, timeframe, route_key: routeKey(family, symbol, timeframe), reason };
}

function compareIdentity(expected, actual, key) {
  return canonicalJson(expected?.[key] ?? null) === canonicalJson(actual?.[key] ?? null);
}

function expiryStatus(expected, actual, asOfMs, renewalWarningMs) {
  const actualMs = actual.expiration ? Date.parse(actual.expiration) : NaN;
  const maximumMs = expected.maximum_expiry_at_creation ? Date.parse(expected.maximum_expiry_at_creation) : NaN;
  const invalid = !Number.isFinite(actualMs) || !Number.isFinite(maximumMs) || actualMs !== maximumMs;
  const expired = Number.isFinite(actualMs) && actualMs <= asOfMs;
  const warning = Number.isFinite(actualMs) && !expired && actualMs - asOfMs <= renewalWarningMs;
  return {
    alert_id: actual.alert_id,
    expiration: Number.isFinite(actualMs) ? new Date(actualMs).toISOString() : null,
    maximum_expiry_at_creation: Number.isFinite(maximumMs) ? new Date(maximumMs).toISOString() : null,
    status: invalid ? 'invariant_violation' : expired ? 'expired' : warning ? 'renewal_warning' : 'ok',
    remaining_ms: Number.isFinite(actualMs) ? actualMs - asOfMs : null,
    reconciliation_required: invalid || expired || warning,
  };
}

function livenessResult(heartbeat, asOfMs, maxAgeMs) {
  if (!heartbeat) return { status: 'missing', alive: false, age_ms: null, max_age_ms: maxAgeMs };
  const aliveMs = Date.parse(heartbeat.alive_at);
  const age = Number.isFinite(aliveMs) ? asOfMs - aliveMs : null;
  const alive = heartbeat.schema_version === 'investment-attention-collector/v1'
    && Number.isFinite(age) && age >= -60_000 && age <= maxAgeMs;
  return {
    status: alive ? 'ok' : 'stale_or_invalid',
    alive,
    age_ms: age,
    max_age_ms: maxAgeMs,
    alive_at: Number.isFinite(aliveMs) ? new Date(aliveMs).toISOString() : null,
    schema_version: heartbeat.schema_version ?? null,
  };
}

/** Build an explicit 33-symbol x D/W availability and warmness receipt. */
export function buildRouteCoverageReceipt({
  routes = buildMetalsRouteUniverse(),
  readings = [],
  exclusions = [],
  observedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(routes) || routes.length !== 66) throw new TypeError('routes must contain exactly 66 D/W routes');
  if (!Array.isArray(readings) || !Array.isArray(exclusions)) throw new TypeError('route receipt inputs must be arrays');
  const readingMap = new Map(readings.map((reading, index) => {
    plain(reading, `readings[${index}]`);
    const symbol = normalizeSymbol(reading.runtime_symbol ?? reading.symbol, `readings[${index}].symbol`);
    const timeframe = normalizeTimeframe(reading.timeframe, `readings[${index}].timeframe`);
    return [`${symbol}|${timeframe}`, {
      ...clone(reading),
      symbol,
      timeframe,
      available: reading.available === true,
      warm: reading.warm === true,
    }];
  }));
  const exclusionRows = exclusions.map(normalizeExclusion);
  const expected = routes.map(route => {
    const key = `${route.runtime_symbol}|${route.timeframe}`;
    const reading = readingMap.get(key) ?? { available: false, warm: false, evidence: 'missing' };
    return {
      route_key: key,
      source_symbol: route.source_symbol,
      runtime_symbol: route.runtime_symbol,
      timeframe: route.timeframe,
      substitution: clone(route.substitution),
      canonicalization: clone(route.canonicalization),
      available: reading.available === true,
      warm: reading.warm === true,
      status: reading.available !== true ? 'unavailable' : reading.warm !== true ? 'warming' : 'ready',
      evidence: reading.evidence ?? null,
      observed_bar_time_ms: reading.observed_bar_time_ms ?? null,
    };
  });
  const expectedKeys = new Set(expected.map(row => row.route_key));
  const unexpectedReadings = [...readingMap.keys()].filter(key => !expectedKeys.has(key));
  const excludedExpected = exclusionRows.filter(row => expectedKeys.has(`${row.symbol}|${row.timeframe}`));
  const invalidExclusions = exclusionRows.filter(row => !expectedKeys.has(`${row.symbol}|${row.timeframe}`));
  const missing = expected.filter(row => !row.available && !excludedExpected.some(exclusion => `${exclusion.symbol}|${exclusion.timeframe}` === row.route_key));
  const warming = expected.filter(row => row.available && !row.warm && !excludedExpected.some(exclusion => `${exclusion.symbol}|${exclusion.timeframe}` === row.route_key));
  return {
    schema_version: INVESTMENT_ATTENTION_ROUTE_RECEIPT_SCHEMA_VERSION,
    observed_at: iso(observedAt, 'observedAt'),
    expected_route_count: 66,
    available_route_count: expected.filter(row => row.available).length,
    warm_route_count: expected.filter(row => row.warm).length,
    substitution_count: expected.filter(row => row.substitution !== null).length,
    distinct_substitution_count: new Set(expected.filter(row => row.substitution !== null).map(row => row.source_symbol)).size,
    canonicalization_count: expected.filter(row => row.canonicalization !== null).length,
    substitutions: clone(FEED_SUBSTITUTIONS),
    routes: expected,
    exclusions: exclusionRows,
    missing_routes: missing,
    warming_routes: warming,
    invalid_exclusions: invalidExclusions,
    unexpected_readings: unexpectedReadings,
    healthy: missing.length === 0 && warming.length === 0 && invalidExclusions.length === 0 && unexpectedReadings.length === 0,
  };
}

/**
 * Reconcile the scoped live alert snapshot without mutating TradingView. The
 * caller supplies expected rows that bind each alert to source/version/input/feed.
 */
export function assessInvestmentAttentionAlertHealth({
  expectedAlerts = [],
  activeAlerts = [],
  excludedRoutes = [],
  collectorHeartbeat = null,
  now = new Date().toISOString(),
  renewalWarningMs = 7 * DAY_MS,
  collectorMaxAgeMs = 30 * 60 * 1000,
} = {}) {
  if (!Array.isArray(expectedAlerts) || !Array.isArray(activeAlerts) || !Array.isArray(excludedRoutes)) {
    throw new TypeError('alert health inputs must be arrays');
  }
  const asOf = iso(now, 'now');
  const asOfMs = Date.parse(asOf);
  const expected = expectedAlerts.map(normalizeExpected);
  const actual = activeAlerts.map(normalizeAlert);
  const exclusions = excludedRoutes.map(normalizeExclusion);
  const excludedKeys = new Set(exclusions.map(row => row.route_key));
  const expectedByKey = new Map();
  const duplicateExpected = [];
  for (const row of expected) {
    if (expectedByKey.has(row.expected_key)) duplicateExpected.push(row.expected_key);
    expectedByKey.set(row.expected_key, row);
  }
  const actualByKey = new Map();
  for (const row of actual) {
    const key = row.expected_key ?? row.route_key;
    const list = actualByKey.get(key) ?? [];
    list.push(row);
    actualByKey.set(key, list);
  }
  const missing = [];
  const duplicates = [];
  const disabled = [];
  const expired = [];
  const renewalWarnings = [];
  const expiryReconciliation = [];
  const sourceDrift = [];
  const inputDrift = [];
  const feedDrift = [];
  const notificationDrift = [];
  const activeExcluded = [];
  const usedActual = new Set();

  for (const wanted of expected) {
    const matches = (actualByKey.get(wanted.expected_key) ?? []).filter(row => row.route_key === wanted.route_key);
    const excluded = excludedKeys.has(wanted.route_key);
    if (matches.length > 1) duplicates.push({ expected_key: wanted.expected_key, alert_ids: matches.map(row => row.alert_id).sort() });
    if (matches.length === 0) {
      if (!excluded && wanted.active) missing.push({ expected_key: wanted.expected_key, route_key: wanted.route_key });
      continue;
    }
    for (const row of matches) usedActual.add(row.alert_id);
    const row = matches[0];
    if (excluded && row.active) activeExcluded.push({ expected_key: wanted.expected_key, alert_id: row.alert_id, route_key: row.route_key });
    if (!row.active) disabled.push({ expected_key: wanted.expected_key, alert_id: row.alert_id });
    if (!compareIdentity(wanted, row, 'source_identity')) sourceDrift.push({ expected_key: wanted.expected_key, alert_id: row.alert_id, expected: wanted.source_identity, actual: row.source_identity });
    if (!compareIdentity(wanted, row, 'input_identity')) inputDrift.push({ expected_key: wanted.expected_key, alert_id: row.alert_id, expected: wanted.input_identity, actual: row.input_identity });
    if (wanted.feed_symbol && String(row.feed_symbol ?? '').toUpperCase() !== String(wanted.feed_symbol).toUpperCase()) feedDrift.push({ expected_key: wanted.expected_key, alert_id: row.alert_id, expected: wanted.feed_symbol, actual: row.feed_symbol });
    for (const field of ['popup', 'mobile_push', 'web_hook']) {
      if (wanted[field] !== undefined && wanted[field] !== null && row[field] !== wanted[field]) {
        notificationDrift.push({ expected_key: wanted.expected_key, alert_id: row.alert_id, field, expected: wanted[field], actual: row[field] });
      }
    }
    if (wanted.maximum_expiry_at_creation) {
      const expiry = expiryStatus(wanted, row, asOfMs, renewalWarningMs);
      if (expiry.status === 'expired') expired.push(expiry);
      if (expiry.status === 'renewal_warning') renewalWarnings.push(expiry);
      if (expiry.reconciliation_required) expiryReconciliation.push(expiry);
    }
  }
  const unexpected = actual.filter(row => !usedActual.has(row.alert_id) && row.active).map(row => ({
    alert_id: row.alert_id,
    route_key: row.route_key,
    family: row.family,
    symbol: row.symbol,
    timeframe: row.timeframe,
  }));
  const invalidExclusions = exclusions.filter(row => !expected.some(item => item.route_key === row.route_key));
  const collectorLiveness = livenessResult(collectorHeartbeat, asOfMs, collectorMaxAgeMs);
  const actionRequired = [
    ...missing,
    ...duplicates,
    ...disabled,
    ...expired,
    ...renewalWarnings,
    ...sourceDrift,
    ...inputDrift,
    ...feedDrift,
    ...notificationDrift,
    ...unexpected,
    ...activeExcluded,
    ...invalidExclusions,
    ...(duplicateExpected.length ? [{ duplicate_expected_keys: duplicateExpected }] : []),
    ...(!collectorLiveness.alive ? [{ collector_liveness: collectorLiveness }] : []),
  ];
  return {
    schema_version: INVESTMENT_ATTENTION_HEALTH_SCHEMA_VERSION,
    as_of: asOf,
    expected_alert_count: expected.length,
    active_alert_count: actual.filter(row => row.active).length,
    expected_alerts: expected,
    observed_alerts: actual,
    missing,
    unexpected,
    duplicates,
    duplicate_expected_keys: duplicateExpected,
    disabled,
    expired,
    renewal_warnings: renewalWarnings,
    expiry_reconciliation: expiryReconciliation,
    source_drift: sourceDrift,
    input_drift: inputDrift,
    feed_drift: feedDrift,
    notification_drift: notificationDrift,
    active_excluded_routes: activeExcluded,
    invalid_exclusions: invalidExclusions,
    collector_liveness: collectorLiveness,
    action_required: actionRequired,
    healthy: actionRequired.length === 0,
  };
}

function eventInWindow(record, startMs, endMs) {
  const value = Date.parse(record.observed_at ?? record.event?.observed_at ?? '');
  return Number.isFinite(value) && value >= startMs && value < endMs;
}

function labelsFor(records, labels) {
  const known = new Map((labels ?? []).map(label => [label.event_id, label]));
  return records.reduce((result, record) => {
    const label = known.get(record.event_id);
    if (label?.label) result[label.label] = (result[label.label] ?? 0) + 1;
    return result;
  }, {});
}

/** Build a weekly usefulness/noise/duplicates/misses/outcomes review. */
export function buildInvestmentAttentionWeeklyReview({
  records,
  stateDir,
  weekStart,
  weekEnd,
  familyCanaries = [],
  missSampling = { passed: false, candidates: [] },
  labels = [],
  outcomes = [],
  health = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const sourceRecords = records ?? (stateDir ? readInvestmentAttentionLedgerRecords(stateDir) : []);
  if (!Array.isArray(sourceRecords)) throw new TypeError('records must be an array');
  const start = timestamp(weekStart, 'weekStart');
  const end = timestamp(weekEnd, 'weekEnd');
  if (!(end > start)) throw new TypeError('weekEnd must be after weekStart');
  const events = sourceRecords.filter(record => eventInWindow(record, start, end));
  const unique = new Map();
  const duplicateIngests = [];
  const stateUpgrades = [];
  for (const record of events) {
    if (record.ingest_result === 'duplicate' || record.ingest_result === 'duplicate_regression') duplicateIngests.push(record);
    if (record.ingest_result === 'state_upgrade') stateUpgrades.push(record);
    if (record.ingest_result === 'new' || record.ingest_result === 'bootstrap_suppressed' || record.ingest_result === 'state_upgrade') {
      unique.set(record.event_id, record);
    }
  }
  const eventRows = [...unique.values()];
  const byFamily = Object.fromEntries([...FAMILY_SET].map(family => [family, eventRows.filter(row => row.event?.family === family).length]));
  const byType = {};
  for (const row of eventRows) {
    const type = row.event?.event_type ?? 'UNKNOWN';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  const labelCounts = labelsFor(eventRows, labels);
  const outcomeRows = (outcomes ?? []).filter(outcome => {
    const observed = Date.parse(outcome.observed_at ?? outcome.completed_at ?? '');
    return Number.isFinite(observed) && observed >= start && observed < end;
  });
  const canaries = (familyCanaries ?? []).map((canary, index) => ({
    family: canary.family ?? `family-${index}`,
    passed: canary.passed === true,
    evidence_ref: canary.evidence_ref ?? null,
  }));
  const canariesPassed = canaries.length === 4 && canaries.every(canary => canary.passed);
  const missSamplingResult = {
    passed: missSampling?.passed === true,
    candidate_count: Array.isArray(missSampling?.candidates) ? missSampling.candidates.length : 0,
    evidence_ref: missSampling?.evidence_ref ?? null,
  };
  const zeroEventException = eventRows.length === 0 && canariesPassed && missSamplingResult.passed;
  const complete = (eventRows.length > 0 || zeroEventException)
    && canariesPassed
    && missSamplingResult.passed
    && (!health || health.healthy === true);
  return {
    schema_version: INVESTMENT_ATTENTION_WEEKLY_REVIEW_SCHEMA_VERSION,
    generated_at: iso(generatedAt, 'generatedAt'),
    week_start: new Date(start).toISOString(),
    week_end: new Date(end).toISOString(),
    status: complete ? 'complete' : 'incomplete',
    complete,
    zero_event_exception: zeroEventException,
    efficacy_claim: false,
    trading_return_claim: false,
    metrics: {
      payload_record_count: events.length,
      unique_event_count: eventRows.length,
      notification_count: eventRows.filter(row => row.notified === true).length,
      duplicate_ingest_count: duplicateIngests.length,
      state_upgrade_count: stateUpgrades.length,
      provisional_count: eventRows.filter(row => row.event?.provisional === true).length,
      terminal_invalidated_count: eventRows.filter(row => row.event?.event_type === 'INVALIDATED').length,
      terminal_expired_count: eventRows.filter(row => row.event?.event_type === 'EXPIRED').length,
      terminal_breakout_count: eventRows.filter(row => row.event?.event_type === 'PRICE_BREAKOUT_CONFIRMED').length,
      by_family: byFamily,
      by_event_type: byType,
      labels: labelCounts,
      outcomes_count: outcomeRows.length,
      misses_sampled: missSamplingResult.candidate_count,
    },
    canaries,
    canaries_passed: canariesPassed,
    miss_sampling: missSamplingResult,
    health_summary: health ? {
      healthy: health.healthy === true,
      action_count: health.action_required?.length ?? null,
    } : null,
    evidence: {
      ledger_record_sha256: hashObject(events),
      unique_event_ids: eventRows.map(row => row.event_id).sort(),
    },
  };
}

function safeStateDir(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new TypeError('stateDir must be absolute');
  const root = resolve(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('state directory is unsafe');
  return root;
}

export function writeInvestmentAttentionHealthReceipt(stateDir, name, value) {
  const root = safeStateDir(stateDir);
  const filename = nonempty(name, 'receipt name');
  if (!/^[A-Za-z0-9._-]+\.json$/u.test(filename)) throw new TypeError('receipt name must be a JSON filename');
  const path = join(root, filename);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path, sha256: sha256(JSON.stringify(value)) };
}

export function readInvestmentAttentionReceipt(stateDir, name) {
  const root = safeStateDir(stateDir);
  const filename = nonempty(name, 'receipt name');
  if (!/^[A-Za-z0-9._-]+\.json$/u.test(filename)) throw new TypeError('receipt name must be a JSON filename');
  const path = join(root, filename);
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('receipt path is unsafe');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function buildDefaultExpectedCupRoutes() {
  return CUP_TARGETS.flatMap(target => [
    { ...target, family: 'cup_and_handle', symbol: target.feed_symbol, timeframe: target.timeframe, route_key: routeKey('cup_and_handle', target.feed_symbol, target.timeframe) },
  ]);
}

export { routeKey };
