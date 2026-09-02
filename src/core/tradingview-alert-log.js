import { canonicalJson, sha256 } from './investment-attention-ledger.js';

export const TRADINGVIEW_ALERT_LOG_SCHEMA_VERSION = 'tradingview-alert-log/v1';

const REQUIRED_COLUMNS = ['Alert ID', 'Ticker', 'Name', 'Description', 'Time', 'Webhook status'];
const HUMAN_LABELS = ['ACTUAL ALERT', 'TIMEFRAME', 'FIRED', 'MEANING', 'STATUS', 'ACTION'];
const MACHINE_MARKERS = ['SHARD=', 'MASK=', 'KEY=', 'STAGE_TIME=', '--- DATA ---'];
const TIMEFRAME_MAP = new Map([
  ['D', 'D'], ['1D', 'D'], ['DAY', 'D'], ['DAILY', 'D'],
  ['W', 'W'], ['1W', 'W'], ['WEEK', 'W'], ['WEEKLY', 'W'],
  ['4H', '4H'], ['240', '4H'], ['240M', '4H'],
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/u, '').trim();
}

function normalizeTimeframe(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  return TIMEFRAME_MAP.get(raw) ?? (raw || null);
}

function parseTime(value) {
  const raw = nonempty(value);
  if (!raw) return { raw: null, iso: null, ms: null, valid: false };
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return { raw, iso: null, ms: null, valid: false };
  return { raw, iso: date.toISOString(), ms: date.valueOf(), valid: true };
}

function fieldValue(row, name) {
  if (row && Object.hasOwn(row, name)) return row[name];
  const fallback = Object.entries(row ?? {}).find(([key]) => normalizedHeader(key).toLowerCase() === name.toLowerCase());
  return fallback ? fallback[1] : null;
}

function isBlankRecord(values) {
  return values.length === 0 || values.every(value => String(value ?? '').trim() === '');
}

/**
 * Parse RFC-4180-style CSV, including quoted fields containing commas, quotes,
 * and physical newlines. The raw record is retained so future fields can be
 * audited without reconstructing a row from normalized values.
 */
export function parseCsvRecords(csvText) {
  if (typeof csvText !== 'string') throw new TypeError('csvText must be a string');
  const rows = [];
  let values = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let recordStart = 0;
  let index = 0;

  const pushField = () => {
    values.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRecord = end => {
    pushField();
    if (!isBlankRecord(values)) rows.push({ values, raw_record: csvText.slice(recordStart, end) });
    values = [];
  };

  while (index < csvText.length) {
    const char = csvText[index];
    if (quoted) {
      if (char === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && !fieldStarted && field.length === 0) {
      quoted = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      const end = index;
      if (char === '\r' && csvText[index + 1] === '\n') index += 2;
      else index += 1;
      pushRecord(end);
      recordStart = index;
      continue;
    }
    field += char;
    fieldStarted = true;
    index += 1;
  }

  if (quoted) throw new Error('CSV ended inside a quoted field');
  if (field.length > 0 || fieldStarted || values.length > 0) pushRecord(csvText.length);
  if (!rows.length) throw new Error('CSV contains no records');
  return rows;
}

export function parseTradingViewAlertsLogCsv(csvText) {
  const records = parseCsvRecords(csvText);
  const columns = records.shift().values.map(normalizedHeader);
  const missing = REQUIRED_COLUMNS.filter(column => !columns.includes(column));
  if (missing.length) throw new Error(`TradingView Alerts Log CSV is missing columns: ${missing.join(', ')}`);
  const rows = records.map(record => {
    const fields = {};
    columns.forEach((column, index) => {
      fields[column] = record.values[index] ?? '';
    });
    return { fields, raw_record: record.raw_record };
  });
  return {
    schema_version: TRADINGVIEW_ALERT_LOG_SCHEMA_VERSION,
    columns,
    rows,
    record_count: rows.length,
  };
}

function parseTicker(value) {
  const raw = nonempty(value) ?? '';
  const separator = raw.lastIndexOf(',');
  if (separator < 0) return { raw, symbol: raw || null, timeframe: null, timeframe_raw: null };
  const symbol = raw.slice(0, separator).trim();
  const timeframeRaw = raw.slice(separator + 1).trim();
  return {
    raw,
    symbol: symbol || null,
    timeframe: normalizeTimeframe(timeframeRaw),
    timeframe_raw: timeframeRaw || null,
  };
}

function labelFields(description) {
  const result = {};
  const lines = String(description ?? '').split(/\r?\n/u);
  for (const label of HUMAN_LABELS) {
    const prefix = new RegExp(`^${label}:\\s*(.*)$`, 'iu');
    const line = lines.find(candidate => prefix.test(candidate));
    if (line !== undefined) result[label.toLowerCase().replace(/\s+/gu, '_')] = line.replace(prefix, '$1').trim();
    else result[label.toLowerCase().replace(/\s+/gu, '_')] = null;
  }
  return result;
}

function signalType(text) {
  const value = String(text ?? '').toUpperCase();
  if (/FIBONACCI|FIB\b/u.test(value)) return 'fib_signal';
  if (/\bSMA\b|MOVING AVERAGE/u.test(value)) return 'sma_signal';
  if (/\bRSI\b|DIVERGENCE/u.test(value)) return 'rsi_signal';
  if (/CUP|HANDLE/u.test(value)) return 'cup_and_handle_signal';
  return 'unclassified_signal';
}

function signalBlocks(fired) {
  if (!fired) return [];
  return fired.split(/\s*;\s*/u).map(text => text.trim()).filter(Boolean).map((text, index) => ({
    index,
    text,
    event_type: signalType(text),
  }));
}

function occurrenceIdentity({ alertId, sourceFiredAt, hostTicker, name, description, webhookStatus }) {
  return {
    alert_id: alertId,
    source_fired_at: sourceFiredAt,
    host_ticker: hostTicker,
    name,
    description_sha256: sha256(description ?? ''),
    webhook_status: webhookStatus,
  };
}

function alertIdentity({ alertId, observedAlert, expectedById, expectedByKey }) {
  const observed = observedAlert ?? null;
  const expectedByAlertId = alertId ? expectedById.get(alertId) ?? null : null;
  const expected = expectedByAlertId ?? (observed?.expected_key ? expectedByKey.get(observed.expected_key) : null);
  if (!observed && !expected) {
    return {
      managed: false,
      status: 'unknown',
      expected_key: null,
      family: null,
      observed_alert_id: null,
      expected_alert_id: null,
      script_id: null,
      script_version: null,
      source_sha256: null,
      definition_version: null,
      source_verification: 'not_verified',
    };
  }
  const observedSourceHash = observed?.source_sha256 ?? null;
  const expectedSource = expected?.source_identity ?? {};
  const scriptId = observed?.script_id ?? expectedSource.script_id ?? null;
  const scriptVersion = observed?.script_version ?? expectedSource.script_version ?? null;
  const sourceVerification = observed
    ? (observedSourceHash ? 'verified_from_alert_inventory' : 'script_identity_only')
    : 'historical_expected_identity_only';
  return {
    managed: true,
    status: observed ? 'observed_managed' : 'expected_id_not_currently_observed',
    expected_key: observed?.expected_key ?? expected?.expected_key ?? null,
    family: observed?.family ?? expected?.family ?? null,
    observed_alert_id: observed?.alert_id ?? null,
    expected_alert_id: expected?.alert_id ?? null,
    script_id: scriptId,
    script_version: scriptVersion,
    source_sha256: observedSourceHash,
    definition_version: observed?.definition_version ?? null,
    expected_source_sha256: expectedSource.source_sha256 ?? null,
    expected_definition_version: expectedSource.definition_version ?? null,
    source_verification: sourceVerification,
  };
}

/**
 * Normalize one exported row. Source firing time comes only from the CSV Time
 * field; imported_at is deliberately supplied separately by the collector.
 */
export function normalizeTradingViewAlertLogRow(row, {
  importedAt = new Date().toISOString(),
  observedAlertsById = new Map(),
  expectedAlertsById = new Map(),
  expectedAlertsByKey = new Map(),
} = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('alert log row must be an object');
  const alertIdRaw = nonempty(fieldValue(row.fields ?? row, 'Alert ID'));
  const alertId = alertIdRaw || null;
  const ticker = parseTicker(fieldValue(row.fields ?? row, 'Ticker'));
  const name = nonempty(fieldValue(row.fields ?? row, 'Name'));
  const description = String(fieldValue(row.fields ?? row, 'Description') ?? '');
  const time = parseTime(fieldValue(row.fields ?? row, 'Time'));
  const importedTime = parseTime(importedAt);
  if (!importedTime.valid) throw new TypeError('importedAt must be an ISO timestamp');
  const webhookStatus = nonempty(fieldValue(row.fields ?? row, 'Webhook status'));
  const labels = labelFields(description);
  const machineMarkers = MACHINE_MARKERS.filter(marker => description.includes(marker));
  const presentHumanLabels = HUMAN_LABELS.filter(label => labels[label.toLowerCase().replace(/\s+/gu, '_')] !== null);
  const humanComplete = presentHumanLabels.length === HUMAN_LABELS.length;
  const descriptionKind = machineMarkers.length > 0
    ? (presentHumanLabels.length ? 'mixed_machine_and_human' : 'machine_or_unknown')
    : humanComplete
      ? 'human_only'
      : presentHumanLabels.length
        ? 'human_partial'
        : 'legacy_or_unknown';
  const possibleTruncation = description.endsWith('…')
    || description.endsWith('...')
    || (presentHumanLabels.length >= 2 && !presentHumanLabels.includes('ACTION'));
  const identity = alertIdentity({
    alertId,
    observedAlert: observedAlertsById.get(alertId),
    expectedById: expectedAlertsById,
    expectedByKey: expectedAlertsByKey,
  });
  const identityForHash = occurrenceIdentity({
    alertId,
    sourceFiredAt: time.iso,
    hostTicker: ticker.raw,
    name,
    description,
    webhookStatus,
  });
  return {
    schema_version: TRADINGVIEW_ALERT_LOG_SCHEMA_VERSION,
    occurrence_id: `tvqc1_${sha256(canonicalJson(identityForHash))}`,
    alert_id: alertId,
    host_ticker_raw: ticker.raw,
    host_symbol: ticker.symbol,
    host_timeframe_raw: ticker.timeframe_raw,
    host_timeframe: ticker.timeframe,
    name,
    description,
    description_sha256: sha256(description),
    description_kind: descriptionKind,
    human_labels_present: presentHumanLabels,
    machine_markers: machineMarkers,
    possible_truncation: possibleTruncation,
    actual_alert_raw: labels.actual_alert,
    actual_symbol: nonempty(labels.actual_alert)?.split(/\s+/u)[0] ?? null,
    declared_timeframe_raw: labels.timeframe,
    declared_timeframe: normalizeTimeframe(labels.timeframe),
    fired_summary: labels.fired,
    signal_blocks: signalBlocks(labels.fired),
    meaning: labels.meaning,
    status: labels.status,
    action: labels.action,
    webhook_status: webhookStatus,
    raw_fields: clone(row.fields ?? row),
    source_fired_at: time.iso,
    source_fired_at_raw: time.raw,
    source_fired_at_ms: time.ms,
    source_time_valid: time.valid,
    imported_at: importedTime.iso,
    identity,
    raw_csv_record: row.raw_record ?? null,
  };
}

export function normalizeTradingViewAlertLogRows(parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.rows)) throw new TypeError('parsed alert log must contain rows');
  return parsed.rows.map(row => normalizeTradingViewAlertLogRow(row, options));
}

export function summarizeAlertLogOccurrences(occurrences) {
  if (!Array.isArray(occurrences)) throw new TypeError('occurrences must be an array');
  const byFamily = {};
  const byActualSymbol = {};
  const bySignal = {};
  const byStatus = {};
  const byDescriptionKind = {};
  const byDay = {};
  const alertTimes = new Map();
  let humanOnly = 0;
  let unknown = 0;
  let possibleTruncation = 0;
  let invalidSourceTime = 0;
  let multiSignalNotifications = 0;
  let signalCount = 0;
  for (const occurrence of occurrences) {
    const family = occurrence.identity?.family ?? 'unknown';
    const actualSymbol = occurrence.actual_symbol ?? 'unknown';
    byFamily[family] = (byFamily[family] ?? 0) + 1;
    byActualSymbol[actualSymbol] = (byActualSymbol[actualSymbol] ?? 0) + 1;
    const status = nonempty(occurrence.status)?.toLowerCase() ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const descriptionKind = occurrence.description_kind ?? 'unknown';
    byDescriptionKind[descriptionKind] = (byDescriptionKind[descriptionKind] ?? 0) + 1;
    if (occurrence.description_kind === 'human_only') humanOnly += 1;
    if (occurrence.identity?.status === 'unknown') unknown += 1;
    if (occurrence.possible_truncation) possibleTruncation += 1;
    if (occurrence.source_time_valid !== true) invalidSourceTime += 1;
    if ((occurrence.signal_blocks?.length ?? 0) > 1) multiSignalNotifications += 1;
    for (const signal of occurrence.signal_blocks ?? []) {
      signalCount += 1;
      bySignal[signal.event_type] = (bySignal[signal.event_type] ?? 0) + 1;
    }
    if (occurrence.source_fired_at) {
      const day = occurrence.source_fired_at.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }
    if (occurrence.alert_id && occurrence.source_fired_at) {
      const times = alertTimes.get(occurrence.alert_id) ?? new Set();
      times.add(occurrence.source_fired_at);
      alertTimes.set(occurrence.alert_id, times);
    }
  }
  const repeatedFirings = [...alertTimes.entries()]
    .map(([alertId, times]) => ({ alert_id: alertId, distinct_source_times: times.size }))
    .filter(row => row.distinct_source_times > 1)
    .sort((left, right) => right.distinct_source_times - left.distinct_source_times);
  const sourceTimes = occurrences.map(row => row.source_fired_at_ms).filter(Number.isSafeInteger).sort((a, b) => a - b);
  return {
    unique_occurrence_count: occurrences.length,
    first_source_fired_at: sourceTimes.length ? new Date(sourceTimes[0]).toISOString() : null,
    last_source_fired_at: sourceTimes.length ? new Date(sourceTimes.at(-1)).toISOString() : null,
    by_family: Object.fromEntries(Object.entries(byFamily).sort()),
    by_actual_symbol: Object.fromEntries(Object.entries(byActualSymbol).sort()),
    by_status: Object.fromEntries(Object.entries(byStatus).sort()),
    by_description_kind: Object.fromEntries(Object.entries(byDescriptionKind).sort()),
    by_signal: Object.fromEntries(Object.entries(bySignal).sort()),
    by_source_day: Object.fromEntries(Object.entries(byDay).sort()),
    human_only_count: humanOnly,
    human_partial_count: byDescriptionKind.human_partial ?? 0,
    mixed_machine_count: byDescriptionKind.mixed_machine_and_human ?? 0,
    legacy_or_unknown_count: byDescriptionKind.legacy_or_unknown ?? 0,
    unknown_identity_count: unknown,
    possible_truncation_count: possibleTruncation,
    invalid_source_time_count: invalidSourceTime,
    multi_signal_notification_count: multiSignalNotifications,
    signal_count: signalCount,
    repeated_firings: repeatedFirings,
  };
}

export function occurrenceWithinWindow(occurrence, startMs, endMs) {
  return Number.isSafeInteger(occurrence?.source_fired_at_ms)
    && occurrence.source_fired_at_ms >= startMs
    && occurrence.source_fired_at_ms < endMs;
}

export function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeAlertLogRows(rows) {
  return [REQUIRED_COLUMNS.join(','), ...rows.map(row => [
    row.alert_id,
    row.host_ticker_raw,
    row.name,
    row.description,
    row.source_fired_at_raw,
    row.webhook_status,
  ].map(csvField).join(','))].join('\n');
}

export function requiredAlertLogColumns() {
  return clone(REQUIRED_COLUMNS);
}
