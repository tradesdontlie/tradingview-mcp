import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  FEED_SUBSTITUTIONS,
  SOURCE_BINDINGS,
  sourceBindingFor,
} from './investment-attention-config.js';
import {
  InvestmentAttentionLedger,
  INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION,
  normalizeAttentionEvent,
  sha256,
} from './investment-attention-ledger.js';
import { decodeSmaFibAlertMask } from './sma-fib-alert-scanner.js';

export const INVESTMENT_ATTENTION_COLLECTOR_SCHEMA_VERSION = 'investment-attention-collector/v1';
export const INVESTMENT_ATTENTION_HEARTBEAT_FILENAME = 'collector-heartbeat.json';
export const INVESTMENT_ATTENTION_OFFSET_FILENAME = 'collector-offset.json';

const SMA_EVENT_NAMES = new Set([
  'MA_APPROACH', 'MA_TOUCH', 'MA_CROSS_UP', 'MA_CROSS_DOWN',
  'FIB_APPROACH', 'FIB_TOUCH', 'FIB_INSIDE',
]);
const RSI_EVENT_NAMES = new Set([
  'NEW_DEVELOPING_REGULAR_BULL', 'NEW_DEVELOPING_HIDDEN_BULL',
  'CONFIRMED_REGULAR_BULL', 'CONFIRMED_HIDDEN_BULL',
]);
const CUP_EVENT_NAMES = new Set([
  'RIM_APPROACH', 'HANDLE_FORMING', 'HANDLE_READY',
  'PRICE_BREAKOUT_CONFIRMED', 'INVALIDATED', 'EXPIRED',
]);

export const ATTENTION_HUMAN_ENVELOPE_MARKER = '\n--- DATA ---\n';

function unwrapHumanEnvelope(value) {
  if (typeof value !== 'string') return value;
  const markerIndex = value.indexOf(ATTENTION_HUMAN_ENVELOPE_MARKER);
  return markerIndex >= 0
    ? value.slice(markerIndex + ATTENTION_HUMAN_ENVELOPE_MARKER.length)
    : value;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be positive`);
  return number;
}

function stringValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}

function normalizeProfile(value) {
  const profile = stringValue(String(value ?? ''), 'profile').toUpperCase();
  if (profile === 'D' || profile === '1D') return 'D';
  if (profile === 'W' || profile === '1W') return 'W';
  if (profile === '4H' || profile === '240') return '4H';
  throw new TypeError(`unsupported attention profile: ${value}`);
}

function parseKeyValues(line) {
  const fields = {};
  for (const field of line.split('|')) {
    const separator = field.indexOf('=');
    if (separator > 0) fields[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return fields;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '' || value === 'na') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceForSma(shard, sourceBinding) {
  return {
    definition_version: sourceBinding?.definition_version ?? SOURCE_BINDINGS.sma_fib.definition_version,
    source_sha256: sourceBinding?.source_sha256 ?? SOURCE_BINDINGS.sma_fib.source_sha256,
    input_sha256: sourceBinding?.input_sha256 ?? null,
    script_id: sourceBinding?.script_id ?? null,
    script_version: sourceBinding?.script_version ?? null,
    feed_symbol: sourceBinding?.feed_symbol ?? null,
    verification_method: sourceBinding?.verification_method ?? `local-payload-parser: sma shard ${shard}`,
  };
}

function parseSmaFibPayload(rawText, { sourceBinding = null } = {}) {
  const lines = rawText.split(/\r?\n/u);
  const header = lines.shift() ?? '';
  const headerParts = header.split('|');
  if (headerParts[0] !== 'SMA_FIB_ATTENTION' || headerParts[1] !== 'V1') {
    throw new Error('payload is not an SMA_FIB_ATTENTION|V1 message');
  }
  const headerFields = parseKeyValues(headerParts.slice(2).join('|'));
  const profile = normalizeProfile(headerFields.PROFILE);
  const shard = positiveInteger(headerFields.SHARD, 'SMA shard');
  const source = sourceForSma(shard, sourceBinding);
  const events = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf('|');
    if (separator <= 0) throw new Error(`SMA payload line ${lineIndex + 2} has no symbol`);
    const eventSymbol = stringValue(line.slice(0, separator), 'SMA symbol').toUpperCase();
    const parts = line.slice(separator + 1).split('|');
    const path = parts.shift();
    if (path !== 'PROVISIONAL' && path !== 'CLOSED') throw new Error(`unsupported SMA path: ${path}`);
    const fields = parseKeyValues(parts.join('|'));
    const mask = Number(fields.MASK);
    const names = fields.EVENTS
      ? fields.EVENTS.split('+').filter(Boolean).map(name => name.toUpperCase())
      : decodeSmaFibAlertMask(mask);
    const decoded = decodeSmaFibAlertMask(mask);
    if (names.length === 0 || names.some(name => !SMA_EVENT_NAMES.has(name))
      || names.join('|') !== decoded.join('|')) {
      throw new Error(`SMA payload event mask/name mismatch on ${eventSymbol}`);
    }
    const barTime = positiveInteger(fields.STAGE_TIME, 'SMA STAGE_TIME');
    const closeTime = fields.TARGET_CLOSE_UTC && fields.TARGET_CLOSE_UTC !== 'na'
      ? Date.parse(`${fields.TARGET_CLOSE_UTC.replace(' ', 'T')}Z`)
      : null;
    for (const eventType of names) {
      events.push(normalizeAttentionEvent({
        family: 'sma_fib',
        symbol: eventSymbol,
        timeframe: profile,
        event_type: eventType,
        direction: 'bullish',
        data_bar_time_ms: barTime,
        data_bar_close_time_ms: Number.isFinite(closeTime) ? closeTime : null,
        provisional: path === 'PROVISIONAL',
        episode_key: `${fields.MA_EP ?? 'na'}|${fields.PAIR ?? 'na'}`,
        source,
        values: {
          mask,
          path,
          confluence: fields.CONF === '1',
          close: optionalNumber(fields.C),
          prior_sma: optionalNumber(fields.SMA),
          golden_pocket: fields.GP ?? null,
        },
        parsed_fields: fields,
      }, { observedAt: Date.now() }));
    }
  }
  if (events.length === 0) throw new Error('SMA payload contains no events');
  return {
    family: 'sma_fib',
    schema_version: 'sma-fib-watchlist-alert-message/v1',
    profile,
    shard,
    events,
  };
}

function parseRsiPayload(payload, { sourceBinding = null } = {}) {
  if (!isPlainObject(payload) || payload.schema_version !== 'rsi-watchlist-alert-batch/v1') {
    throw new Error('payload is not an rsi-watchlist-alert-batch/v1 object');
  }
  const profile = normalizeProfile(payload.profile);
  if (!Array.isArray(payload.events) || payload.events.length === 0) throw new Error('RSI payload contains no events');
  const source = {
    definition_version: payload.definition_version ?? sourceBinding?.definition_version ?? SOURCE_BINDINGS.rsi_scanner_s1.definition_version,
    source_sha256: payload.source_sha256 ?? sourceBinding?.source_sha256 ?? null,
    input_sha256: sourceBinding?.input_sha256 ?? '645911b121a555428202b480401be5ea4e093b7e3b6d8baaed220a43654a603a',
    script_id: sourceBinding?.script_id ?? null,
    script_version: sourceBinding?.script_version ?? null,
    verification_method: sourceBinding?.verification_method ?? 'local-payload-parser: RSI batch',
  };
  const events = payload.events.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`RSI event ${index} is not an object`);
    const eventType = stringValue(item.event ?? item.type, `RSI event ${index} type`).toUpperCase();
    if (!RSI_EVENT_NAMES.has(eventType)) throw new Error(`unsupported RSI event type: ${eventType}`);
    return normalizeAttentionEvent({
      family: 'rsi',
      symbol: stringValue(item.symbol, `RSI event ${index} symbol`),
      timeframe: profile,
      event_type: eventType,
      direction: 'bullish',
      data_bar_time_ms: positiveInteger(item.data_bar_time_ms, `RSI event ${index} data_bar_time_ms`),
      provisional: item.provisional === true,
      source,
      parsed_fields: item,
    }, { observedAt: Date.now() });
  });
  return { family: 'rsi', schema_version: payload.schema_version, profile, events };
}

function parseCupPayload(payload, { sourceBinding = null } = {}) {
  if (!isPlainObject(payload) || payload.schema_version !== 'cup-handle-alert-v1') {
    throw new Error('payload is not a cup-handle-alert-v1 object');
  }
  const eventType = stringValue(payload.to_stage, 'Cup to_stage').toUpperCase();
  if (!CUP_EVENT_NAMES.has(eventType)) throw new Error(`unsupported Cup stage: ${eventType}`);
  const source = {
    definition_version: payload.detector_version ?? sourceBinding?.definition_version ?? SOURCE_BINDINGS.cup_and_handle.definition_version,
    source_sha256: sourceBinding?.source_sha256 ?? SOURCE_BINDINGS.cup_and_handle.source_sha256,
    input_sha256: sourceBinding?.input_sha256 ?? null,
    script_id: sourceBinding?.script_id ?? null,
    script_version: sourceBinding?.script_version ?? null,
    feed_symbol: payload.symbol ?? null,
    verification_method: sourceBinding?.verification_method ?? 'local-payload-parser: Cup lifecycle JSON',
  };
  const event = normalizeAttentionEvent({
    family: 'cup_and_handle',
    symbol: stringValue(payload.symbol, 'Cup symbol'),
    timeframe: normalizeProfile(payload.timeframe),
    event_type: eventType,
    direction: 'bullish',
    data_bar_time_ms: positiveInteger(payload.detection_bar_open_ms ?? payload.detection_bar_close_ms, 'Cup detection bar time'),
    data_bar_close_time_ms: positiveInteger(payload.detection_bar_close_ms, 'Cup detection bar close time'),
    provisional: payload.provisional === true,
    episode_key: stringValue(payload.pattern_id, 'Cup pattern_id'),
    source_event_id: stringValue(payload.event_id, 'Cup event_id'),
    source,
    lifecycle: {
      family_id: payload.family_id,
      pattern_id: payload.pattern_id,
      from_stage: payload.from_stage,
      to_stage: payload.to_stage,
      reason_code: payload.reason_code,
      quality_score: payload.quality_score,
      rim: payload.rim,
      pivot: payload.pivot,
      invalidation: payload.invalidation,
      p1_time_ms: payload.p1_time_ms,
      p2_time_ms: payload.p2_time_ms,
      p3_time_ms: payload.p3_time_ms,
      p4_time_ms: payload.p4_time_ms,
    },
    parsed_fields: payload,
  }, { observedAt: Date.now() });
  return { family: 'cup_and_handle', schema_version: payload.schema_version, profile: event.timeframe, events: [event] };
}

export function parseAttentionPayload(input, { sourceBinding = null } = {}) {
  const rawText = typeof input === 'string' ? input : JSON.stringify(input);
  if (!rawText.trim()) throw new TypeError('attention payload must not be empty');
  const machineInput = unwrapHumanEnvelope(input);
  let payload = machineInput;
  if (typeof machineInput === 'string') {
    try { payload = JSON.parse(machineInput); } catch { payload = null; }
  }
  if (isPlainObject(payload) && payload.schema_version === 'rsi-watchlist-alert-batch/v1') {
    return { raw_payload: rawText, ...parseRsiPayload(payload, { sourceBinding }) };
  }
  if (isPlainObject(payload) && payload.schema_version === 'cup-handle-alert-v1') {
    return { raw_payload: rawText, ...parseCupPayload(payload, { sourceBinding }) };
  }
  if (typeof machineInput === 'string' && machineInput.startsWith('SMA_FIB_ATTENTION|')) {
    return { raw_payload: rawText, ...parseSmaFibPayload(machineInput, { sourceBinding }) };
  }
  throw new Error('unsupported attention payload schema');
}

function statePath(stateDir, filename) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new TypeError('stateDir must be absolute');
  const root = resolve(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('collector state directory is unsafe');
  return `${root}/${filename}`;
}

function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

export function writeCollectorHeartbeat(stateDir, heartbeat) {
  const path = statePath(stateDir, INVESTMENT_ATTENTION_HEARTBEAT_FILENAME);
  const value = {
    schema_version: INVESTMENT_ATTENTION_COLLECTOR_SCHEMA_VERSION,
    pid: process.pid,
    alive_at: new Date().toISOString(),
    ...heartbeat,
  };
  writeAtomic(path, value);
  return value;
}

function readOffset(stateDir) {
  const path = statePath(stateDir, INVESTMENT_ATTENTION_OFFSET_FILENAME);
  if (!existsSync(path)) return { path, offset: 0, line_count: 0 };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('collector offset is invalid');
  return { path, offset: value.offset, line_count: Number(value.line_count) || 0 };
}

export async function ingestAttentionPayload({ stateDir, payload, sourceBinding = null, bootstrap = false, observedAt = Date.now() } = {}) {
  const parsed = parseAttentionPayload(payload, { sourceBinding });
  const ledger = new InvestmentAttentionLedger({ stateDir, now: () => observedAt }).load();
  const result = ledger.ingest({
    payload: parsed.raw_payload,
    events: parsed.events,
    bootstrap,
    observedAt,
  });
  return {
    schema_version: INVESTMENT_ATTENTION_COLLECTOR_SCHEMA_VERSION,
    ledger_schema_version: INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION,
    family: parsed.family,
    parsed_event_count: parsed.events.length,
    ...result,
  };
}

export async function collectInboxOnce({
  stateDir,
  inboxPath,
  sourceBindings = {},
  bootstrap = false,
  observedAt = Date.now(),
} = {}) {
  if (typeof inboxPath !== 'string' || !isAbsolute(inboxPath)) throw new TypeError('inboxPath must be absolute');
  const offset = readOffset(stateDir);
  if (!existsSync(inboxPath)) {
    return writeCollectorHeartbeat(stateDir, {
      inbox_path: inboxPath,
      result: 'inbox_missing',
      processed_payload_count: 0,
      processed_byte_offset: offset.offset,
      source: 'local_inbox_only_no_webhook',
    });
  }
  const metadata = lstatSync(inboxPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('collector inbox is unsafe');
  const text = readFileSync(inboxPath, 'utf8');
  const available = text.slice(offset.offset);
  const completeLength = available.endsWith('\n') ? available.length : available.lastIndexOf('\n') + 1;
  const complete = completeLength > 0 ? available.slice(0, completeLength) : '';
  const lines = complete.split('\n').filter(Boolean);
  const results = [];
  for (const line of lines) {
    const parsed = parseAttentionPayload(line);
    const binding = parsed.family === 'sma_fib'
      ? sourceBindings.sma_fib
      : parsed.family === 'rsi'
        ? sourceBindings.rsi
        : sourceBindings.cup_and_handle;
    results.push(await ingestAttentionPayload({
      stateDir,
      payload: line,
      sourceBinding: binding,
      bootstrap,
      observedAt,
    }));
  }
  const nextOffset = offset.offset + complete.length;
  writeAtomic(offset.path, {
    schema_version: INVESTMENT_ATTENTION_COLLECTOR_SCHEMA_VERSION,
    offset: nextOffset,
    line_count: offset.line_count + lines.length,
    updated_at: new Date(observedAt).toISOString(),
  });
  return writeCollectorHeartbeat(stateDir, {
    inbox_path: inboxPath,
    result: 'ok',
    processed_payload_count: lines.length,
    processed_byte_offset: nextOffset,
    incomplete_bytes_held: available.length - complete.length,
    source: 'local_inbox_only_no_webhook',
    outcomes: results.map(result => ({
      family: result.family,
      event_count: result.event_count,
      notification_count: result.notifications.length,
      revision: result.revision,
    })),
  });
}

export function collectorSourceBindings() {
  return {
    sma_fib: sourceBindingFor('sma_fib'),
    rsi: { ...sourceBindingFor('rsi', 1), input_sha256: '645911b121a555428202b480401be5ea4e093b7e3b6d8baaed220a43654a603a' },
    cup_and_handle: sourceBindingFor('cup_and_handle'),
  };
}

export function feedSubstitutionFor(sourceSymbol) {
  return FEED_SUBSTITUTIONS.find(row => row.source_symbol === String(sourceSymbol).toUpperCase()) ?? null;
}

export function payloadSha256(payload) {
  return sha256(typeof payload === 'string' ? payload : JSON.stringify(payload));
}
