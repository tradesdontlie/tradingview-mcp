import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION = 'investment-attention-ledger/v1';
export const INVESTMENT_ATTENTION_EVENT_SCHEMA_VERSION = 'investment-attention-event/v1';
export const INVESTMENT_ATTENTION_LEDGER_FILENAME = 'investment-attention-events.jsonl';
export const INVESTMENT_ATTENTION_INDEX_FILENAME = 'investment-attention-latest.json';
export const INVESTMENT_ATTENTION_LOCK_FILENAME = 'investment-attention-writer.lock';

const FAMILY_SET = new Set(['sma_fib', 'rsi', 'cup_and_handle']);
const TIMEFRAME_MAP = new Map([
  ['D', 'D'], ['1D', 'D'], ['DAY', 'D'],
  ['W', 'W'], ['1W', 'W'], ['WEEK', 'W'],
  ['4H', '4H'], ['240', '4H'], ['240M', '4H'],
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-finite numbers are not valid ledger values');
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function iso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function symbol(value, label = 'symbol') {
  if (typeof value !== 'string' || !value.trim() || !value.includes(':')) {
    throw new TypeError(`${label} must be an exchange-qualified symbol`);
  }
  return value.trim().toUpperCase();
}

function timeframe(value, label = 'timeframe') {
  const result = TIMEFRAME_MAP.get(String(value ?? '').trim().toUpperCase());
  if (!result) throw new TypeError(`${label} must be D, W, or 4H`);
  return result;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}

function optionalSha(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} must be a SHA-256`);
  return value;
}

export function routeKey({ family, symbol: routeSymbol, timeframe: routeTimeframe }) {
  if (!FAMILY_SET.has(family)) throw new TypeError(`unsupported family: ${family}`);
  return `${family}|${symbol(routeSymbol)}|${timeframe(routeTimeframe)}`;
}

function eventIdentity(event) {
  return {
    family: event.family,
    symbol: event.symbol,
    timeframe: event.timeframe,
    event_type: event.event_type,
    data_bar_time_ms: event.data_bar_time_ms,
    episode_key: event.episode_key ?? null,
    source_event_id: event.source_event_id ?? null,
    definition_version: event.source?.definition_version ?? null,
    source_sha256: event.source?.source_sha256 ?? null,
  };
}

export function stableEventId(event) {
  return `ia1_${sha256(canonicalJson(eventIdentity(event)))}`;
}

function normalizeSource(source) {
  if (source === null || source === undefined) return null;
  if (!isPlainObject(source)) throw new TypeError('event source must be an object');
  const result = {};
  for (const key of [
    'definition_version', 'source_sha256', 'input_sha256', 'script_id',
    'script_version', 'feed_symbol', 'verification_method',
  ]) {
    if (source[key] !== undefined && source[key] !== null) result[key] = source[key];
  }
  if (result.source_sha256 !== undefined) optionalSha(result.source_sha256, 'event source_sha256');
  if (result.input_sha256 !== undefined) optionalSha(result.input_sha256, 'event input_sha256');
  if (result.script_id !== undefined) nonempty(result.script_id, 'event script_id');
  if (result.script_version !== undefined) nonempty(String(result.script_version), 'event script_version');
  if (result.feed_symbol !== undefined) result.feed_symbol = symbol(result.feed_symbol, 'event feed_symbol');
  return result;
}

export function normalizeAttentionEvent(input, { source = null, observedAt = Date.now() } = {}) {
  if (!isPlainObject(input)) throw new TypeError('attention event must be an object');
  const family = nonempty(input.family, 'event family').toLowerCase();
  if (!FAMILY_SET.has(family)) throw new TypeError(`unsupported attention family: ${family}`);
  const eventSymbol = symbol(input.symbol);
  const eventTimeframe = timeframe(input.timeframe);
  const eventType = nonempty(input.event_type ?? input.type ?? input.to_stage, 'event type').toUpperCase();
  const barTime = positiveInteger(
    input.data_bar_time_ms ?? input.detection_bar_open_ms ?? input.detection_bar_close_ms,
    'event data_bar_time_ms',
  );
  const normalizedSource = normalizeSource(input.source ?? source);
  const episodeKey = input.episode_key
    ?? input.pattern_id
    ?? input.pair_id
    ?? input.ma_episode_start_time_ms
    ?? null;
  const result = {
    schema_version: INVESTMENT_ATTENTION_EVENT_SCHEMA_VERSION,
    family,
    symbol: eventSymbol,
    timeframe: eventTimeframe,
    event_type: eventType,
    direction: input.direction === undefined || input.direction === null
      ? null
      : nonempty(input.direction, 'event direction').toLowerCase(),
    data_bar_time_ms: barTime,
    data_bar_close_time_ms: input.data_bar_close_time_ms == null
      ? null
      : positiveInteger(input.data_bar_close_time_ms, 'event data_bar_close_time_ms'),
    provisional: input.provisional === true,
    episode_key: episodeKey === null ? null : String(episodeKey),
    // `event_id` is generated by this ledger and must not be reinterpreted as
    // an upstream source ID when the JSONL file is replayed after restart.
    source_event_id: input.source_event_id ?? null,
    source: normalizedSource,
    lifecycle: input.lifecycle === undefined ? null : clone(input.lifecycle),
    values: input.values === undefined ? null : clone(input.values),
    parsed_fields: input.parsed_fields === undefined ? null : clone(input.parsed_fields),
    observed_at: iso(observedAt, 'observedAt'),
  };
  if (result.source_event_id !== null) result.source_event_id = nonempty(String(result.source_event_id), 'event source_event_id');
  result.event_id = stableEventId(result);
  return result;
}

function stateSummary(event, record) {
  return {
    event_id: event.event_id,
    family: event.family,
    symbol: event.symbol,
    timeframe: event.timeframe,
    event_type: event.event_type,
    data_bar_time_ms: event.data_bar_time_ms,
    data_bar_close_time_ms: event.data_bar_close_time_ms,
    provisional: event.provisional,
    episode_key: event.episode_key,
    source_event_id: event.source_event_id,
    source: clone(event.source),
    lifecycle: clone(event.lifecycle),
    observed_at: record.observed_at,
    payload_sha256: record.payload_sha256,
    ingest_result: record.ingest_result,
    notified: record.notified,
  };
}

function emptyRouteState(event) {
  return {
    route_key: routeKey(event),
    family: event.family,
    symbol: event.symbol,
    timeframe: event.timeframe,
    updated_at: null,
    latest_event: null,
    latest_events: {},
    current_lifecycle: {},
  };
}

function updateRouteState(routes, event, record) {
  const key = routeKey(event);
  const current = routes[key] ?? emptyRouteState(event);
  const summary = stateSummary(event, record);
  current.updated_at = record.observed_at;
  current.latest_event = summary;
  current.latest_events[event.event_type] = summary;
  if (event.family === 'cup_and_handle' && event.episode_key) {
    current.current_lifecycle[event.episode_key] = {
      pattern_id: event.episode_key,
      stage: event.event_type,
      event_id: event.event_id,
      data_bar_time_ms: event.data_bar_time_ms,
      provisional: event.provisional,
      source: clone(event.source),
      observed_at: record.observed_at,
    };
  }
  routes[key] = current;
}

function indexFor(routes, revision, eventCount, generatedAt) {
  const sortedRoutes = Object.fromEntries(Object.keys(routes).sort().map(key => {
    const value = routes[key];
    value.latest_events = Object.fromEntries(Object.keys(value.latest_events).sort().map(eventType => [
      eventType,
      value.latest_events[eventType],
    ]));
    value.current_lifecycle = Object.fromEntries(Object.keys(value.current_lifecycle).sort().map(patternId => [
      patternId,
      value.current_lifecycle[patternId],
    ]));
    return [key, value];
  }));
  return {
    schema_version: INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION,
    generated_at: generatedAt,
    revision,
    event_record_count: eventCount,
    route_count: Object.keys(sortedRoutes).length,
    routes: sortedRoutes,
  };
}

function stateDirPath(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
    throw new TypeError('stateDir must be an absolute path');
  }
  const result = resolve(stateDir);
  if (result === dirname(result)) throw new TypeError('stateDir must be a dedicated directory');
  mkdirSync(result, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(result);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`unsafe ledger state directory: ${result}`);
  return result;
}

export function ledgerPaths(stateDir) {
  const root = stateDirPath(stateDir);
  return Object.freeze({
    state_dir: root,
    ledger_path: join(root, INVESTMENT_ATTENTION_LEDGER_FILENAME),
    index_path: join(root, INVESTMENT_ATTENTION_INDEX_FILENAME),
    lock_path: join(root, INVESTMENT_ATTENTION_LOCK_FILENAME),
  });
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  if (!source) return [];
  const lines = source.split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid ledger JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function acquireWriterLock(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const busy = new Error(`investment attention ledger writer is already active: ${path}`);
      busy.code = 'ledger_writer_busy';
      throw busy;
    }
    throw error;
  }
  return () => {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  };
}

function writeAtomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class InvestmentAttentionLedger {
  constructor({ stateDir, now = Date.now } = {}) {
    this.paths = ledgerPaths(stateDir);
    this.now = now;
    this.loaded = false;
    this.revision = 0;
    this.eventRecordCount = 0;
    this.eventStates = new Map();
    this.routes = {};
  }

  load() {
    if (this.loaded) return this;
    const records = readJsonLines(this.paths.ledger_path);
    for (const record of records) this.#applyExistingRecord(record);
    this.loaded = true;
    this.#writeIndex();
    return this;
  }

  #applyExistingRecord(record) {
    if (!isPlainObject(record) || record.record_type !== 'event') {
      throw new Error('ledger record is not an event record');
    }
    const sequence = positiveInteger(record.sequence, 'ledger sequence');
    if (sequence <= this.revision) throw new Error('ledger sequence is not strictly increasing');
    this.revision = sequence;
    this.eventRecordCount += 1;
    const event = normalizeAttentionEvent(record.event, { observedAt: record.observed_at });
    if (event.event_id !== record.event_id) throw new Error(`ledger event ID mismatch at sequence ${sequence}`);
    const previous = this.eventStates.get(event.event_id);
    const shouldApply = !previous
      || (previous.event.provisional === true && event.provisional === false);
    if (shouldApply) {
      this.eventStates.set(event.event_id, { event, record });
      if (record.ingest_result !== 'duplicate' && record.ingest_result !== 'duplicate_regression') {
        updateRouteState(this.routes, event, record);
      }
    }
  }

  #writeIndex() {
    const generatedAt = iso(this.now(), 'ledger clock');
    writeAtomicJson(this.paths.index_path, indexFor(this.routes, this.revision, this.eventRecordCount, generatedAt));
  }

  #assertLoaded() {
    if (!this.loaded) this.load();
  }

  ingest({ payload, events, source = null, bootstrap = false, observedAt = this.now() } = {}) {
    this.#assertLoaded();
    if (typeof payload !== 'string' && !isPlainObject(payload)) {
      throw new TypeError('payload must be the exact payload text or a plain object');
    }
    if (!Array.isArray(events) || events.length === 0) throw new TypeError('at least one normalized event is required');
    if (typeof bootstrap !== 'boolean') throw new TypeError('bootstrap must be boolean');
    const observed = iso(observedAt, 'observedAt');
    const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const payloadValue = typeof payload === 'string'
      ? (() => { try { return JSON.parse(payload); } catch { return payload; } })()
      : clone(payload);
    const payloadHash = sha256(payloadText);
    const normalizedEvents = events.map(event => normalizeAttentionEvent(event, { source, observedAt: observed }));
    const outcomes = normalizedEvents.map(event => {
      const previous = this.eventStates.get(event.event_id)?.event ?? null;
      let ingestResult;
      if (previous === null) ingestResult = bootstrap ? 'bootstrap_suppressed' : 'new';
      else if (previous.provisional === true && event.provisional === false) ingestResult = 'state_upgrade';
      else if (previous.provisional === false && event.provisional === true) ingestResult = 'duplicate_regression';
      else ingestResult = 'duplicate';
      return { event, previous, ingestResult, notified: ingestResult === 'new' && !bootstrap };
    });

    const release = acquireWriterLock(this.paths.lock_path);
    try {
      const lines = outcomes.map(({ event, ingestResult, notified }) => {
        const sequence = this.revision + 1;
        this.revision = sequence;
        this.eventRecordCount += 1;
        const record = {
          schema_version: INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION,
          record_type: 'event',
          sequence,
          event_id: event.event_id,
          ingest_result: ingestResult,
          notified,
          bootstrap: bootstrap === true,
          observed_at: observed,
          payload_sha256: payloadHash,
          payload_text: payloadText,
          payload: clone(payloadValue),
          event,
        };
        this.eventStates.set(event.event_id, { event, record });
        if (ingestResult !== 'duplicate' && ingestResult !== 'duplicate_regression') {
          updateRouteState(this.routes, event, record);
        }
        return `${JSON.stringify(record)}\n`;
      });
      const descriptor = openSync(this.paths.ledger_path, 'a', 0o600);
      try {
        for (const line of lines) writeSync(descriptor, line, null, 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.#writeIndex();
    } finally {
      release();
    }
    return {
      schema_version: INVESTMENT_ATTENTION_LEDGER_SCHEMA_VERSION,
      revision: this.revision,
      payload_sha256: payloadHash,
      event_count: outcomes.length,
      persisted_record_count: outcomes.length,
      notifications: outcomes.filter(outcome => outcome.notified).map(outcome => clone(outcome.event)),
      outcomes: outcomes.map(outcome => ({
        event_id: outcome.event.event_id,
        ingest_result: outcome.ingestResult,
        notified: outcome.notified,
        provisional: outcome.event.provisional,
      })),
    };
  }

  readIndex() {
    this.#assertLoaded();
    return clone(indexFor(this.routes, this.revision, this.eventRecordCount, iso(this.now(), 'ledger clock')));
  }

  query({ symbol: querySymbol, timeframe: queryTimeframe, family, sinceRevision } = {}) {
    this.#assertLoaded();
    const normalizedSymbol = querySymbol === undefined ? null : symbol(querySymbol);
    const normalizedTimeframe = queryTimeframe === undefined ? null : timeframe(queryTimeframe);
    if (family !== undefined && !FAMILY_SET.has(family)) throw new TypeError(`unsupported family: ${family}`);
    const routes = Object.values(this.routes).filter(route => (
      (normalizedSymbol === null || route.symbol === normalizedSymbol)
      && (normalizedTimeframe === null || route.timeframe === normalizedTimeframe)
      && (family === undefined || route.family === family)
    ));
    const since = sinceRevision === undefined ? null : Number(sinceRevision);
    if (since !== null && (!Number.isSafeInteger(since) || since < 0)) throw new TypeError('sinceRevision must be a non-negative integer');
    return {
      schema_version: 'investment-attention-query/v1',
      revision: this.revision,
      unchanged: since !== null && since === this.revision,
      notifications_emitted: false,
      routes: clone(routes),
      current_lifecycle: clone(routes.flatMap(route => Object.values(route.current_lifecycle ?? {}))),
      latest_events: clone(routes.map(route => ({ route_key: route.route_key, latest_event: route.latest_event, latest_events: route.latest_events }))),
    };
  }
}

export function openInvestmentAttentionLedger(options) {
  return new InvestmentAttentionLedger(options).load();
}

export function readInvestmentAttentionLedgerRecords(stateDir) {
  const paths = ledgerPaths(stateDir);
  return readJsonLines(paths.ledger_path).map(clone);
}

export function assertLedgerPath(path, stateDir, expectedBasename = INVESTMENT_ATTENTION_LEDGER_FILENAME) {
  const root = stateDirPath(stateDir);
  if (!isAbsolute(path) || basename(path) !== expectedBasename || resolve(dirname(path)) !== root) {
    throw new Error('ledger path is outside the dedicated state directory');
  }
  return path;
}
