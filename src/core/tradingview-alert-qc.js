import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { evaluate, getClient, getTargetInfo } from '../connection.js';
import { list as listTradingViewAlerts } from './alerts.js';
import {
  classifyInvestmentAttentionAlert,
  normalizeInvestmentAttentionLiveAlert,
} from './investment-attention-live-snapshot.js';
import { canonicalJson, sha256 } from './investment-attention-ledger.js';
import {
  normalizeTradingViewAlertLogRows,
  occurrenceWithinWindow,
  parseTradingViewAlertsLogCsv,
  summarizeAlertLogOccurrences,
} from './tradingview-alert-log.js';

export const TRADINGVIEW_ALERT_QC_SCHEMA_VERSION = 'tradingview-alert-qc/v1';
export const TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION = 'tradingview-alert-qc-expected/v1';
export const DEFAULT_TRADINGVIEW_ALERT_QC_HOME = join(homedir(), '.codex', 'tradingview-alert-qc');
export const DEFAULT_TRADINGVIEW_ALERT_QC_BACKLOG = '/Users/odin/projects/omega/wiki/codebases/tradingview-mcp/investment-attention-alert-qc-improvements.md';

const JSONL_FILENAME = 'alert-occurrences.jsonl';
const COLLECTION_STATE_FILENAME = 'collection-state.json';
const WRITER_LOCK_FILENAME = 'writer.lock';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATED_START = '<!-- tradingview-alert-qc:generated:start -->';
const GENERATED_END = '<!-- tradingview-alert-qc:generated:end -->';
const REVIEW_STATUSES = new Set(['proposed', 'accepted', 'rejected', 'implemented', 'deferred', 'closed']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asIso(value, label = 'timestamp') {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compareValue(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

function safePath(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`${label} must be an absolute path`);
  return resolve(path);
}

function assertNotSymlink(path, label) {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  return true;
}

function ensurePrivateDirectory(path) {
  const root = safePath(path, 'private directory');
  if (existsSync(root)) {
    assertNotSymlink(root, 'private directory');
    if (!lstatSync(root).isDirectory()) throw new Error(`private directory is not a directory: ${root}`);
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  chmodSync(root, 0o700);
  return root;
}

function ensurePrivateFile(path, label = 'private file') {
  const target = safePath(path, label);
  if (existsSync(target)) {
    assertNotSymlink(target, label);
    if (!lstatSync(target).isFile()) throw new Error(`${label} is not a regular file: ${target}`);
  }
  return target;
}

function atomicWrite(path, content, { mode = 0o600, label = 'file', parentMode = null } = {}) {
  const target = safePath(path, label);
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: parentMode ?? 0o700 });
  assertNotSymlink(parent, `${label} parent`);
  assertNotSymlink(target, label);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
  chmodSync(target, mode);
  return target;
}

function readRegularText(path, label = 'file') {
  const target = ensurePrivateFile(path, label);
  return readFileSync(target, 'utf8');
}

function readJson(path, label = 'JSON file') {
  return JSON.parse(readRegularText(path, label));
}

function readJsonIfPresent(path, label = 'JSON file') {
  if (!existsSync(path)) return null;
  return readJson(path, label);
}

export function tradingViewAlertQcPaths(home = DEFAULT_TRADINGVIEW_ALERT_QC_HOME, backlogPath = DEFAULT_TRADINGVIEW_ALERT_QC_BACKLOG) {
  const root = safePath(home, 'TradingView alert QC home');
  const rawDir = join(root, 'raw');
  const runtimeDir = join(root, 'runtime');
  const reportsDir = join(root, 'reports');
  return {
    root,
    raw_dir: rawDir,
    runtime_dir: runtimeDir,
    reports_dir: reportsDir,
    occurrences_path: join(runtimeDir, JSONL_FILENAME),
    collection_state_path: join(runtimeDir, COLLECTION_STATE_FILENAME),
    lock_path: join(runtimeDir, WRITER_LOCK_FILENAME),
    backlog_path: safePath(backlogPath, 'TradingView alert QC backlog'),
  };
}

export function prepareTradingViewAlertQcHome(home = DEFAULT_TRADINGVIEW_ALERT_QC_HOME, backlogPath = DEFAULT_TRADINGVIEW_ALERT_QC_BACKLOG) {
  const paths = tradingViewAlertQcPaths(home, backlogPath);
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.raw_dir);
  ensurePrivateDirectory(paths.runtime_dir);
  ensurePrivateDirectory(paths.reports_dir);
  return paths;
}

export async function withTradingViewAlertQcWriterLock(home, callback, { backlogPath = DEFAULT_TRADINGVIEW_ALERT_QC_BACKLOG } = {}) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const paths = prepareTradingViewAlertQcHome(home, backlogPath);
  let descriptor;
  try {
    descriptor = openSync(paths.lock_path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), 'utf8');
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new Error(`TradingView alert QC writer lock is held or unavailable: ${error.message}`);
  }
  try {
    return await callback(paths);
  } finally {
    try {
      if (existsSync(paths.lock_path)) {
        assertNotSymlink(paths.lock_path, 'TradingView alert QC writer lock');
        unlinkSync(paths.lock_path);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function alertMaps(expectedConfig) {
  const expected = Array.isArray(expectedConfig?.alerts) ? expectedConfig.alerts : [];
  return {
    by_id: new Map(expected.filter(row => row.alert_id != null).map(row => [String(row.alert_id), row])),
    by_key: new Map(expected.filter(row => row.expected_key).map(row => [String(row.expected_key), row])),
  };
}

function sourceHashFromAlert(alert) {
  const candidates = [alert?.source_sha256, alert?.pine_source_sha256, alert?.source_hash];
  return candidates.find(value => typeof value === 'string' && SHA256.test(value)) ?? null;
}

function sourceDefinitionFromAlert(alert) {
  return nonempty(alert?.definition_version ?? alert?.source_definition_version);
}

function observedNotificationPresence(alert, field) {
  if (alert?.notification_field_presence && Object.hasOwn(alert.notification_field_presence, field)) {
    return alert.notification_field_presence[field] === true;
  }
  return Object.hasOwn(alert ?? {}, field);
}

/** Normalize only the four managed families; unrelated alerts stay visible in inventory counts. */
export function normalizeTradingViewAlertInventory(alerts) {
  if (!Array.isArray(alerts)) throw new TypeError('alerts must be an array');
  const managed = [];
  const unmanaged = [];
  for (const alert of alerts) {
    const classification = classifyInvestmentAttentionAlert(alert);
    if (!classification) {
      unmanaged.push(clone(alert));
      continue;
    }
    const scriptId = classification.script.script_id;
    const sourceSha = sourceHashFromAlert(alert);
    const definition = sourceDefinitionFromAlert(alert);
    const sourceShaByScriptId = sourceSha && scriptId ? { [scriptId]: sourceSha } : {};
    const definitionByScriptId = definition && scriptId ? { [scriptId]: definition } : {};
    const normalized = normalizeInvestmentAttentionLiveAlert(alert, {
      sourceShaByScriptId,
      definitionByScriptId,
      includeAllRsiSlots: true,
    });
    if (!normalized) {
      unmanaged.push(clone(alert));
      continue;
    }
    managed.push({
      ...normalized,
      source_sha256: sourceSha,
      definition_version: definition,
      source_hash_status: sourceSha ? 'observed' : 'unverified',
      definition_status: definition ? 'observed' : 'unverified',
      notification_field_presence: Object.fromEntries([
        'popup', 'mobile_push', 'web_hook', 'email', 'sms_over_email', 'auto_deactivate',
      ].map(field => [field, observedNotificationPresence(alert, field)])),
    });
  }
  return { managed, unmanaged };
}

function addFinding(collection, value) {
  collection.push(value);
}

function expirationMs(value) {
  if (!value) return null;
  const time = new Date(value).valueOf();
  return Number.isNaN(time) ? null : time;
}

function compareInventory(expectedConfig, observedInventory, observedAt) {
  const expected = Array.isArray(expectedConfig?.alerts) ? expectedConfig.alerts : [];
  const observed = Array.isArray(observedInventory?.managed) ? observedInventory.managed : [];
  const expectedByKey = new Map(expected.map(row => [String(row.expected_key), row]));
  const observedByKey = new Map();
  for (const row of observed) {
    const key = String(row.expected_key ?? '');
    const rows = observedByKey.get(key) ?? [];
    rows.push(row);
    observedByKey.set(key, rows);
  }
  const missing = [];
  const stopped = [];
  const expired = [];
  const alertIdDrift = [];
  const sourceIdentityDrift = [];
  const sourceUnverified = [];
  const definitionUnverified = [];
  const inputDrift = [];
  const inputUnverified = [];
  const notificationDrift = [];
  const notificationUnverified = [];
  const feedDrift = [];
  const routeDrift = [];
  const expirationDrift = [];
  const duplicateKeys = [];
  const unexpected = [];
  const observedAtMs = new Date(observedAt).valueOf();
  const notificationFields = ['popup', 'mobile_push', 'web_hook'];

  for (const [key, rows] of observedByKey.entries()) {
    if (!expectedByKey.has(key)) unexpected.push(...rows.map(row => ({
      expected_key: row.expected_key,
      alert_id: row.alert_id,
      family: row.family,
      active: row.active,
    })));
    if (rows.length > 1) duplicateKeys.push({ expected_key: key, alert_ids: rows.map(row => row.alert_id) });
  }

  for (const expectedRow of expected) {
    const key = String(expectedRow.expected_key);
    const rows = observedByKey.get(key) ?? [];
    const observedRow = rows[0] ?? null;
    if (!observedRow) {
      addFinding(missing, {
        expected_key: key,
        expected_alert_id: expectedRow.alert_id ?? null,
        family: expectedRow.family ?? null,
      });
      continue;
    }
    if (expectedRow.active === true && observedRow.active === false) {
      addFinding(stopped, { expected_key: key, alert_id: observedRow.alert_id });
    }
    const observedExpirationMs = expirationMs(observedRow.expiration);
    if (observedExpirationMs !== null && observedExpirationMs <= observedAtMs) {
      addFinding(expired, { expected_key: key, alert_id: observedRow.alert_id, expiration: observedRow.expiration });
    }
    if (String(expectedRow.alert_id ?? '') !== String(observedRow.alert_id ?? '')) {
      addFinding(alertIdDrift, {
        expected_key: key,
        expected_alert_id: expectedRow.alert_id ?? null,
        observed_alert_id: observedRow.alert_id ?? null,
      });
    }
    const expectedSource = stableObject(expectedRow.source_identity);
    const sourceChecks = [
      ['script_id', 'script_id'],
      ['script_version', 'script_version'],
    ];
    for (const [expectedField, observedField] of sourceChecks) {
      if (expectedSource[expectedField] != null && String(expectedSource[expectedField]) !== String(observedRow[observedField] ?? '')) {
        addFinding(sourceIdentityDrift, {
          expected_key: key,
          alert_id: observedRow.alert_id,
          field: expectedField,
          expected: expectedSource[expectedField],
          observed: observedRow[observedField] ?? null,
        });
      }
    }
    if (expectedSource.source_sha256) {
      if (!observedRow.source_sha256) addFinding(sourceUnverified, { expected_key: key, alert_id: observedRow.alert_id });
      else if (expectedSource.source_sha256 !== observedRow.source_sha256) addFinding(sourceIdentityDrift, {
        expected_key: key,
        alert_id: observedRow.alert_id,
        field: 'source_sha256',
        expected: expectedSource.source_sha256,
        observed: observedRow.source_sha256,
      });
    }
    if (expectedSource.definition_version) {
      if (!observedRow.definition_version) addFinding(definitionUnverified, { expected_key: key, alert_id: observedRow.alert_id });
      else if (expectedSource.definition_version !== observedRow.definition_version) addFinding(sourceIdentityDrift, {
        expected_key: key,
        alert_id: observedRow.alert_id,
        field: 'definition_version',
        expected: expectedSource.definition_version,
        observed: observedRow.definition_version,
      });
    }
    const expectedInput = stableObject(expectedRow.input_identity);
    if (!Object.keys(stableObject(observedRow.input_values)).length) addFinding(inputUnverified, {
      expected_key: key,
      alert_id: observedRow.alert_id,
    });
    else if (expectedInput.sha256 && expectedInput.sha256 !== observedRow.input_sha256) addFinding(inputDrift, {
      expected_key: key,
      alert_id: observedRow.alert_id,
      expected: expectedInput.sha256,
      observed: observedRow.input_sha256,
    });
    const expectedFeed = expectedRow.feed_symbol ?? null;
    if (expectedFeed && String(expectedFeed).toUpperCase() !== String(observedRow.feed_symbol ?? '').toUpperCase()) addFinding(feedDrift, {
      expected_key: key,
      alert_id: observedRow.alert_id,
      expected: expectedFeed,
      observed: observedRow.feed_symbol ?? null,
    });
    if (String(expectedRow.route_symbol ?? expectedRow.symbol ?? '').toUpperCase() !== String(observedRow.route_symbol ?? '').toUpperCase()
      || String(expectedRow.route_timeframe ?? expectedRow.timeframe ?? '').toUpperCase() !== String(observedRow.route_timeframe ?? '').toUpperCase()) {
      addFinding(routeDrift, {
        expected_key: key,
        alert_id: observedRow.alert_id,
        expected: { symbol: expectedRow.route_symbol ?? expectedRow.symbol ?? null, timeframe: expectedRow.route_timeframe ?? expectedRow.timeframe ?? null },
        observed: { symbol: observedRow.route_symbol ?? null, timeframe: observedRow.route_timeframe ?? null },
      });
    }
    for (const field of notificationFields) {
      const expectedValue = expectedRow[field] ?? null;
      if (!observedRow.notification_field_presence?.[field]) {
        addFinding(notificationUnverified, { expected_key: key, alert_id: observedRow.alert_id, field });
      } else if (!compareValue(expectedValue, observedRow[field] ?? null)) {
        addFinding(notificationDrift, {
          expected_key: key,
          alert_id: observedRow.alert_id,
          field,
          expected: expectedValue,
          observed: observedRow[field] ?? null,
        });
      }
    }
    if (expectedRow.expiration && observedRow.expiration && String(expectedRow.expiration) !== String(observedRow.expiration)) addFinding(expirationDrift, {
      expected_key: key,
      alert_id: observedRow.alert_id,
      expected: expectedRow.expiration,
      observed: observedRow.expiration,
    });
  }

  const configDrift = [
    ...alertIdDrift,
    ...sourceIdentityDrift,
    ...inputDrift,
    ...notificationDrift,
    ...feedDrift,
    ...routeDrift,
    ...expirationDrift,
  ];
  const evidenceGaps = [
    ...sourceUnverified,
    ...definitionUnverified,
    ...inputUnverified,
    ...notificationUnverified,
  ];
  return {
    expected_count: expected.length,
    observed_managed_count: observed.length,
    observed_active_managed_count: observed.filter(row => row.active === true).length,
    observed_unmanaged_count: Array.isArray(observedInventory?.unmanaged) ? observedInventory.unmanaged.length : 0,
    missing,
    stopped,
    expired,
    unexpected,
    duplicate_expected_keys: duplicateKeys,
    alert_id_drift: alertIdDrift,
    source_identity_drift: sourceIdentityDrift,
    source_unverified: sourceUnverified,
    definition_unverified: definitionUnverified,
    input_drift: inputDrift,
    input_unverified: inputUnverified,
    notification_drift: notificationDrift,
    notification_unverified: notificationUnverified,
    feed_drift: feedDrift,
    route_drift: routeDrift,
    expiration_drift: expirationDrift,
    config_drift: configDrift,
    evidence_gaps: evidenceGaps,
    counts: {
      missing: missing.length,
      stopped: stopped.length,
      expired: expired.length,
      unexpected: unexpected.length,
      duplicate_expected_keys: duplicateKeys.length,
      config_drift: configDrift.length,
      source_unverified: sourceUnverified.length,
      definition_unverified: definitionUnverified.length,
      input_drift: inputDrift.length,
      input_unverified: inputUnverified.length,
      notification_drift: notificationDrift.length,
      notification_unverified: notificationUnverified.length,
      feed_drift: feedDrift.length,
      route_drift: routeDrift.length,
      expiration_drift: expirationDrift.length,
      evidence_gaps: evidenceGaps.length,
    },
    checked_at: asIso(observedAt, 'observedAt'),
  };
}

function reportableObservedInventoryRow(row) {
  return {
    alert_id: row.alert_id ?? null,
    expected_key: row.expected_key ?? null,
    family: row.family ?? null,
    active: row.active ?? null,
    symbol: row.route_symbol ?? null,
    timeframe: row.route_timeframe ?? null,
    feed_symbol: row.feed_symbol ?? null,
    created: row.created ?? null,
    last_fired: row.last_fired ?? null,
    expiration: row.expiration ?? null,
    script_id: row.script_id ?? null,
    script_version: row.script_version ?? null,
    source_sha256: row.source_sha256 ?? null,
    definition_version: row.definition_version ?? null,
    source_hash_status: row.source_hash_status ?? 'unverified',
    definition_status: row.definition_status ?? 'unverified',
    input_sha256: row.input_sha256 ?? null,
    input_values: clone(row.input_values ?? {}),
    popup: row.popup ?? null,
    mobile_push: row.mobile_push ?? null,
    web_hook: row.web_hook ?? null,
    notification_field_presence: clone(row.notification_field_presence ?? {}),
    stage_group: row.stage_group ?? null,
    target_id: row.target_id ?? null,
  };
}

function sourceTimes(occurrences) {
  return occurrences.map(row => row.source_fired_at_ms).filter(Number.isSafeInteger).sort((left, right) => left - right);
}

function occurrenceWindowSummary(occurrences, generatedAt, days) {
  const endMs = new Date(generatedAt).valueOf();
  const startMs = endMs - days * DAY_MS;
  const rows = occurrences.filter(row => occurrenceWithinWindow(row, startMs, endMs));
  const summary = summarizeAlertLogOccurrences(rows);
  return {
    days,
    source_window_start: new Date(startMs).toISOString(),
    source_window_end: new Date(endMs).toISOString(),
    notification_count: rows.length,
    signal_count: summary.signal_count,
    by_family: summary.by_family,
    by_status: summary.by_status,
    repeated_firing_alerts: summary.repeated_firings,
  };
}

function assessRsiMissSampling({ reference, expectedConfig, observedInventory, occurrences, collection, generatedAt }) {
  const emptyCounts = () => ({ expected_silence: 0, possible_miss: 0, confirmed_miss: 0, confirmed_firing: 0, not_verified: 0 });
  if (!reference) return {
    status: 'not_verified',
    reason: 'No independent verified RSI reference file was supplied.',
    outcomes: [],
    counts: emptyCounts(),
  };
  if (reference.verified !== true || reference.reference_kind !== 'independent_verified_reference' || !Array.isArray(reference.samples) || reference.samples.length === 0) return {
    status: 'not_verified',
    reason: 'Reference evidence is absent, not explicitly independent and verified, or has no samples.',
    outcomes: [],
    counts: { ...emptyCounts(), not_verified: reference.samples?.length ?? 0 },
  };
  const expectedByKey = alertMaps(expectedConfig).by_key;
  const observedByKey = new Map((observedInventory?.managed ?? []).map(row => [row.expected_key, row]));
  const counts = emptyCounts();
  const outcomes = reference.samples.map(sample => {
    const key = nonempty(sample.expected_key);
    const expected = key ? expectedByKey.get(key) : null;
    const observed = key ? observedByKey.get(key) : null;
    const expectedSource = stableObject(expected?.source_identity);
    const source = stableObject(sample.source_identity);
    const coverage = { ...stableObject(reference.coverage), ...stableObject(sample.coverage) };
    const eventTimeRaw = sample.event_time ?? sample.reference_time;
    const eventTimeMs = new Date(eventTimeRaw ?? '').valueOf();
    const coverageStartMs = new Date(coverage.window_start ?? '').valueOf();
    const coverageEndMs = new Date(coverage.window_end ?? '').valueOf();
    const routeSymbol = nonempty(sample.route_symbol ?? sample.symbol);
    const routeTimeframe = nonempty(sample.route_timeframe ?? sample.timeframe);
    const matchingOccurrence = (occurrences ?? []).some(row => row.identity?.expected_key === key
      && row.source_fired_at_ms === eventTimeMs);
    const checks = {
      expected_route: !!expected,
      current_route: !!observed && !!routeSymbol && !!routeTimeframe
        && String(observed.route_symbol ?? '').toUpperCase() === routeSymbol.toUpperCase()
        && String(observed.route_timeframe ?? '').toUpperCase() === routeTimeframe.toUpperCase(),
      current_source_identity: !!observed && !!expected && source.script_id === observed.script_id
        && String(source.script_version ?? '') === String(observed.script_version ?? '')
        && source.source_sha256 === observed.source_sha256
        && source.script_id === expectedSource.script_id
        && String(source.script_version ?? '') === String(expectedSource.script_version ?? '')
        && source.source_sha256 === expectedSource.source_sha256,
      current_input_identity: !!observed && !!expected && sample.input_sha256 === observed.input_sha256
        && sample.input_sha256 === expected.input_identity?.sha256,
      independent_observation: sample.independent_observation === true,
      expected_event_field: typeof sample.expected_event === 'boolean',
      fired_field: typeof sample.alert_fired === 'boolean',
      source_time: Number.isFinite(eventTimeMs) && eventTimeMs > 0,
      source_time_in_coverage: Number.isFinite(eventTimeMs) && Number.isFinite(coverageStartMs)
        && Number.isFinite(coverageEndMs) && eventTimeMs >= coverageStartMs && eventTimeMs < coverageEndMs,
      coverage_evidence: coverage.evidence_present === true
        && !!nonempty(coverage.evidence_ref)
        && nonempty(coverage.source) === 'TradingView Alerts Log CSV',
      collection_success: collection?.success === true,
      current_log_match: typeof sample.alert_fired === 'boolean' && matchingOccurrence === sample.alert_fired,
    };
    let outcome = 'not_verified';
    if (Object.values(checks).every(Boolean)) {
      if (sample.alert_fired) outcome = 'confirmed_firing';
      else if (!sample.expected_event) outcome = 'expected_silence';
      else outcome = coverage.complete_for_window === true ? 'confirmed_miss' : 'possible_miss';
    }
    counts[outcome] += 1;
    return {
      expected_key: key,
      expected_event: sample.expected_event ?? null,
      alert_fired: sample.alert_fired ?? null,
      observed_alert_id: observed?.alert_id ?? null,
      event_time: Number.isFinite(eventTimeMs) ? new Date(eventTimeMs).toISOString() : null,
      coverage: {
        window_start: Number.isFinite(coverageStartMs) ? new Date(coverageStartMs).toISOString() : null,
        window_end: Number.isFinite(coverageEndMs) ? new Date(coverageEndMs).toISOString() : null,
        complete_for_window: coverage.complete_for_window === true,
        evidence_ref: coverage.evidence_ref ?? null,
      },
      outcome,
      checks,
    };
  });
  const status = counts.not_verified > 0
    ? 'not_verified'
    : counts.confirmed_miss > 0
      ? 'confirmed_miss'
      : counts.possible_miss > 0
        ? 'possible_miss'
        : counts.confirmed_firing > 0
          ? 'confirmed_firing'
        : 'expected_silence';
  return {
    status,
    reason: 'Miss outcomes require current route/source/input identity, an event time, independent evidence, successful collection, and explicit Alerts Log coverage evidence.',
    sample_count: outcomes.length,
    outcomes,
    counts,
    generated_at: asIso(generatedAt),
  };
}

function evidenceRef(day, suffix) {
  return `TV-QC/${day}/${suffix}`;
}

function makeSuggestion({ id, title, evidenceRefs, firstSeen, lastSeen, recurrence, affectedAlerts, proposedChange, benefit, risk, test }) {
  return {
    id,
    title,
    evidence_refs: evidenceRefs,
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    recurrence,
    affected_alerts: affectedAlerts,
    proposed_change: proposedChange,
    benefit,
    risk,
    test,
    status: 'proposed',
  };
}

function buildSuggestions({ day, generatedAt, collection, inventory, occurrenceSummary, missSampling }) {
  const suggestions = [];
  const first = collection.collected_at ?? generatedAt;
  const last = collection.collected_at ?? generatedAt;
  if (collection.history_completeness !== 'proven') suggestions.push(makeSuggestion({
    id: 'TV-QC-001',
    title: 'Prove Alerts Log retention, pagination, and restart coverage',
    evidenceRefs: [evidenceRef(day, 'alerts-log-export'), evidenceRef(day, 'collection-state')],
    firstSeen: first,
    lastSeen: last,
    recurrence: { runs_observed: 1, condition: 'repeats until retention/pagination/restart behavior is independently proven' },
    affectedAlerts: ['TradingView Alerts Log export'],
    proposedChange: 'Run a bounded evidence exercise over multiple exports and restarts, recording retention horizon, pagination behavior, and whether the CSV is complete.',
    benefit: 'Makes absence and trend findings interpretable instead of treating a partial log as full history.',
    risk: 'Requires review of additional local TradingView history and may still leave retention undocumented.',
    test: 'Repeat export after restart and compare raw rows by stable occurrence ID; document any unobservable boundary.',
  }));
  const sourceAffected = inventory.source_unverified.map(row => row.alert_id).filter(Boolean);
  if (sourceAffected.length || inventory.definition_unverified.length) suggestions.push(makeSuggestion({
    id: 'TV-QC-002',
    title: 'Add independently verifiable deployed-source identity',
    evidenceRefs: [evidenceRef(day, 'inventory-snapshot'), evidenceRef(day, 'source-identity')],
    firstSeen: first,
    lastSeen: last,
    recurrence: { runs_observed: 1, unverified_managed_alerts: sourceAffected.length },
    affectedAlerts: sourceAffected.length ? sourceAffected : inventory.definition_unverified.map(row => row.alert_id).filter(Boolean),
    proposedChange: 'Establish a read-only source proof that binds each managed alert to the exact deployed script revision/version and hash; keep missing proof explicitly unverified.',
    benefit: 'Separates “script identity visible” from “source text verified” and prevents false configuration acceptance.',
    risk: 'A source-proof mechanism may require a future TradingView UI/API capability and must not mutate alerts.',
    test: 'Compare proof output against the frozen source hashes and report missing evidence as a gap.',
  }));
  const unclear = occurrenceSummary.unknown_identity_count + occurrenceSummary.possible_truncation_count
    + occurrenceSummary.human_partial_count + occurrenceSummary.mixed_machine_count
    + occurrenceSummary.invalid_source_time_count;
  if (unclear > 0) {
    const affected = occurrenceSummary.unknown_identity_count > 0 ? ['unknown-or-unmanaged-log-rows'] : ['partial-or-truncated-human-alert-copy'];
    suggestions.push(makeSuggestion({
      id: 'TV-QC-003',
      title: 'Resolve unknown or incomplete Alerts Log row identity',
      evidenceRefs: [evidenceRef(day, 'alerts-log-rows'), evidenceRef(day, 'row-parser')],
      firstSeen: occurrenceSummary.first_source_fired_at ?? first,
      lastSeen: occurrenceSummary.last_source_fired_at ?? last,
      recurrence: { rows_observed: unclear, exact_duplicates_excluded: true },
      affectedAlerts: affected,
      proposedChange: 'Review legacy, mixed, or incomplete rows and define a stable mapping or explicit exclusion for each.',
      benefit: 'Prevents unrelated or truncated notifications from inflating managed signal counts.',
      risk: 'Manual review could reclassify historical rows without proving their original alert configuration.',
      test: 'Replay the raw CSV and require deterministic classification with raw text retained.',
    }));
  }
  if (missSampling.status === 'not_verified') suggestions.push(makeSuggestion({
    id: 'TV-QC-004',
    title: 'Provide an independent RSI reference for bounded miss sampling',
    evidenceRefs: [evidenceRef(day, 'rsi-miss-sampling'), evidenceRef(day, 'inventory-snapshot')],
    firstSeen: first,
    lastSeen: last,
    recurrence: { runs_observed: 1, status: 'not_verified' },
    affectedAlerts: ['RSI managed routes'],
    proposedChange: 'Supply a separately verified RSI reference sample with exact source identity, input identity, route, expected-event flag, and observed firing result.',
    benefit: 'Allows possible versus confirmed misses to be reported without rotating charts or inferring silence from missing log history.',
    risk: 'Reference collection can be labor-intensive and must remain independent of the QC result.',
    test: 'Reject samples with any source, input, route, or independence mismatch; classify only expected silence, possible, or confirmed.',
  }));
  const configIssueCount = inventory.missing.length + inventory.stopped.length + inventory.expired.length
    + inventory.config_drift.length + inventory.unexpected.length + inventory.duplicate_expected_keys.length;
  if (configIssueCount > 0) suggestions.push(makeSuggestion({
    id: 'TV-QC-005',
    title: 'Review observed managed-alert configuration findings',
    evidenceRefs: [evidenceRef(day, 'inventory-snapshot'), evidenceRef(day, 'configuration-diff')],
    firstSeen: first,
    lastSeen: last,
    recurrence: { runs_observed: 1, finding_count: configIssueCount },
    affectedAlerts: [
      ...inventory.missing.map(row => row.expected_alert_id),
      ...inventory.stopped.map(row => row.alert_id),
      ...inventory.expired.map(row => row.alert_id),
      ...inventory.config_drift.map(row => row.alert_id),
    ].filter(Boolean).map(String).slice(0, 50),
    proposedChange: 'Review the frozen expected configuration against the current read-only inventory and approve any intentional change before editing the separate expected file.',
    benefit: 'Keeps configuration drift visible without allowing the monitor to rewrite alerts or silently rebase expectations.',
    risk: 'A stale frozen baseline can produce findings until a human explicitly reviews it.',
    test: 'Re-run the inventory comparison after review and require the finding to disappear only for the approved reason.',
  }));
  return suggestions;
}

export function buildTradingViewAlertQcReport({
  expectedConfig,
  observedInventory,
  collection = {},
  occurrences = [],
  importResult = {},
  generatedAt = new Date().toISOString(),
  rsiReference = null,
  reportDay = generatedAt.slice(0, 10),
  expectedConfigPath = null,
} = {}) {
  if (expectedConfig?.schema_version && expectedConfig.schema_version !== TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION) throw new Error('unexpected frozen expected-config schema');
  const timestamp = asIso(generatedAt, 'generatedAt');
  const sourceTimeValues = sourceTimes(occurrences);
  const occurrenceSummary = summarizeAlertLogOccurrences(occurrences);
  const inventory = compareInventory(expectedConfig, observedInventory, collection.observed_at ?? timestamp);
  inventory.observed_rows = (observedInventory?.managed ?? []).map(reportableObservedInventoryRow);
  inventory.unmanaged_alert_ids = (observedInventory?.unmanaged ?? []).map(row => row.alert_id).filter(Boolean).map(String);
  const historyCompleteness = collection.history_completeness ?? 'unproven';
  const collectedAtMs = new Date(collection.collected_at ?? timestamp).valueOf();
  const generatedAtMs = new Date(timestamp).valueOf();
  const freshnessSeconds = Number.isFinite(collectedAtMs) ? Math.max(0, (generatedAtMs - collectedAtMs) / 1000) : null;
  const collectionReport = {
    success: collection.success !== false,
    source: 'TradingView Alerts Log CSV',
    collected_at: collection.collected_at ?? timestamp,
    observed_at: collection.observed_at ?? timestamp,
    freshness_seconds: freshnessSeconds,
    freshness_status: freshnessSeconds === null ? 'unknown' : freshnessSeconds <= 300 ? 'fresh' : 'stale',
    target_url: collection.target_url ?? null,
    csv_columns: collection.csv_columns ?? null,
    csv_record_count: collection.csv_record_count ?? null,
    raw_evidence_path: collection.raw_evidence_path ?? null,
    history_completeness: historyCompleteness,
    history_reason: collection.history_reason ?? 'Retention, pagination, and restart completeness are not yet proven.',
    retention_proven: collection.retention_proven === true,
    pagination_proven: collection.pagination_proven === true,
    restart_recovery_proven: collection.restart_recovery_proven === true,
    source_identity_proven: collection.source_identity_proven === true,
    ui_log_state: collection.ui_log_state ?? null,
    error: collection.error ?? null,
  };
  const missSampling = assessRsiMissSampling({
    reference: rsiReference,
    expectedConfig,
    observedInventory,
    occurrences,
    collection: collectionReport,
    generatedAt: timestamp,
  });
  const trends = {
    last_24h: occurrenceWindowSummary(occurrences, timestamp, 1),
    last_7d: occurrenceWindowSummary(occurrences, timestamp, 7),
    last_30d: occurrenceWindowSummary(occurrences, timestamp, 30),
  };
  const suggestions = buildSuggestions({
    day: reportDay,
    generatedAt: timestamp,
    collection: collectionReport,
    inventory,
    occurrenceSummary,
    missSampling,
  });
  return {
    schema_version: TRADINGVIEW_ALERT_QC_SCHEMA_VERSION,
    generated_at: timestamp,
    report_day: reportDay,
    run_status: collectionReport.success ? 'success' : 'collection_failed',
    authority: 'evidence_report_only; never an alert or chart mutation authority',
    expected_configuration: {
      schema_version: expectedConfig?.schema_version ?? null,
      alert_count: Array.isArray(expectedConfig?.alerts) ? expectedConfig.alerts.length : 0,
      path: expectedConfigPath,
      rebuilt_from_observation: false,
    },
    collection: collectionReport,
    inventory,
    occurrences: {
      ...occurrenceSummary,
      current_run_import: clone(importResult),
      source_time_count: sourceTimeValues.length,
      source_time_first: sourceTimeValues.length ? new Date(sourceTimeValues[0]).toISOString() : null,
      source_time_last: sourceTimeValues.length ? new Date(sourceTimeValues.at(-1)).toISOString() : null,
      importer_time_is_separate: true,
    },
    trends,
    rsi_miss_sampling: missSampling,
    findings: {
      actionable_count: inventory.missing.length + inventory.stopped.length + inventory.expired.length
        + inventory.config_drift.length + inventory.unexpected.length + inventory.duplicate_expected_keys.length,
      evidence_gap_count: inventory.evidence_gaps.length,
      data_quality_count: occurrenceSummary.unknown_identity_count + occurrenceSummary.possible_truncation_count
        + occurrenceSummary.human_partial_count + occurrenceSummary.mixed_machine_count
        + occurrenceSummary.invalid_source_time_count,
      noise_count: occurrenceSummary.by_family.unknown ?? 0,
      repetition_group_count: occurrenceSummary.repeated_firings.length,
      multi_signal_notification_count: occurrenceSummary.multi_signal_notification_count,
    },
    improvement_suggestions: suggestions,
    backlog: {
      status: 'pending_writer',
      item_ids: suggestions.map(item => item.id),
    },
  };
}

export function buildTradingViewAlertQcFailureReport({ error, generatedAt = new Date().toISOString(), reportDay = generatedAt.slice(0, 10), targetUrl = null } = {}) {
  const timestamp = asIso(generatedAt, 'generatedAt');
  return {
    schema_version: TRADINGVIEW_ALERT_QC_SCHEMA_VERSION,
    generated_at: timestamp,
    report_day: reportDay,
    run_status: 'collection_failed',
    authority: 'evidence_report_only; never an alert or chart mutation authority',
    collection: {
      success: false,
      source: 'TradingView Alerts Log CSV',
      collected_at: timestamp,
      observed_at: timestamp,
      target_url: targetUrl,
      history_completeness: 'unproven',
      history_reason: 'Collection failed before a complete CSV evidence record was captured.',
      retention_proven: false,
      pagination_proven: false,
      restart_recovery_proven: false,
      source_identity_proven: false,
      error: String(error?.message ?? error ?? 'unknown collection error'),
    },
    inventory: null,
    occurrences: null,
    trends: null,
    rsi_miss_sampling: { status: 'not_verified', reason: 'Collection failed.' },
    findings: { actionable_count: 0, evidence_gap_count: 0, data_quality_count: 0, noise_count: 0, repetition_group_count: 0, multi_signal_notification_count: 0 },
    improvement_suggestions: [],
    backlog: { status: 'not_updated_due_to_collection_failure', item_ids: [] },
  };
}

export function writeTradingViewAlertQcReport(report, {
  paths,
  generatedAt = report?.generated_at ?? new Date().toISOString(),
} = {}) {
  if (!report || typeof report !== 'object') throw new TypeError('report must be an object');
  const resolved = paths ?? prepareTradingViewAlertQcHome();
  const day = String(report.report_day ?? asIso(generatedAt).slice(0, 10));
  const jsonPath = join(resolved.reports_dir, `${day}.json`);
  const markdownPath = join(resolved.reports_dir, `${day}.md`);
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { label: 'alert QC JSON report' });
  atomicWrite(markdownPath, renderTradingViewAlertQcMarkdown(report), { label: 'alert QC Markdown report' });
  return { json_path: jsonPath, markdown_path: markdownPath };
}

function markdownValue(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function listMarkdown(values, limit = 20) {
  const rows = (values ?? []).slice(0, limit).map(value => markdownValue(value));
  return rows.length ? rows.join(', ') : 'none';
}

export function renderTradingViewAlertQcMarkdown(report) {
  const collection = report.collection ?? {};
  const inventory = report.inventory ?? {};
  const occurrences = report.occurrences ?? {};
  const findings = report.findings ?? {};
  const suggestions = report.improvement_suggestions ?? [];
  const lines = [
    `# TradingView Alert QC — ${report.report_day ?? 'unknown day'}`,
    '',
    `Run status: **${report.run_status ?? 'unknown'}**`,
    `Generated: ${report.generated_at ?? 'unknown'}`,
    '',
    '## Collection',
    '',
    `- Source: ${collection.source ?? 'unknown'}`,
    `- Export records: ${collection.csv_record_count ?? 'unknown'}`,
    `- Successful collection: ${collection.success === true ? 'yes' : 'no'}`,
    `- Raw evidence: ${collection.raw_evidence_path ?? 'not captured'}`,
    `- History completeness: **${collection.history_completeness ?? 'unproven'}** — ${collection.history_reason ?? 'not proven'}`,
    `- Retention / pagination / restart proof: ${collection.retention_proven === true ? 'yes' : 'no'} / ${collection.pagination_proven === true ? 'yes' : 'no'} / ${collection.restart_recovery_proven === true ? 'yes' : 'no'}`,
    collection.error ? `- Error: ${markdownValue(collection.error)}` : '',
    '',
    '## Frozen configuration versus live inventory',
    '',
    `- Expected managed alerts: ${inventory.expected_count ?? 'unknown'}`,
    `- Observed managed alerts: ${inventory.observed_managed_count ?? 'unknown'} (${inventory.observed_active_managed_count ?? 'unknown'} active)`,
    `- Missing / stopped / expired: ${inventory.missing?.length ?? 0} / ${inventory.stopped?.length ?? 0} / ${inventory.expired?.length ?? 0}`,
    `- Config drift / unexpected / duplicate keys: ${inventory.config_drift?.length ?? 0} / ${inventory.unexpected?.length ?? 0} / ${inventory.duplicate_expected_keys?.length ?? 0}`,
    `- Source proof gaps / input proof gaps / notification proof gaps: ${inventory.source_unverified?.length ?? 0} / ${(inventory.input_unverified?.length ?? 0) + (inventory.definition_unverified?.length ?? 0)} / ${inventory.notification_unverified?.length ?? 0}`,
    '',
    '## Firing occurrences',
    '',
    `- Unique occurrence rows retained: ${occurrences.unique_occurrence_count ?? 0}`,
    `- Source firing window: ${occurrences.source_time_first ?? 'none'} → ${occurrences.source_time_last ?? 'none'}`,
    `- Human-only / partial-or-mixed / unknown identity / possible truncation / invalid source time: ${occurrences.human_only_count ?? 0} / ${(occurrences.human_partial_count ?? 0) + (occurrences.mixed_machine_count ?? 0)} / ${occurrences.unknown_identity_count ?? 0} / ${occurrences.possible_truncation_count ?? 0} / ${occurrences.invalid_source_time_count ?? 0}`,
    `- Notifications with multiple signal blocks: ${occurrences.multi_signal_notification_count ?? 0}; parsed signal blocks: ${occurrences.signal_count ?? 0}`,
    `- Genuine repeated-firing groups: ${occurrences.repeated_firings?.length ?? 0}; exact re-import duplicates this run: ${occurrences.current_run_import?.exact_duplicates ?? 0}`,
    `- By family: ${markdownValue(JSON.stringify(occurrences.by_family ?? {}))}`,
    `- By status: ${markdownValue(JSON.stringify(occurrences.by_status ?? {}))}`,
    '',
    '## Bounded RSI miss sampling',
    '',
    `- Status: **${report.rsi_miss_sampling?.status ?? 'not_verified'}**`,
    `- Reason: ${report.rsi_miss_sampling?.reason ?? 'not verified'}`,
    '',
    '## Findings',
    '',
    `- Actionable inventory findings: ${findings.actionable_count ?? 0}`,
    `- Evidence gaps: ${findings.evidence_gap_count ?? 0}`,
    `- Data-quality rows: ${findings.data_quality_count ?? 0}; unknown/noise rows: ${findings.noise_count ?? 0}`,
    `- Repetition groups: ${findings.repetition_group_count ?? 0}`,
    '',
    '## Reviewer-only improvement proposals',
    '',
  ];
  if (!suggestions.length) lines.push('- None.');
  for (const item of suggestions) {
    lines.push(`- ${item.id}: ${markdownValue(item.title)} — status ${markdownValue(item.status)}`);
  }
  lines.push('', 'Reports are evidence, not authority. This run does not create, delete, edit, rotate, or reconfigure TradingView alerts or charts.', '');
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

function backlogGeneratedBody(content) {
  const start = content.indexOf(GENERATED_START);
  const end = content.indexOf(GENERATED_END);
  if (start < 0 || end < start) return content;
  return content.slice(start + GENERATED_START.length, end);
}

function backlogField(raw, field) {
  const match = raw.match(new RegExp(`^-\\s*${field}:\\s*(.*)$`, 'imu'));
  return match ? match[1].trim() : null;
}

function parseBacklogItems(content) {
  const body = backlogGeneratedBody(content);
  const headings = [];
  const headingPattern = /^###\s+(TV-QC-\d+)\s+—\s+(.+)$/gim;
  let heading;
  while ((heading = headingPattern.exec(body)) !== null) headings.push({ ...heading, index: heading.index });
  const items = new Map();
  for (const [index, current] of headings.entries()) {
    const end = headings[index + 1]?.index ?? body.length;
    const raw = body.slice(current.index, end).trim();
    const recurrenceText = backlogField(raw, 'Recurrence');
    let recurrence = {};
    if (recurrenceText) {
      try { recurrence = JSON.parse(recurrenceText); } catch { recurrence = { unparsed: recurrenceText }; }
    }
    const known = /^(?:###\s+TV-QC-\d+\s+—|Generated:|-\s*(?:Evidence refs|First seen|Last seen|Recurrence|Affected alerts|Proposed change|Benefit|Risk|Test|Status):|####\s+Reviewer notes)/iu;
    const notes = raw.split(/\r?\n/u)
      .map(line => line.trimEnd())
      .filter(line => line.trim() && !known.test(line));
    const status = backlogField(raw, 'Status');
    items.set(current[1], {
      id: current[1],
      title: current[2].trim(),
      raw,
      first_seen_at: backlogField(raw, 'First seen'),
      last_seen_at: backlogField(raw, 'Last seen'),
      recurrence,
      status: status && REVIEW_STATUSES.has(status.toLowerCase()) ? status.toLowerCase() : 'proposed',
      notes,
    });
  }
  return items;
}

function earlierTimestamp(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  const leftMs = new Date(left).valueOf();
  const rightMs = new Date(right).valueOf();
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return leftMs <= rightMs ? left : right;
}

function mergeBacklogItem(item, previous) {
  if (!previous) return { ...item, notes: [] };
  const previousRuns = Number(previous.recurrence?.runs_observed ?? 0);
  const currentRuns = Number(item.recurrence?.runs_observed ?? 1);
  return {
    ...item,
    status: previous.status ?? item.status ?? 'proposed',
    first_seen_at: earlierTimestamp(previous.first_seen_at, item.first_seen_at),
    last_seen_at: item.last_seen_at ?? previous.last_seen_at,
    recurrence: {
      ...stableObject(previous.recurrence),
      ...stableObject(item.recurrence),
      runs_observed: (Number.isFinite(previousRuns) ? previousRuns : 0) + (Number.isFinite(currentRuns) ? currentRuns : 1),
    },
    notes: previous.notes ?? [],
  };
}

function renderBacklogItem(item, status, notes = []) {
  const lines = [
    `### ${item.id} — ${item.title}`,
    '',
    `- Evidence refs: ${listMarkdown(item.evidence_refs)}`,
    `- First seen: ${markdownValue(item.first_seen_at)}`,
    `- Last seen: ${markdownValue(item.last_seen_at)}`,
    `- Recurrence: ${markdownValue(JSON.stringify(item.recurrence ?? {}))}`,
    `- Affected alerts: ${listMarkdown(item.affected_alerts)}`,
    `- Proposed change: ${markdownValue(item.proposed_change)}`,
    `- Benefit: ${markdownValue(item.benefit)}`,
    `- Risk: ${markdownValue(item.risk)}`,
    `- Test: ${markdownValue(item.test)}`,
    `- Status: ${status}`,
    '',
  ];
  if (notes.length) lines.push('#### Reviewer notes', '', ...notes, '');
  return lines.join('\n');
}

export function writeTradingViewAlertQcBacklog(suggestions, {
  backlogPath = DEFAULT_TRADINGVIEW_ALERT_QC_BACKLOG,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(suggestions)) throw new TypeError('suggestions must be an array');
  const target = safePath(backlogPath, 'TradingView alert QC backlog');
  const existing = existsSync(target) ? readRegularText(target, 'TradingView alert QC backlog') : '';
  const previousItems = parseBacklogItems(existing);
  const currentItems = new Map(suggestions.map(item => [item.id, mergeBacklogItem(item, previousItems.get(item.id))]));
  const allItems = new Map(previousItems);
  for (const [id, item] of currentItems.entries()) allItems.set(id, item);
  const header = existing && !existing.includes(GENERATED_START)
    ? existing.trimEnd() + '\n\n'
    : existing.includes(GENERATED_START)
      ? existing.slice(0, existing.indexOf(GENERATED_START)).trimEnd() + '\n\n'
      : '# TradingView Alert QC improvement list\n\nThis is a reviewer-only proposal list generated from read-only evidence. It never authorizes alert or chart changes.\n\n';
  const suffix = existing.includes(GENERATED_END)
    ? existing.slice(existing.indexOf(GENERATED_END) + GENERATED_END.length).trimStart()
    : '';
  const body = [...allItems.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(item => currentItems.has(item.id)
      ? renderBacklogItem(item, item.status ?? 'proposed', item.notes ?? [])
      : `${item.raw}\n`)
    .join('\n');
  const generated = [
    GENERATED_START,
    `Generated: ${asIso(generatedAt)}`,
    '',
    body || 'No current proposals.\n',
    GENERATED_END,
    suffix,
  ].join('\n');
  atomicWrite(target, `${header}${generated}`.replace(/\n{3,}/gu, '\n\n'), { mode: 0o644, label: 'TradingView alert QC backlog', parentMode: 0o755 });
  return {
    path: target,
    item_ids: [...allItems.keys()].sort(),
    active_item_ids: suggestions.map(item => item.id).sort(),
    retained_historical_item_ids: [...allItems.keys()].filter(id => !currentItems.has(id)).sort(),
    preserved_statuses: Object.fromEntries([...previousItems.entries()].map(([id, item]) => [id, item.status])),
    preserved_history_count: [...allItems.keys()].filter(id => !currentItems.has(id)).length,
    generated_at: asIso(generatedAt),
  };
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

const ENSURE_LOG_EXPRESSION = `(function() {
  function visible(el) { return !!el && (el.offsetParent !== null || el.getClientRects().length > 0); }
  function firstVisible(selector) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) if (visible(nodes[i])) return nodes[i];
    return null;
  }
  var actions = firstVisible('[data-name="alerts-log-actions-button"]');
  if (actions) return { ready: true, action: 'log_actions_ready' };
  var candidates = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
  for (var j = 0; j < candidates.length; j++) {
    if (!visible(candidates[j])) continue;
    var text = (candidates[j].textContent || '').replace(/\\d+/g, '').replace(/\\s+/g, '').toLowerCase();
    if (text === 'log' || text.endsWith('log')) {
      candidates[j].click();
      return { ready: false, action: 'log_tab_requested', log_tab_text: candidates[j].textContent || '' };
    }
  }
  var alertButton = firstVisible('[data-name="alerts-button"]') || firstVisible('[data-name="alerts"]') || firstVisible('[aria-label="Alerts"]');
  if (alertButton) {
    alertButton.click();
    return { ready: false, action: 'alerts_panel_requested' };
  }
  return { ready: false, action: 'alerts_log_controls_not_found' };
})()`;

const EXPORT_MENU_EXPRESSION = `(function() {
  function visible(el) { return !!el && (el.offsetParent !== null || el.getClientRects().length > 0); }
  var items = document.querySelectorAll('[role="menuitem"], button, a');
  for (var i = 0; i < items.length; i++) {
    if (visible(items[i]) && (items[i].textContent || '').trim() === 'Download log as CSV') {
      items[i].click();
      return { action: 'export_clicked' };
    }
  }
  var options = document.querySelector('[data-name="alerts-log-actions-button"]');
  if (options && visible(options)) {
    options.click();
    return { action: 'options_requested' };
  }
  return { action: 'export_controls_not_found' };
})()`;

export function tradingViewAlertQcUiExpressions() {
  return { ensure_log: ENSURE_LOG_EXPRESSION, export_menu: EXPORT_MENU_EXPRESSION };
}

export async function withTradingViewAlertQcDownloadBehavior(client, downloadPath, operation) {
  if (!client?.Page || typeof client.Page.setDownloadBehavior !== 'function') throw new Error('CDP Page.setDownloadBehavior is unavailable; CSV capture cannot be proven');
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  let operationError = null;
  let configured = false;
  try {
    await client.Page.setDownloadBehavior({ behavior: 'allow', downloadPath });
    configured = true;
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (configured) {
      try {
        await client.Page.setDownloadBehavior({ behavior: 'default' });
      } catch (restoreError) {
        if (!operationError) throw new Error(`could not restore CDP download behavior: ${restoreError.message}`);
      }
    }
  }
}

function downloadedCsv(downloadDir, beforeNames) {
  return readdirSync(downloadDir)
    .filter(name => extname(name).toLowerCase() === '.csv' && !name.endsWith('.crdownload'))
    .filter(name => !beforeNames.has(name))
    .map(name => ({ name, path: join(downloadDir, name), stat: statSync(join(downloadDir, name)) }))
    .filter(row => row.stat.isFile() && row.stat.size > 0)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0] ?? null;
}

/**
 * Export the visible TradingView Alerts Log through the authenticated desktop
 * UI. It intentionally uses no webhook, alert mutation, chart rotation, or
 * cookie/token access.
 */
export async function exportTradingViewAlertsLogCsv({ downloadDir = null, timeoutMs = 15000 } = {}) {
  const target = await getTargetInfo();
  if (!target?.url || !/tradingview\.com\//iu.test(target.url)) throw new Error('connected CDP target is not a TradingView page');
  const destination = downloadDir
    ? ensurePrivateDirectory(downloadDir)
    : mkdtempSync(join(tmpdir(), 'tradingview-alert-qc-'));
  chmodSync(destination, 0o700);
  const beforeNames = new Set(readdirSync(destination));
  const client = await getClient();
  return withTradingViewAlertQcDownloadBehavior(client, destination, async () => {
    let uiState = null;
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      uiState = await evaluate(ENSURE_LOG_EXPRESSION);
      if (uiState?.ready) break;
      await sleep(250);
    }
    if (!uiState?.ready) throw new Error(`TradingView Alerts Log controls were not found: ${JSON.stringify(uiState)}`);
    let menuState = null;
    while (Date.now() < deadline) {
      menuState = await evaluate(EXPORT_MENU_EXPRESSION);
      if (menuState?.action === 'export_clicked') break;
      if (menuState?.action === 'export_controls_not_found') throw new Error('TradingView Alerts Log export controls were not found');
      await sleep(250);
    }
    if (menuState?.action !== 'export_clicked') throw new Error('TradingView Alerts Log CSV export timed out');
    let downloaded = null;
    let previousSize = -1;
    let stableReads = 0;
    while (Date.now() < deadline) {
      downloaded = downloadedCsv(destination, beforeNames);
      if (downloaded && downloaded.stat.size === previousSize) stableReads += 1;
      else stableReads = 0;
      previousSize = downloaded?.stat.size ?? -1;
      if (downloaded && stableReads >= 1) break;
      await sleep(250);
    }
    if (!downloaded) throw new Error('TradingView Alerts Log CSV did not download before timeout');
    return {
      success: true,
      source: 'TradingView Alerts Log CSV',
      csv_path: downloaded.path,
      csv_size: downloaded.stat.size,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      target_url: target.url,
      ui_log_state: uiState,
      download_dir: destination,
    };
  });
}

function appendOccurrenceRows(path, rows) {
  if (!rows.length) return;
  if (!existsSync(path)) writeFileSync(path, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  ensurePrivateFile(path, 'alert occurrence ledger');
  chmodSync(path, 0o600);
  appendFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { encoding: 'utf8' });
}

function readOccurrenceRows(path) {
  if (!existsSync(path)) return [];
  const text = readRegularText(path, 'alert occurrence ledger');
  if (!text.trim()) return [];
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid alert occurrence ledger line ${index + 1}: ${error.message}`);
    }
  });
}

/** Import one raw CSV while deduplicating exact occurrences and preserving firing time. */
export function importTradingViewAlertsLogCsv({
  csvPath,
  paths,
  importedAt = new Date().toISOString(),
  observedInventory = { managed: [], unmanaged: [] },
  expectedConfig = { alerts: [] },
} = {}) {
  const resolvedPaths = paths ?? prepareTradingViewAlertQcHome();
  const sourcePath = ensurePrivateFile(csvPath, 'TradingView Alerts Log CSV');
  const csvText = readFileSync(sourcePath, 'utf8');
  const parsed = parseTradingViewAlertsLogCsv(csvText);
  const maps = alertMaps(expectedConfig);
  const observedById = new Map((observedInventory.managed ?? []).map(row => [String(row.alert_id), row]));
  const normalized = normalizeTradingViewAlertLogRows(parsed, {
    importedAt: asIso(importedAt, 'importedAt'),
    observedAlertsById: observedById,
    expectedAlertsById: maps.by_id,
    expectedAlertsByKey: maps.by_key,
  });
  const rawHash = sha256(csvText);
  const rawName = `${asIso(importedAt, 'importedAt').slice(0, 10)}-${rawHash.slice(0, 16)}.csv`;
  const rawEvidencePath = join(resolvedPaths.raw_dir, rawName);
  if (existsSync(rawEvidencePath)) {
    ensurePrivateFile(rawEvidencePath, 'raw alert log evidence');
  } else {
    assertNotSymlink(sourcePath, 'source CSV');
    copyFileSync(sourcePath, rawEvidencePath);
    chmodSync(rawEvidencePath, 0o600);
  }
  const existing = readOccurrenceRows(resolvedPaths.occurrences_path);
  const existingIds = new Set(existing.map(row => row.occurrence_id));
  const seenIds = new Set(existingIds);
  const newRows = normalized.filter(row => {
    if (seenIds.has(row.occurrence_id)) return false;
    seenIds.add(row.occurrence_id);
    return true;
  });
  appendOccurrenceRows(resolvedPaths.occurrences_path, newRows);
  const allRows = existing.concat(newRows);
  const sourceValues = allRows.map(row => row.source_fired_at_ms).filter(Number.isSafeInteger).sort((left, right) => left - right);
  const previousState = readJsonIfPresent(resolvedPaths.collection_state_path, 'alert QC collection state') ?? {};
  const state = {
    schema_version: 'tradingview-alert-qc-collection-state/v1',
    first_successful_collection_at: previousState.first_successful_collection_at ?? asIso(importedAt, 'importedAt'),
    last_successful_collection_at: asIso(importedAt, 'importedAt'),
    successful_collection_count: Number(previousState.successful_collection_count ?? 0) + 1,
    last_source_fired_at: sourceValues.length ? new Date(sourceValues.at(-1)).toISOString() : null,
    first_source_fired_at: sourceValues.length ? new Date(sourceValues[0]).toISOString() : null,
    last_raw_evidence_path: rawEvidencePath,
    last_csv_sha256: rawHash,
    last_csv_record_count: parsed.record_count,
    last_csv_columns: parsed.columns,
    history_completeness: 'unproven',
    history_reason: 'TradingView exposes exported rows, but retention, pagination, and restart completeness have not been independently proven.',
    importer_time_is_separate_from_source_time: true,
  };
  atomicWrite(resolvedPaths.collection_state_path, `${JSON.stringify(state, null, 2)}\n`, { label: 'alert QC collection state' });
  return {
    schema_version: 'tradingview-alert-qc-import/v1',
    csv_sha256: rawHash,
    csv_columns: parsed.columns,
    csv_record_count: parsed.record_count,
    raw_evidence_path: rawEvidencePath,
    normalized_rows: normalized,
    appended_count: newRows.length,
    exact_duplicates: normalized.length - newRows.length,
    total_unique_occurrences: allRows.length,
    first_source_fired_at: sourceValues.length ? new Date(sourceValues[0]).toISOString() : null,
    last_source_fired_at: sourceValues.length ? new Date(sourceValues.at(-1)).toISOString() : null,
    collected_at: asIso(importedAt, 'importedAt'),
  };
}

export function loadTradingViewAlertQcOccurrences(paths) {
  return readOccurrenceRows(paths?.occurrences_path ?? tradingViewAlertQcPaths().occurrences_path);
}

export function loadFrozenTradingViewAlertQcExpected(path) {
  const config = readJson(path, 'frozen TradingView alert QC expected configuration');
  if (config.schema_version !== TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION) throw new Error(`expected ${TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION}`);
  if (!Array.isArray(config.alerts) || !config.alerts.length) throw new Error('frozen expected configuration must contain alerts');
  const keys = new Set();
  for (const row of config.alerts) {
    if (!row.expected_key || keys.has(row.expected_key)) throw new Error(`frozen expected configuration has duplicate/empty expected_key: ${row.expected_key}`);
    keys.add(row.expected_key);
  }
  return config;
}

export async function collectTradingViewAlertQcInventory() {
  const result = await listTradingViewAlerts();
  if (!result?.success || result.error) throw new Error(result?.error ?? 'TradingView alert inventory collection failed');
  const inventory = normalizeTradingViewAlertInventory(result.alerts ?? []);
  return {
    ...result,
    inventory,
    observed_at: new Date().toISOString(),
  };
}

export { listTradingViewAlerts };
