import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const MONITORING_SCHEMA_VERSION = 'cup-handle-monitoring-ledger-v1';
export const ALERT_SCHEMA_VERSION = 'cup-handle-alert-v1';
export const QUALITY_LABELS = Object.freeze(['useful', 'too_early', 'wrong_shape', 'duplicate', 'unclear']);
export const DELIVERY_STATUSES = Object.freeze(['delivered', 'not_delivered', 'unknown']);
export const TERMINAL_STAGES = Object.freeze(['PRICE_BREAKOUT_CONFIRMED', 'INVALIDATED', 'EXPIRED']);
export const SUPPORTED_STAGES = Object.freeze([
  'RIM_APPROACH',
  'HANDLE_FORMING',
  'HANDLE_READY',
  'PRICE_BREAKOUT_CONFIRMED',
  'INVALIDATED',
  'EXPIRED',
]);

const STAGE_RANK = Object.freeze({
  CUP_FORMING: 1,
  RIM_APPROACH: 2,
  CUP_CONFIRMED: 3,
  HANDLE_FORMING: 4,
  HANDLE_READY: 5,
  PRICE_BREAKOUT_CONFIRMED: 6,
  INVALIDATED: -1,
  EXPIRED: -2,
});

const REQUIRED_EVENT_FIELDS = Object.freeze([
  'schema_version', 'detector_version', 'policy_id', 'config_id', 'event_id', 'symbol',
  'timeframe', 'asset_class', 'profile', 'event_type', 'from_stage', 'to_stage',
  'provisional', 'family_id', 'pattern_id', 'detection_bar_open_ms', 'detection_bar_close_ms',
  'experimental_profile', 'reason_code',
]);

function fail(code, message, details = {}) {
  const error = new TypeError(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function nonEmptyString(value, field) {
  assert(typeof value === 'string' && value.trim().length > 0, 'INVALID_FIELD', `${field} must be a non-empty string`, { field });
  return value;
}

function finiteNumber(value, field) {
  assert(typeof value === 'number' && Number.isFinite(value), 'INVALID_FIELD', `${field} must be finite`, { field });
  return value;
}

function isoTime(value, field) {
  const time = new Date(value);
  assert(typeof value === 'string' && !Number.isNaN(time.valueOf()), 'INVALID_TIME', `${field} must be an ISO timestamp`, { field });
  return time.toISOString();
}

function pairKey(pair) {
  return [pair.symbol, pair.timeframe, pair.profile].map(value => String(value ?? '')).join('|');
}

function definitionForFingerprint(definition) {
  assert(isPlainObject(definition), 'INVALID_DEFINITION', 'definition must be an object');
  const normalized = {
    detector_version: nonEmptyString(definition.detector_version, 'definition.detector_version'),
    policy_id: nonEmptyString(definition.policy_id, 'definition.policy_id'),
    config_id: nonEmptyString(definition.config_id, 'definition.config_id'),
    source_hashes: clone(definition.source_hashes ?? {}),
    input_definition: clone(definition.input_definition ?? {}),
  };
  assert(isPlainObject(normalized.source_hashes), 'INVALID_DEFINITION', 'source_hashes must be an object');
  assert(isPlainObject(normalized.input_definition), 'INVALID_DEFINITION', 'input_definition must be an object');
  return normalized;
}

export function createDefinition(definition) {
  const normalized = definitionForFingerprint(definition);
  return Object.freeze({ ...normalized, fingerprint: sha256(normalized) });
}

function eventPayloadWithoutSeal(event) {
  const payload = clone(event);
  delete payload.definition_fingerprint;
  delete payload.event_hash;
  delete payload.ingested_at;
  delete payload.ingest_sequence;
  delete payload.cohort;
  delete payload.source;
  return payload;
}

function validateEventPayload(payload) {
  assert(isPlainObject(payload), 'MALFORMED_EVENT', 'event payload must be an object');
  for (const field of REQUIRED_EVENT_FIELDS) assert(Object.hasOwn(payload, field), 'MALFORMED_EVENT', `missing required field ${field}`, { field });
  assert(payload.schema_version === ALERT_SCHEMA_VERSION, 'MALFORMED_EVENT', 'unexpected alert schema version');
  for (const field of ['detector_version', 'policy_id', 'config_id', 'event_id', 'symbol', 'timeframe', 'asset_class', 'profile', 'event_type', 'family_id', 'pattern_id', 'reason_code']) {
    nonEmptyString(payload[field], field);
  }
  assert(SUPPORTED_STAGES.includes(payload.to_stage), 'MALFORMED_EVENT', `unsupported to_stage ${payload.to_stage}`);
  assert(typeof payload.from_stage === 'string', 'MALFORMED_EVENT', 'from_stage must be a string');
  assert(typeof payload.provisional === 'boolean', 'MALFORMED_EVENT', 'provisional must be boolean');
  assert(typeof payload.experimental_profile === 'boolean', 'MALFORMED_EVENT', 'experimental_profile must be boolean');
  finiteNumber(payload.detection_bar_open_ms, 'detection_bar_open_ms');
  finiteNumber(payload.detection_bar_close_ms, 'detection_bar_close_ms');
  assert(payload.detection_bar_close_ms >= payload.detection_bar_open_ms, 'MALFORMED_EVENT', 'bar close must not precede bar open');
  for (const field of ['quality_score', 'rim', 'pivot', 'invalidation', 'p1_time_ms', 'p2_time_ms', 'p3_time_ms', 'p4_time_ms']) {
    if (Object.hasOwn(payload, field) && payload[field] !== null) finiteNumber(payload[field], field);
  }
  return clone(payload);
}

export function sealCupEvent(payload, definition) {
  const normalizedDefinition = createDefinition(definition);
  const normalizedPayload = validateEventPayload(payload);
  assert(normalizedPayload.detector_version === normalizedDefinition.detector_version
    && normalizedPayload.policy_id === normalizedDefinition.policy_id
    && normalizedPayload.config_id === normalizedDefinition.config_id,
  'EVENT_DEFINITION_MISMATCH', 'event identity fields do not match immutable definition');
  return {
    ...normalizedPayload,
    definition_fingerprint: normalizedDefinition.fingerprint,
    event_hash: sha256(eventPayloadWithoutSeal(normalizedPayload)),
  };
}

function normalizeInputEvent(input, definition) {
  const raw = typeof input === 'string'
    ? (() => {
      try { return JSON.parse(input); } catch (error) { fail('MALFORMED_EVENT', 'event is not valid JSON', { cause: error }); }
    })()
    : clone(input);
  const sealed = sealCupEvent(raw, definition);
  if (Object.hasOwn(raw, 'definition_fingerprint')) {
    assert(raw.definition_fingerprint === sealed.definition_fingerprint, 'EVENT_RESEALED', 'event was sealed against another immutable definition');
  }
  if (Object.hasOwn(raw, 'event_hash')) {
    assert(raw.event_hash === sealed.event_hash, 'EVENT_RESEALED', 'event content does not match its seal');
  }
  return sealed;
}

function emptyLedger(definition, createdAt) {
  const normalizedDefinition = createDefinition(definition);
  return {
    schema_version: MONITORING_SCHEMA_VERSION,
    created_at: isoTime(createdAt ?? new Date().toISOString(), 'created_at'),
    definition: clone(normalizedDefinition),
    definition_fingerprint: normalizedDefinition.fingerprint,
    events: [],
    delivery_evidence: [],
    labels: [],
    correctness_evidence: [],
    investment_outcomes: [],
    ingest_audit: [],
  };
}

export function createMonitoringLedger({ definition, createdAt } = {}) {
  assert(definition, 'INVALID_DEFINITION', 'an immutable detector/source/input definition is required');
  return emptyLedger(definition, createdAt);
}

function assertLedger(ledger) {
  assert(isPlainObject(ledger) && ledger.schema_version === MONITORING_SCHEMA_VERSION, 'INVALID_LEDGER', 'invalid monitoring ledger');
  assert(Array.isArray(ledger.events) && Array.isArray(ledger.delivery_evidence)
    && Array.isArray(ledger.labels) && Array.isArray(ledger.correctness_evidence)
    && Array.isArray(ledger.investment_outcomes) && Array.isArray(ledger.ingest_audit),
  'INVALID_LEDGER', 'ledger collections are missing');
  assert(ledger.definition_fingerprint === ledger.definition?.fingerprint, 'INVALID_LEDGER', 'ledger definition seal is inconsistent');
}

function nowIso(now) {
  return isoTime(now ?? new Date().toISOString(), 'observed_at');
}

function eventRank(event) {
  return STAGE_RANK[event.to_stage] ?? 0;
}

function findEvent(ledger, eventId) {
  return ledger.events.find(event => event.event_id === eventId) ?? null;
}

export function ingestEvent(ledger, input, { observedAt, source = 'offline', cohort = null } = {}) {
  assertLedger(ledger);
  const event = normalizeInputEvent(input, ledger.definition);
  const duplicate = ledger.events.find(existing => existing.event_id === event.event_id);
  const at = nowIso(observedAt);
  const sequence = ledger.ingest_audit.length + 1;
  if (duplicate) {
    assert(duplicate.definition_fingerprint === event.definition_fingerprint, 'EVENT_DEFINITION_MISMATCH', 'stable event_id was reused with another definition');
    assert(duplicate.event_hash === event.event_hash, 'EVENT_ID_CONFLICT', 'stable event_id was reused with changed payload');
    ledger.ingest_audit.push({ sequence, observed_at: at, event_id: event.event_id, result: 'duplicate', source });
    return { status: 'duplicate', event: clone(duplicate) };
  }
  const record = {
    ...event,
    ingested_at: at,
    ingest_sequence: sequence,
    source: nonEmptyString(source, 'source'),
    ...(cohort === null ? {} : { cohort: nonEmptyString(cohort, 'cohort') }),
  };
  ledger.events.push(record);
  const priorLifecycleEvents = ledger.events.filter(item => item.pattern_id === event.pattern_id && item.event_id !== event.event_id);
  const escalation = priorLifecycleEvents.some(item => eventRank(event) > eventRank(item));
  const result = escalation ? 'escalation' : 'inserted';
  ledger.ingest_audit.push({ sequence, observed_at: at, event_id: event.event_id, result, source });
  return { status: result, event: clone(record) };
}

function requireKnownEvent(ledger, eventId) {
  const event = findEvent(ledger, eventId);
  assert(event, 'UNKNOWN_EVENT', `unknown event_id ${eventId}`, { eventId });
  return event;
}

export function recordDeliveryEvidence(ledger, eventId, evidence) {
  assertLedger(ledger);
  requireKnownEvent(ledger, eventId);
  assert(isPlainObject(evidence), 'INVALID_DELIVERY_EVIDENCE', 'delivery evidence must be an object');
  const status = nonEmptyString(evidence.status, 'status');
  assert(DELIVERY_STATUSES.includes(status), 'INVALID_DELIVERY_EVIDENCE', `unsupported delivery status ${status}`);
  const record = {
    event_id: eventId,
    observed_at: nowIso(evidence.observed_at),
    channel: nonEmptyString(evidence.channel, 'channel'),
    status,
    ...(evidence.receipt_id === undefined ? {} : { receipt_id: nonEmptyString(evidence.receipt_id, 'receipt_id') }),
    ...(evidence.source === undefined ? {} : { source: nonEmptyString(evidence.source, 'source') }),
    ...(evidence.latency_ms === undefined ? {} : { latency_ms: finiteNumber(evidence.latency_ms, 'latency_ms') }),
  };
  ledger.delivery_evidence.push(record);
  return clone(record);
}

export function recordQualityLabel(ledger, eventId, label, { labeledAt, note = null, reviewer = 'offline' } = {}) {
  assertLedger(ledger);
  requireKnownEvent(ledger, eventId);
  assert(QUALITY_LABELS.includes(label), 'INVALID_LABEL', `unsupported quality label ${label}`);
  const record = {
    event_id: eventId,
    label,
    labeled_at: nowIso(labeledAt),
    reviewer: nonEmptyString(reviewer, 'reviewer'),
    ...(note === null ? {} : { note: nonEmptyString(note, 'note') }),
  };
  ledger.labels.push(record);
  return clone(record);
}

export function recordCorrectnessEvidence(ledger, eventId, evidence) {
  assertLedger(ledger);
  requireKnownEvent(ledger, eventId);
  assert(isPlainObject(evidence), 'INVALID_CORRECTNESS_EVIDENCE', 'correctness evidence must be an object');
  const record = {
    event_id: eventId,
    assessed_at: nowIso(evidence.assessed_at),
    assessment: nonEmptyString(evidence.assessment, 'assessment'),
    evidence_ref: evidence.evidence_ref === undefined ? null : nonEmptyString(evidence.evidence_ref, 'evidence_ref'),
  };
  ledger.correctness_evidence.push(record);
  return clone(record);
}

export function recordInvestmentOutcome(ledger, eventId, outcome) {
  assertLedger(ledger);
  requireKnownEvent(ledger, eventId);
  assert(isPlainObject(outcome), 'INVALID_INVESTMENT_OUTCOME', 'investment outcome must be an object');
  const record = {
    event_id: eventId,
    observed_at: nowIso(outcome.observed_at),
    horizon: nonEmptyString(outcome.horizon, 'horizon'),
    status: nonEmptyString(outcome.status, 'status'),
    ...(outcome.return_fraction === undefined ? {} : { return_fraction: finiteNumber(outcome.return_fraction, 'return_fraction') }),
  };
  ledger.investment_outcomes.push(record);
  return clone(record);
}

export function assessExpiryHealth(alerts, {
  now = new Date().toISOString(),
  renewalWarningMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  assert(Array.isArray(alerts), 'INVALID_EXPIRY_INPUT', 'alerts must be an array');
  finiteNumber(renewalWarningMs, 'renewalWarningMs');
  const asOf = new Date(now);
  assert(!Number.isNaN(asOf.valueOf()), 'INVALID_TIME', 'now must be an ISO timestamp');
  const rows = alerts.map((alert, index) => {
    assert(isPlainObject(alert), 'INVALID_EXPIRY_INPUT', `alert ${index} must be an object`);
    const alertId = nonEmptyString(alert.alert_id ?? `alert-${index}`, 'alert_id');
    const hasExpiryRecord = typeof alert.expires_at === 'string' && typeof alert.maximum_expiry_at_creation === 'string';
    const expiresAt = new Date(alert.expires_at);
    const maximum = new Date(alert.maximum_expiry_at_creation);
    const validExpiryRecord = hasExpiryRecord && !Number.isNaN(expiresAt.valueOf()) && !Number.isNaN(maximum.valueOf());
    const invariantViolation = !validExpiryRecord || expiresAt.valueOf() !== maximum.valueOf();
    const remainingMs = expiresAt.valueOf() - asOf.valueOf();
    const status = invariantViolation ? 'invariant_violation'
      : remainingMs <= 0 ? 'expired'
        : remainingMs <= renewalWarningMs ? 'renewal_warning' : 'ok';
    return {
      alert_id: alertId,
      expires_at: validExpiryRecord ? expiresAt.toISOString() : null,
      maximum_expiry_at_creation: validExpiryRecord ? maximum.toISOString() : null,
      status,
      remaining_ms: validExpiryRecord ? remainingMs : null,
      reconciliation_required: invariantViolation || status === 'renewal_warning' || status === 'expired',
      renewal_action: status === 'renewal_warning' || status === 'expired' || invariantViolation
        ? 'renew_at_maximum_platform_expiry' : null,
      invariant: invariantViolation
        ? (hasExpiryRecord ? 'shorter_or_invalid_than_recorded_platform_maximum' : 'missing_maximum_expiry_at_creation')
        : 'maximum_expiry_used',
    };
  });
  return {
    schema_version: 'cup-handle-expiry-health-v1',
    as_of: asOf.toISOString(),
    hard_invariant: 'every alert expiry must equal maximum_expiry_at_creation',
    alerts: rows,
    invariant_violations: rows.filter(row => row.status === 'invariant_violation').map(row => row.alert_id),
    renewal_warnings: rows.filter(row => row.status === 'renewal_warning').map(row => row.alert_id),
    expired: rows.filter(row => row.status === 'expired').map(row => row.alert_id),
    all_maximum_expiry: rows.every(row => row.status !== 'invariant_violation'),
  };
}

function normalizeManifestPair(pair) {
  assert(isPlainObject(pair), 'INVALID_COVERAGE_MANIFEST', 'intended pair must be an object');
  for (const field of ['symbol', 'timeframe', 'profile', 'asset_class']) nonEmptyString(pair[field], `pair.${field}`);
  return {
    ...clone(pair),
    pair_id: nonEmptyString(pair.pair_id ?? pairKey(pair), 'pair_id'),
    expected_source_hashes: clone(pair.expected_source_hashes ?? {}),
    expected_input_definition: clone(pair.expected_input_definition ?? {}),
    expected_feed: pair.expected_feed ?? null,
    enabled: pair.enabled !== false,
  };
}

function exactPairMatch(pair, alert) {
  return pair.symbol === alert.symbol && pair.timeframe === alert.timeframe && pair.profile === alert.profile;
}

export function assessCoverage({
  intendedPairs = [],
  activeAlerts = [],
  unsupportedExclusions = [],
  now = new Date().toISOString(),
  expiryHealth = null,
} = {}) {
  assert(Array.isArray(intendedPairs) && Array.isArray(activeAlerts) && Array.isArray(unsupportedExclusions), 'INVALID_COVERAGE_MANIFEST', 'coverage inputs must be arrays');
  const pairs = intendedPairs.map(normalizeManifestPair);
  const alerts = activeAlerts.map((alert, index) => {
    assert(isPlainObject(alert), 'INVALID_COVERAGE_ALERT', `active alert ${index} must be an object`);
    for (const field of ['symbol', 'timeframe', 'profile']) nonEmptyString(alert[field], `alert.${field}`);
    return { ...clone(alert), alert_id: nonEmptyString(alert.alert_id ?? `alert-${index}`, 'alert_id'), enabled: alert.enabled !== false };
  });
  const exclusions = unsupportedExclusions.map(item => ({ ...clone(item), pair_key: item.pair_key ?? pairKey(item), reason: nonEmptyString(item.reason, 'reason') }));
  const omitted = [];
  const duplicatePairs = [];
  const sourceDrift = [];
  const inputDrift = [];
  const feedDrift = [];
  const disabledAlerts = [];
  const exactActivePairs = [];
  const usedAlertIds = new Set();

  for (const pair of pairs) {
    const matching = alerts.filter(alert => exactPairMatch(pair, alert));
    const supportedExcluded = exclusions.some(exclusion => exclusion.pair_key === pairKey(pair) || exclusion.pair_id === pair.pair_id);
    const exact = matching.filter(alert => (
      JSON.stringify(canonicalize(alert.source_hashes ?? {})) === JSON.stringify(canonicalize(pair.expected_source_hashes))
      && JSON.stringify(canonicalize(alert.input_definition ?? {})) === JSON.stringify(canonicalize(pair.expected_input_definition))
      && (pair.expected_feed === null || alert.feed === pair.expected_feed)
      && alert.enabled
    ));
    if (exact.length === 1 && !supportedExcluded && pair.enabled) {
      exactActivePairs.push({ pair_id: pair.pair_id, alert_id: exact[0].alert_id, pair_key: pairKey(pair) });
      usedAlertIds.add(exact[0].alert_id);
    }
    if (matching.length > 1) duplicatePairs.push({ pair_id: pair.pair_id, alert_ids: matching.map(alert => alert.alert_id) });
    if (matching.length === 0 && !supportedExcluded && pair.enabled) omitted.push({ pair_id: pair.pair_id, pair_key: pairKey(pair), reason: 'no_active_alert' });
    if (matching.length > 0 && exact.length === 0 && !supportedExcluded && pair.enabled) omitted.push({ pair_id: pair.pair_id, pair_key: pairKey(pair), reason: 'no_exact_active_alert' });
    for (const alert of matching) {
      if (!alert.enabled) disabledAlerts.push({ pair_id: pair.pair_id, alert_id: alert.alert_id });
      if (JSON.stringify(canonicalize(alert.source_hashes ?? {})) !== JSON.stringify(canonicalize(pair.expected_source_hashes))) {
        sourceDrift.push({ pair_id: pair.pair_id, alert_id: alert.alert_id });
      }
      if (JSON.stringify(canonicalize(alert.input_definition ?? {})) !== JSON.stringify(canonicalize(pair.expected_input_definition))) {
        inputDrift.push({ pair_id: pair.pair_id, alert_id: alert.alert_id });
      }
      if (pair.expected_feed !== null && alert.feed !== pair.expected_feed) {
        feedDrift.push({ pair_id: pair.pair_id, alert_id: alert.alert_id, expected: pair.expected_feed, actual: alert.feed ?? null });
      }
    }
  }
  const duplicateAlertIds = alerts.filter(alert => !usedAlertIds.has(alert.alert_id) && !pairs.some(pair => exactPairMatch(pair, alert))).map(alert => alert.alert_id);
  const unsupported = exclusions.map(exclusion => ({ ...exclusion, matched_intended_pair: pairs.some(pair => exclusion.pair_key === pairKey(pair) || exclusion.pair_id === pair.pair_id) }));
  const resolvedExpiryHealth = expiryHealth ?? (alerts.length > 0 ? assessExpiryHealth(alerts, { now }) : null);
  return {
    schema_version: 'cup-handle-coverage-health-v1',
    as_of: nowIso(now),
    manifest_configured: pairs.length > 0,
    intended_pairs: pairs,
    exact_active_pairs: exactActivePairs,
    omissions: omitted,
    duplicate_pairs: duplicatePairs,
    duplicate_alert_ids: duplicateAlertIds,
    unexpected_active_alert_ids: duplicateAlertIds,
    source_drift: sourceDrift,
    input_drift: inputDrift,
    feed_drift: feedDrift,
    disabled_alerts: disabledAlerts,
    unsupported_exclusions: unsupported,
    expiry_health: resolvedExpiryHealth,
    healthy: pairs.length > 0 && omitted.length === 0 && duplicatePairs.length === 0 && sourceDrift.length === 0
      && inputDrift.length === 0 && feedDrift.length === 0 && disabledAlerts.length === 0
      && (!resolvedExpiryHealth || resolvedExpiryHealth.all_maximum_expiry),
  };
}

function groupKey(parts) {
  return parts.map(value => String(value ?? 'unknown')).join('|');
}

function emptyMetric(key) {
  return {
    key,
    events: 0,
    unique_events: 0,
    duplicate_ingests: 0,
    escalations: 0,
    labels: Object.fromEntries(QUALITY_LABELS.map(label => [label, 0])),
    delivery: Object.fromEntries(DELIVERY_STATUSES.map(status => [status, 0])),
    terminal_lifecycle: { PRICE_BREAKOUT_CONFIRMED: 0, INVALIDATED: 0, EXPIRED: 0 },
    correctness_assessments: 0,
    investment_outcomes: 0,
  };
}

function updateMetric(metric, event, ledger) {
  metric.events += 1;
  metric.unique_events += 1;
  const labels = ledger.labels.filter(label => label.event_id === event.event_id);
  for (const label of labels) metric.labels[label.label] += 1;
  const deliveries = ledger.delivery_evidence.filter(item => item.event_id === event.event_id);
  for (const delivery of deliveries) metric.delivery[delivery.status] += 1;
  if (TERMINAL_STAGES.includes(event.to_stage)) metric.terminal_lifecycle[event.to_stage] += 1;
  metric.correctness_assessments += ledger.correctness_evidence.filter(item => item.event_id === event.event_id).length;
  metric.investment_outcomes += ledger.investment_outcomes.filter(item => item.event_id === event.event_id).length;
}

function metricsFor(events, ledger, dimension) {
  const map = new Map();
  for (const event of events) {
    const values = dimension === 'cohort' ? [event.cohort]
      : dimension === 'family' ? [event.family_id]
        : dimension === 'stage' ? [event.to_stage]
          : dimension === 'timeframe' ? [event.timeframe]
            : [event.asset_class, event.timeframe, event.profile];
    const key = groupKey(values);
    if (!map.has(key)) map.set(key, emptyMetric(key));
    updateMetric(map.get(key), event, ledger);
  }
  return [...map.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function sampleFalseNegatives(nonAlertedCharts, { sampleRate = 1, limit = 100 } = {}) {
  assert(Array.isArray(nonAlertedCharts), 'INVALID_FALSE_NEGATIVE_INPUT', 'nonAlertedCharts must be an array');
  finiteNumber(sampleRate, 'sampleRate');
  assert(sampleRate > 0 && sampleRate <= 1, 'INVALID_FALSE_NEGATIVE_INPUT', 'sampleRate must be in (0, 1]');
  assert(Number.isInteger(limit) && limit > 0, 'INVALID_FALSE_NEGATIVE_INPUT', 'limit must be a positive integer');
  const candidates = nonAlertedCharts.filter(chart => chart && chart.alerted === false).map((chart, index) => {
    assert(isPlainObject(chart), 'INVALID_FALSE_NEGATIVE_INPUT', `chart ${index} must be an object`);
    const chartId = nonEmptyString(chart.chart_id ?? `${chart.symbol}|${chart.timeframe}|${chart.observed_at}`, 'chart_id');
    const score = Number.parseInt(sha256(chartId).slice(0, 8), 16) / 0xffffffff;
    return { ...clone(chart), chart_id: chartId, sample_score: score };
  }).filter(chart => chart.sample_score <= sampleRate).sort((left, right) => left.sample_score - right.sample_score).slice(0, limit);
  return { schema_version: 'cup-handle-false-negative-queue-v1', sample_rate: sampleRate, limit, candidates };
}

export function buildWeeklyQualitySummary(ledger, {
  weekStart,
  weekEnd,
  nonAlertedCharts = [],
  falseNegativeSampleRate = 1,
  falseNegativeLimit = 100,
} = {}) {
  assertLedger(ledger);
  const start = new Date(weekStart);
  const end = new Date(weekEnd);
  assert(!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf()) && end > start, 'INVALID_WEEK', 'weekStart/weekEnd must define a positive interval');
  const events = ledger.events.filter(event => {
    const time = new Date(event.detection_bar_close_ms);
    return time >= start && time < end;
  });
  const duplicateIngests = ledger.ingest_audit.filter(item => item.result === 'duplicate' && new Date(item.observed_at) >= start && new Date(item.observed_at) < end).length;
  const escalations = ledger.ingest_audit.filter(item => item.result === 'escalation' && new Date(item.observed_at) >= start && new Date(item.observed_at) < end).length;
  const base = emptyMetric('all');
  for (const event of events) updateMetric(base, event, ledger);
  base.duplicate_ingests = duplicateIngests;
  base.escalations = escalations;
  return {
    schema_version: 'cup-handle-weekly-quality-v1',
    week_start: start.toISOString(),
    week_end: end.toISOString(),
    status_label: 'monitored_beta_observability_only',
    efficacy_claim: false,
    trading_return_claim: false,
    all: base,
    by_cohort: metricsFor(events, ledger, 'cohort'),
    by_family: metricsFor(events, ledger, 'family'),
    by_stage: metricsFor(events, ledger, 'stage'),
    by_timeframe: metricsFor(events, ledger, 'timeframe'),
    by_asset_timeframe_profile: metricsFor(events, ledger, 'profile'),
    false_negative_sampling_queue: sampleFalseNegatives(nonAlertedCharts, {
      sampleRate: falseNegativeSampleRate,
      limit: falseNegativeLimit,
    }),
  };
}

export function sealLedger(ledger, sealedAt = new Date().toISOString()) {
  assertLedger(ledger);
  const body = clone(ledger);
  return { schema_version: 'cup-handle-sealed-ledger-v1', sealed_at: nowIso(sealedAt), content_sha256: sha256(body), ledger: body };
}

export function importSealedLedger(bundle) {
  assert(isPlainObject(bundle) && bundle.schema_version === 'cup-handle-sealed-ledger-v1' && bundle.ledger, 'LEDGER_RESEALED', 'invalid sealed ledger bundle');
  assert(bundle.content_sha256 === sha256(bundle.ledger), 'LEDGER_RESEALED', 'sealed ledger content hash does not match');
  assertLedger(bundle.ledger);
  return clone(bundle.ledger);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function metricTable(title, rows) {
  const body = rows.length === 0
    ? '<tr><td colspan="4">No validated observations</td></tr>'
    : rows.map(row => `<tr><td>${escapeHtml(row.key)}</td><td>${row.events}</td><td>${row.labels.useful}</td><td>${row.delivery.delivered}</td></tr>`).join('');
  return `<section><h2>${escapeHtml(title)}</h2><table><thead><tr><th>Group</th><th>Events</th><th>Useful labels</th><th>Delivered evidence</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function validateStatusData({ ledger, coverage, weekly }) {
  assertLedger(ledger);
  assert(isPlainObject(coverage) && coverage.schema_version === 'cup-handle-coverage-health-v1', 'INVALID_STATUS_DATA', 'coverage is not validated coverage health');
  assert(isPlainObject(weekly) && weekly.schema_version === 'cup-handle-weekly-quality-v1', 'INVALID_STATUS_DATA', 'weekly is not a validated quality summary');
  assert(weekly.efficacy_claim === false && weekly.trading_return_claim === false, 'INVALID_STATUS_DATA', 'status report refuses efficacy or trading claims');
}

export function generateStatusHtml({ ledger, coverage, weekly, generatedAt = new Date().toISOString() } = {}) {
  validateStatusData({ ledger, coverage, weekly });
  const generated = nowIso(generatedAt);
  const expiry = coverage.expiry_health;
  const warningCount = expiry?.renewal_warnings?.length ?? 0;
  const violationCount = expiry?.invariant_violations?.length ?? 0;
  const coverageStatus = coverage.healthy ? 'healthy' : 'attention required';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cup-and-Handle monitored beta status</title>
<style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172033;background:#fbfcfe}section{background:#fff;border:1px solid #d8deea;border-radius:8px;padding:1rem;margin:1rem 0}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e9f0;padding:.45rem;text-align:left}th{background:#eef2f8}.notice{padding:.8rem;border-left:4px solid #3857d6;background:#eef2ff}.warn{border-left-color:#b26a00;background:#fff8e8}.muted{color:#566176}</style></head>
<body><h1>Cup-and-Handle monitored beta status</h1>
<p class="muted">Generated ${escapeHtml(generated)} · schema ${escapeHtml(MONITORING_SCHEMA_VERSION)}</p>
<div class="notice">This report describes monitored-beta observability: event intake, delivery evidence, human labels, coverage, and expiry health. It is not predictive efficacy evidence and does not report trading returns.</div>
<section><h2>Coverage and expiry</h2><p>Coverage: <strong>${escapeHtml(coverageStatus)}</strong>. Exact active pairs: ${coverage.exact_active_pairs.length}. Omissions: ${coverage.omissions.length}. Duplicate pairs: ${coverage.duplicate_pairs.length}. Source/input/feed drift: ${coverage.source_drift.length + coverage.input_drift.length + coverage.feed_drift.length}. Disabled alerts: ${coverage.disabled_alerts.length}. Unsupported exclusions: ${coverage.unsupported_exclusions.length}.</p>
<p class="${violationCount || warningCount ? 'warn' : ''}">Maximum-expiry invariant violations: ${violationCount}. Renewal warnings: ${warningCount}. Renewal action, when needed, is to renew at the maximum platform expiry recorded at creation; this report never recommends a shorter expiry.</p></section>
${metricTable('By cohort', weekly.by_cohort)}
${metricTable('By family', weekly.by_family)}
${metricTable('By stage', weekly.by_stage)}
${metricTable('By timeframe', weekly.by_timeframe)}
<section><h2>False-negative review queue</h2><p>${weekly.false_negative_sampling_queue.candidates.length} non-alerted chart observations sampled for human review. This queue is a review aid, not a recall estimate.</p><ul>${weekly.false_negative_sampling_queue.candidates.map(item => `<li>${escapeHtml(item.chart_id)}</li>`).join('')}</ul></section>
<section><h2>Evidence boundaries</h2><p>Detector correctness labels, delivery evidence, and investment outcomes are stored as separate dimensions. Invalidated and expired lifecycle events remain explicit. Live firing, mobile delivery, deduplication, predictive quality, and trading efficacy are not inferred from this offline report.</p></section>
</body></html>`;
}

export async function writeStatusHtml(outputPath, data) {
  const html = generateStatusHtml(data);
  await writeFile(outputPath, html, 'utf8');
  return { outputPath, bytes: Buffer.byteLength(html), sha256: sha256(html) };
}

export async function readSealedLedger(path) {
  const source = await readFile(path, 'utf8');
  return importSealedLedger(JSON.parse(source));
}
