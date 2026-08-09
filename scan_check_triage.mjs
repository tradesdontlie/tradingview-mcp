import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachePaths, evidenceHash } from './src/core/check_runtime.mjs';

const TIMEFRAME = '360';
const STATUS = Object.freeze({ CHECK_NOW: 'CHECK_NOW', WATCH: 'WATCH', BLOCKED: 'BLOCKED', EXCLUDE: 'EXCLUDE' });
const NEGATIVE_SIGNALS = new Set(['AVOID', 'LOAI']);

function add(set, value) {
  if (value) set.add(value);
}

function normalizeDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function exchangeKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const board = value.trim().toUpperCase();
  return board === 'HSX' ? 'HOSE' : board;
}

function explicitExchangeConflict(rawTicker, rawExchange) {
  if (typeof rawTicker !== 'string' || !rawTicker.includes(':')) return false;
  const [embeddedExchange] = rawTicker.trim().split(':');
  const embedded = exchangeKey(embeddedExchange);
  const explicit = exchangeKey(rawExchange);
  return Boolean(embedded && explicit && embedded !== explicit);
}

function canonicalIdentity(rawTicker, rawExchange = null) {
  if (rawTicker && typeof rawTicker === 'object') {
    rawExchange = rawTicker.exchange ?? rawExchange;
    rawTicker = rawTicker.ticker ?? rawTicker.symbol ?? rawTicker.full_name;
  }
  if (typeof rawTicker !== 'string' && typeof rawTicker !== 'number') return null;
  const text = String(rawTicker).trim().toUpperCase();
  if (!text) return null;
  if (explicitExchangeConflict(text, rawExchange)) return null;
  const parts = text.split(':');
  const exchange = (parts.length > 1 ? parts.shift() : rawExchange);
  const symbol = parts.join(':');
  if (typeof exchange !== 'string' || !exchange.trim() || !symbol.trim()) return null;
  const board = exchangeKey(exchange);
  const ticker = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9._-]+$/.test(board) || !/^[A-Z0-9._!/-]+$/.test(ticker)) return null;
  return { full: `${board}:${ticker}`, exchange: board, short: ticker };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'not-object' };
    return { value };
  } catch {
    return { error: 'invalid-json' };
  }
}

function resolveClock(options) {
  const source = options.clock ?? options.now ?? process.env.TRIAGE_NOW
    ?? process.env.TRIAGE_CLOCK ?? (() => Date.now());
  let value = typeof source === 'function' ? source() : source;
  const ms = timestamp(value);
  if (ms === null) throw new Error('TRIAGE_CLOCK_INVALID');
  return { ms, iso: iso(ms) };
}

function resolveFreshness(options) {
  const value = options.freshnessMs ?? options.freshnessThresholdMs ?? options.freshnessThreshold
    ?? process.env.TRIAGE_FRESHNESS_MS ?? process.env.FRESHNESS_THRESHOLD_MS;
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('TRIAGE_FRESHNESS_MS_REQUIRED');
  }
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error('TRIAGE_FRESHNESS_MS_INVALID');
  return ms;
}

function resolvePaths(options) {
  const scanLatestPath = options.scanLatestPath ?? options.scanPath ?? process.env.SCAN_LATEST_PATH;
  const checkDataRoot = options.checkDataRoot ?? options.dataRoot ?? process.env.CHECK_DATA_ROOT;
  const outputPath = options.outputPath ?? process.env.TRIAGE_OUTPUT_PATH ?? null;
  if (!scanLatestPath) throw new Error('SCAN_LATEST_PATH_REQUIRED');
  if (!checkDataRoot) throw new Error('CHECK_DATA_ROOT_REQUIRED');
  return {
    scanLatestPath: path.resolve(scanLatestPath),
    checkDataRoot: path.resolve(checkDataRoot),
    outputPath: outputPath ? path.resolve(outputPath) : null,
  };
}

function scanTimestamp(scan, date) {
  const direct = timestamp(scan.generated_at ?? scan.candidate_computed_at);
  if (direct !== null) return direct;
  if (date && typeof scan.scan_time === 'string') {
    const parsed = timestamp(`${date}T${scan.scan_time.replace(/Z$/, '')}Z`);
    if (parsed !== null) return parsed;
  }
  return null;
}

function scanRows(scan) {
  if (Array.isArray(scan?.results)) return scan.results;
  if (Array.isArray(scan?.candidates)) return scan.candidates;
  return [];
}

function scanSignal(row) {
  return row?.signal ?? row?.sig ?? row?.discovery_signal
    ?? row?.decision?.signal ?? row?.decision?.status ?? null;
}

function hasNegativeEvidence(row) {
  const values = [
    row?.signal, row?.sig, row?.discovery_signal,
    row?.decision?.signal, row?.decision?.status,
    row?.canonical_signal, row?.canonical_status, row?.negative_signal,
  ];
  return values.some(value => NEGATIVE_SIGNALS.has(String(value ?? '').trim().toUpperCase()))
    || row?.canonical_negative === true;
}

function priorityFor(row) {
  const explicit = row?.triage_status ?? row?.priority ?? row?.manual_priority;
  if (String(explicit ?? '').trim().toUpperCase() === STATUS.WATCH) return STATUS.WATCH;
  if (String(explicit ?? '').trim().toUpperCase() === STATUS.CHECK_NOW) return STATUS.CHECK_NOW;
  return String(scanSignal(row) ?? '').trim().toUpperCase() === STATUS.WATCH
    ? STATUS.WATCH : STATUS.CHECK_NOW;
}

function warningCodes(scan, row) {
  const warnings = new Set();
  const sectorWarnings = scan?.sector_warnings ?? scan?.sector?.warnings ?? row?.sector_warnings;
  const heatWarnings = scan?.heat?.warnings ?? scan?.heat_warnings;
  if (Array.isArray(sectorWarnings) && sectorWarnings.length) add(warnings, 'SECTOR_WARNING');
  if (Array.isArray(heatWarnings) && heatWarnings.length) add(warnings, 'HEAT_WARNING');
  return warnings;
}

function checkFilePattern(dataRoot, short, outputPath) {
  const paths = cachePaths(dataRoot, short, TIMEFRAME);
  const latestName = path.basename(paths.latest);
  const safeShort = latestName.replace(/^check_/, '').replace(/_360_latest\.json$/, '');
  const escaped = safeShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^check_${escaped}(?:_\\d{8})?_360(?:_latest)?\\.json$|^check_${escaped}_latest\\.json$`);
  const explicit = new Set([paths.dated, paths.latest, paths.legacyLatest].filter(Boolean).map(file => path.resolve(file)));
  let names = [];
  try {
    names = fs.readdirSync(dataRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => path.resolve(dataRoot, entry.name));
  } catch {
    names = [];
  }
  for (const file of explicit) if (fs.existsSync(file)) names.push(file);
  return [...new Set(names)].filter(file => file !== outputPath).sort();
}

function inspectCheck(payload, expected, scanMeta, clockMs, freshnessMs) {
  const blockers = new Set();
  const missing = new Set();
  const rawTicker = payload?.ticker ?? payload?.symbol;
  const identityConflict = explicitExchangeConflict(rawTicker, payload?.exchange);
  const identity = canonicalIdentity(rawTicker, payload?.exchange);
  if (identityConflict) add(blockers, 'CHECK_IDENTITY_CONFLICT');
  if (!identity) {
    add(blockers, 'CHECK_IDENTITY_MISSING');
    add(missing, 'check.ticker_exchange');
  } else if (identity.full !== expected.full) {
    add(blockers, 'CHECK_IDENTITY_MISMATCH');
  }
  if (String(payload?.timeframe ?? '') !== TIMEFRAME) {
    add(blockers, 'CHECK_TIMEFRAME');
    add(missing, 'check.timeframe');
  }
  if (payload?.tf_confirmed !== true) {
    add(blockers, 'CHECK_TF_UNCONFIRMED');
    add(missing, 'check.tf_confirmed');
  }
  if (payload?.symbol_confirmed !== true) {
    add(blockers, 'CHECK_SYMBOL_UNCONFIRMED');
    add(missing, 'check.symbol_confirmed');
  }
  const checkDate = normalizeDate(payload?.market_date ?? payload?.date);
  if (!checkDate) {
    add(blockers, 'CHECK_DATE_MISSING');
    add(missing, 'check.market_date');
  } else if (scanMeta.date && checkDate !== scanMeta.date) {
    add(blockers, 'CHECK_DATE_MISMATCH');
  }
  if (typeof payload?.candidate_batch_id !== 'string' || !payload.candidate_batch_id.trim()) {
    add(blockers, 'CHECK_JOIN_UNPROVEN');
    add(missing, 'check.candidate_batch_id');
  } else if (!scanMeta.batch || payload.candidate_batch_id !== scanMeta.batch) {
    add(blockers, 'CHECK_BATCH_MISMATCH');
  }
  if (payload?.partial === true || payload?.complete === false || payload?.status === 'PARTIAL'
    || payload?.state === 'PARTIAL' || payload?.error || (Array.isArray(payload?.errors) && payload.errors.length)) {
    add(blockers, 'CHECK_PARTIAL');
  }
  if (payload?.evidence_quality?.overall === 'PROVISIONAL' || payload?.signal_quality === 'PROVISIONAL') {
    add(blockers, 'CHECK_PARTIAL');
  }
  const generatedMs = timestamp(payload?.generated_at);
  const asOfMs = timestamp(payload?.as_of);
  if (generatedMs === null) {
    add(blockers, 'CHECK_GENERATED_AT_MISSING');
    add(missing, 'check.generated_at');
  }
  if (asOfMs === null) {
    add(blockers, 'CHECK_AS_OF_MISSING');
    add(missing, 'check.as_of');
  }
  if (generatedMs !== null && asOfMs !== null) {
    if (generatedMs > asOfMs) add(blockers, 'CHECK_TEMPORAL_ORDER');
    if (generatedMs > clockMs || asOfMs > clockMs) add(blockers, 'CHECK_FUTURE');
    if (scanMeta.generatedMs !== null && asOfMs < scanMeta.generatedMs) add(blockers, 'CHECK_BEFORE_SCAN');
    if (asOfMs <= clockMs && clockMs - asOfMs > freshnessMs) add(blockers, 'CHECK_STALE');
  }
  return { blockers, missing, asOfMs, asOf: asOfMs === null ? null : iso(asOfMs) };
}

function inspectFiles(files, expected, scanMeta, clockMs, freshnessMs) {
  const blockers = new Set();
  const missing = new Set();
  const parsed = [];
  for (const file of files) {
    const result = readJson(file);
    if (result.error) {
      add(blockers, 'CHECK_MALFORMED');
      continue;
    }
    const hash = evidenceHash(result.value);
    if (!parsed.some(item => item.hash === hash)) parsed.push({ ...result, hash, file });
  }
  if (!files.length) add(blockers, 'CHECK_MISSING');
  if (files.length > 1) add(blockers, 'CHECK_DUPLICATE');
  let selected = parsed[0] ?? null;
  for (const item of parsed) {
    const check = inspectCheck(item.value, expected, scanMeta, clockMs, freshnessMs);
    for (const code of check.blockers) add(blockers, code);
    for (const field of check.missing) add(missing, field);
    if (!selected || item.file < selected.file) selected = { ...item, check };
    else if (item === parsed[0]) selected = { ...item, check };
  }
  if (selected && !selected.check) selected.check = inspectCheck(selected.value, expected, scanMeta, clockMs, freshnessMs);
  return {
    blockers,
    missing,
    selected,
    asOf: selected?.check?.asOf ?? null,
    evidenceHash: selected?.hash ?? null,
  };
}

function scanMeta(scan) {
  const date = normalizeDate(scan?.market_date ?? scan?.date);
  const generatedMs = scanTimestamp(scan ?? {}, date);
  return {
    date,
    batch: typeof scan?.candidate_batch_id === 'string' && scan.candidate_batch_id.trim()
      ? scan.candidate_batch_id : null,
    generatedMs,
    malformed: !scan || typeof scan !== 'object' || Array.isArray(scan),
  };
}

function makeRecord(row, scan, meta, clock, freshnessMs, paths, duplicateScan = false) {
  const rawTicker = row?.ticker ?? row?.symbol;
  const identityConflict = explicitExchangeConflict(rawTicker, row?.exchange);
  const identity = canonicalIdentity(rawTicker, row?.exchange);
  const expected = identity ?? { full: row?.ticker ?? row?.symbol ?? null, short: null };
  const blockers = new Set();
  const missing = new Set();
  const warnings = warningCodes(scan, row);
  if (identityConflict) add(blockers, 'SCAN_IDENTITY_CONFLICT');
  if (!identity) {
    add(blockers, 'SCAN_IDENTITY_MISSING');
    add(missing, 'scan.ticker_exchange');
  }
  if (!meta.date) {
    add(blockers, 'SCAN_DATE_MISSING');
    add(missing, 'scan.market_date');
  }
  if (!meta.batch) {
    add(blockers, 'SCAN_BATCH_ID_MISSING');
    add(missing, 'scan.candidate_batch_id');
  }
  if (meta.generatedMs === null) {
    add(blockers, 'SCAN_TIME_MISSING');
    add(missing, 'scan.generated_at');
  } else if (meta.generatedMs > clock.ms) {
    add(blockers, 'SCAN_FUTURE');
  } else if (clock.ms - meta.generatedMs > freshnessMs) {
    add(blockers, 'SCAN_STALE');
  }
  if (meta.malformed) add(blockers, 'SCAN_MALFORMED');
  if (!row || typeof row !== 'object' || Array.isArray(row)) add(blockers, 'SCAN_MALFORMED');
  if (duplicateScan) add(blockers, 'SCAN_DUPLICATE');
  const signal = scanSignal(row);
  if (signal === null || String(signal).trim() === '' || ['UNKNOWN', 'N/A', 'ERR'].includes(String(signal).trim().toUpperCase())) {
    add(blockers, 'SCAN_SIGNAL_UNPROVEN');
    add(missing, 'scan.signal');
  }
  if ((Array.isArray(row?.missing_fields) && row.missing_fields.length)
    || (Array.isArray(row?.missing_evidence) && row.missing_evidence.length)) {
    add(blockers, 'SCAN_MISSING_EVIDENCE');
    add(missing, 'scan.evidence');
  }
  const check = identity
    ? inspectFiles(checkFilePattern(paths.checkDataRoot, identity.short, paths.outputPath), identity, meta, clock.ms, freshnessMs)
    : { blockers: new Set(['CHECK_MISSING']), missing: new Set(['check.ticker_exchange']), selected: null, asOf: null, evidenceHash: null };
  for (const code of check.blockers) add(blockers, code);
  for (const field of check.missing) add(missing, field);
  const status = blockers.size ? STATUS.BLOCKED : hasNegativeEvidence(row) ? STATUS.EXCLUDE : priorityFor(row);
  const checkRef = { as_of: check.asOf, evidence_hash: check.evidenceHash };
  return {
    schema_version: 1,
    status,
    ticker: identity?.full ?? (typeof expected.full === 'string' ? expected.full : null),
    timeframe: TIMEFRAME,
    scan_ref: { date: meta.date, candidate_batch_id: meta.batch },
    check_ref: checkRef,
    blockers: [...blockers].sort(),
    missing_evidence: [...missing].sort(),
    warnings: [...warnings].sort(),
    manual_next_step: status === STATUS.BLOCKED ? 'resolve evidence blockers, then rerun triage'
      : status === STATUS.EXCLUDE ? 'keep out of the manual shortlist'
        : status === STATUS.CHECK_NOW ? 'perform manual chart review' : 'monitor and review later',
  };
}

function writeOutput(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

export function triageScanCheck(options = {}) {
  const paths = resolvePaths(options);
  const clock = resolveClock(options);
  const freshnessMs = resolveFreshness(options);
  const scanResult = readJson(paths.scanLatestPath);
  const scan = scanResult.value ?? {};
  const meta = scanMeta(scan);
  if (scanResult.error) meta.malformed = true;
  const rows = scanResult.error ? [{}] : scanRows(scan);
  if (!rows.length) rows.push({});
  const counts = new Map();
  for (const row of rows) {
    const identity = canonicalIdentity(row?.ticker ?? row?.symbol, row?.exchange);
    if (identity) counts.set(identity.full, (counts.get(identity.full) ?? 0) + 1);
  }
  const records = rows.map(row => {
    const identity = canonicalIdentity(row?.ticker ?? row?.symbol, row?.exchange);
    return makeRecord(row, scan, meta, clock, freshnessMs, paths, Boolean(identity && counts.get(identity.full) > 1));
  }).sort((a, b) => String(a.ticker ?? '').localeCompare(String(b.ticker ?? '')));
  const output = { schema_version: 1, generated_at: clock.iso, records };
  if (paths.outputPath) {
    const forbidden = new Set([paths.scanLatestPath]);
    for (const record of records) {
      if (record.ticker) {
        const identity = canonicalIdentity(record.ticker);
        if (identity) for (const file of checkFilePattern(paths.checkDataRoot, identity.short, paths.outputPath)) forbidden.add(file);
      }
    }
    if (forbidden.has(paths.outputPath) || path.basename(paths.outputPath).toLowerCase() === 'journal.db') {
      throw new Error('TRIAGE_OUTPUT_NOT_ISOLATED');
    }
    writeOutput(paths.outputPath, output);
  }
  return output;
}

export const runTriage = triageScanCheck;
export const buildTriage = triageScanCheck;
export const triage = triageScanCheck;

export function main() {
  try {
    const output = triageScanCheck();
    if (!process.env.TRIAGE_OUTPUT_PATH) process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry === import.meta.url) process.exitCode = main();
