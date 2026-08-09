import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cachePaths, evidenceHash } from './src/core/check_runtime.mjs';

export const QUALITY_OUTPUT_BASENAME = 'scan_check_quality_report.v1.json';
const TIMEFRAME = '360';

function add(set, value) {
  if (value) set.add(value);
}

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function exchangeKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const board = value.trim().toUpperCase();
  return board === 'HSX' ? 'HOSE' : board;
}

function inspectIdentity(rawTicker, rawExchange) {
  const source = { ticker: rawTicker ?? null, exchange: rawExchange ?? null };
  if (typeof rawTicker !== 'string' || !rawTicker.trim()) {
    return { state: 'MISSING', full: null, short: null, source };
  }
  const text = rawTicker.trim().toUpperCase();
  const parts = text.split(':');
  const embeddedExchange = parts.length > 1 ? exchangeKey(parts.shift()) : null;
  const short = parts.join(':').trim();
  const explicitExchange = exchangeKey(rawExchange);
  if (!short || !/^[A-Z0-9._!/-]+$/.test(short)) {
    return { state: 'MALFORMED', full: null, short: null, source };
  }
  if (embeddedExchange && explicitExchange && embeddedExchange !== explicitExchange) {
    return { state: 'CONFLICT', full: null, short, source };
  }
  const exchange = embeddedExchange ?? explicitExchange;
  if (!exchange) return { state: 'MISSING', full: null, short, source };
  if (!/^[A-Z0-9._-]+$/.test(exchange)) return { state: 'MALFORMED', full: null, short, source };
  return { state: 'PRESENT', full: `${exchange}:${short}`, short, source };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'NOT_OBJECT' };
    return { value };
  } catch {
    return { error: 'INVALID_JSON' };
  }
}

function scanRows(scan) {
  if (Array.isArray(scan?.results)) return scan.results;
  if (Array.isArray(scan?.candidates)) return scan.candidates;
  return [];
}

function resolveClock(options) {
  const value = typeof options.clock === 'function' ? options.clock() : options.clock
    ?? options.now ?? process.env.QUALITY_NOW ?? (() => Date.now())();
  const ms = timestamp(value);
  if (ms === null) throw new Error('QUALITY_CLOCK_INVALID');
  return { ms, iso: new Date(ms).toISOString() };
}

function resolveFreshness(options) {
  const raw = options.freshnessMs ?? process.env.QUALITY_FRESHNESS_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('QUALITY_FRESHNESS_MS_REQUIRED');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error('QUALITY_FRESHNESS_MS_INVALID');
  return value;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePaths(options) {
  const scanPath = options.scanLatestPath ?? options.scanPath ?? process.env.SCAN_LATEST_PATH;
  const checkRoot = options.checkDataRoot ?? options.dataRoot ?? process.env.CHECK_DATA_ROOT;
  const outputPath = options.outputPath ?? process.env.QUALITY_OUTPUT_PATH ?? null;
  const outputRoot = options.outputRoot ?? process.env.QUALITY_OUTPUT_ROOT ?? null;
  if (!scanPath) throw new Error('SCAN_LATEST_PATH_REQUIRED');
  if (!checkRoot) throw new Error('CHECK_DATA_ROOT_REQUIRED');
  const resolved = {
    scanPath: path.resolve(scanPath),
    checkRoot: path.resolve(checkRoot),
    outputPath: outputPath ? path.resolve(outputPath) : null,
    outputRoot: outputRoot ? path.resolve(outputRoot) : null,
  };
  if (resolved.outputPath) {
    if (!resolved.outputRoot) throw new Error('QUALITY_OUTPUT_ROOT_REQUIRED');
    if (path.basename(resolved.outputPath) !== QUALITY_OUTPUT_BASENAME
      || !isInside(resolved.outputRoot, resolved.outputPath)) {
      throw new Error('QUALITY_OUTPUT_NOT_ISOLATED');
    }
    if (isInside(resolved.outputRoot, resolved.scanPath)
      || isInside(resolved.outputRoot, resolved.checkRoot)
      || isInside(resolved.checkRoot, resolved.outputRoot)
      || resolved.outputPath.toLowerCase().endsWith('.db')) {
      throw new Error('QUALITY_OUTPUT_PROTECTED_DESTINATION');
    }
  }
  return resolved;
}

function cacheCandidates(dataRoot, short) {
  if (!short) return [];
  const aliases = cachePaths(dataRoot, short, TIMEFRAME);
  const aliasNames = new Set(Object.values(aliases).filter(Boolean).map(file => path.basename(file)));
  const stem = path.basename(aliases.dated, '.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = path.basename(aliases.legacyLatest ?? '', '.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const datedPattern = new RegExp(`^${stem.replace(/_360$/, '')}_\\d{8}_360(?:_latest)?\\.json$`);
  let entries = [];
  try {
    entries = fs.readdirSync(dataRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && (aliasNames.has(entry.name)
        || datedPattern.test(entry.name)
        || (legacy && entry.name === `${legacy}.json`)))
      .map(entry => path.resolve(dataRoot, entry.name));
  } catch {
    return [];
  }
  return [...new Set(entries)].sort();
}

function warningCodes(scan, row) {
  const warnings = new Set();
  const sector = scan?.sector_warnings ?? row?.sector_warnings;
  const heat = scan?.heat_warnings ?? scan?.heat?.warnings ?? row?.heat_warnings;
  if (Array.isArray(sector) && sector.length) add(warnings, 'SECTOR_WARNING');
  if (Array.isArray(heat) && heat.length) add(warnings, 'HEAT_WARNING');
  return [...warnings].sort();
}

function inspectCheck(payload, scanContext, scanIdentity, clockMs, freshnessMs) {
  const blockers = new Set();
  const identity = inspectIdentity(payload?.ticker ?? payload?.symbol, payload?.exchange);
  if (identity.state !== 'PRESENT') add(blockers, `CHECK_IDENTITY_${identity.state}`);
  else if (scanIdentity.state === 'PRESENT' && identity.full !== scanIdentity.full) add(blockers, 'CHECK_IDENTITY_MISMATCH');

  const checkBatch = typeof payload?.candidate_batch_id === 'string' && payload.candidate_batch_id.trim()
    ? payload.candidate_batch_id : null;
  let batchState = 'EXACT';
  if (!checkBatch || !scanContext.batch) batchState = 'MISSING';
  else if (checkBatch !== scanContext.batch) batchState = 'MISMATCH';
  if (batchState !== 'EXACT') add(blockers, `CHECK_BATCH_${batchState}`);

  const checkDate = normalizeDate(payload?.market_date ?? payload?.date);
  let dateState = 'MATCH';
  if (!checkDate || !scanContext.date) dateState = 'MISSING';
  else if (checkDate !== scanContext.date) dateState = 'MISMATCH';
  if (dateState !== 'MATCH') add(blockers, `CHECK_DATE_${dateState}`);

  const generatedMs = timestamp(payload?.generated_at);
  const asOfMs = timestamp(payload?.as_of);
  let temporalState = 'ORDERED';
  if (generatedMs === null || asOfMs === null || scanContext.generatedMs === null) temporalState = 'MISSING';
  else if (generatedMs > clockMs || asOfMs > clockMs) temporalState = 'FUTURE';
  else if (generatedMs > asOfMs || asOfMs < scanContext.generatedMs) temporalState = 'MISORDERED';
  if (temporalState !== 'ORDERED') add(blockers, `CHECK_TEMPORAL_${temporalState}`);

  let freshnessState = 'PASS';
  if (asOfMs === null) freshnessState = 'MISSING';
  else if (asOfMs > clockMs) freshnessState = 'FUTURE';
  else if (clockMs - asOfMs > freshnessMs) freshnessState = 'STALE';
  if (freshnessState !== 'PASS') add(blockers, `CHECK_FRESHNESS_${freshnessState}`);

  let partialState = 'COMPLETE';
  if (payload?.partial === true || payload?.complete === false
    || payload?.state === 'PARTIAL' || payload?.error || (Array.isArray(payload?.errors) && payload.errors.length)
    || payload?.evidence_quality?.overall === 'PROVISIONAL' || payload?.signal_quality === 'PROVISIONAL') {
    partialState = 'PARTIAL';
    add(blockers, 'CHECK_PARTIAL');
  }

  return {
    blockers,
    metrics: {
      identity: identity.state,
      batch: batchState,
      date: dateState,
      temporal: temporalState,
      freshness: freshnessState,
      partial: partialState,
    },
    source_values: {
      ticker: payload?.ticker ?? payload?.symbol ?? null,
      exchange: payload?.exchange ?? null,
      candidate_batch_id: payload?.candidate_batch_id ?? null,
      market_date: payload?.market_date ?? payload?.date ?? null,
      generated_at: payload?.generated_at ?? null,
      as_of: payload?.as_of ?? null,
      timeframe: payload?.timeframe ?? null,
      status: payload?.status ?? null,
    },
  };
}

function inspectCandidateFiles(files, scanContext, scanIdentity, clockMs, freshnessMs) {
  const blockers = new Set();
  const parsed = [];
  let malformedCount = 0;
  for (const file of files) {
    const result = readJson(file);
    if (result.error) {
      malformedCount += 1;
      add(blockers, 'CHECK_MALFORMED');
      continue;
    }
    parsed.push({ file, value: result.value, hash: evidenceHash(result.value) });
  }
  const hashes = new Set(parsed.map(item => item.hash));
  let duplicateState = 'NONE';
  if (files.length > 1) {
    duplicateState = hashes.size <= 1 && malformedCount === 0 ? 'ALIAS' : 'CONFLICT';
    add(blockers, duplicateState === 'ALIAS' ? 'CHECK_DUPLICATE_ALIAS' : 'CHECK_DUPLICATE_CONFLICT');
  }
  if (!files.length) add(blockers, 'CHECK_MISSING');
  const checks = parsed.map(item => {
    const inspected = inspectCheck(item.value, scanContext, scanIdentity, clockMs, freshnessMs);
    for (const blocker of inspected.blockers) add(blockers, blocker);
    return {
      evidence_hash: item.hash,
      metrics: inspected.metrics,
      source_values: inspected.source_values,
    };
  });
  return {
    blockers,
    cache: files.length ? 'FOUND' : 'MISSING',
    paths: files,
    duplicate: duplicateState,
    file_count: files.length,
    malformed_count: malformedCount,
    checks,
  };
}

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function buildRecord(row, scan, scanContext, clock, freshnessMs) {
  const blockers = new Set();
  const scanIdentity = inspectIdentity(row?.ticker ?? row?.symbol, row?.exchange);
  if (scanIdentity.state !== 'PRESENT') add(blockers, `SCAN_IDENTITY_${scanIdentity.state}`);
  if (!scanContext.date) add(blockers, 'SCAN_DATE_MISSING');
  if (!scanContext.batch) add(blockers, 'SCAN_BATCH_MISSING');

  let scanFreshness = 'PASS';
  if (scanContext.generatedMs === null) scanFreshness = 'MISSING';
  else if (scanContext.generatedMs > clock.ms) scanFreshness = 'FUTURE';
  else if (clock.ms - scanContext.generatedMs > freshnessMs) scanFreshness = 'STALE';
  if (scanFreshness !== 'PASS') add(blockers, `SCAN_FRESHNESS_${scanFreshness}`);
  if (!row || typeof row !== 'object' || Array.isArray(row)) add(blockers, 'SCAN_MALFORMED');
  if ((Array.isArray(row?.missing_fields) && row.missing_fields.length)
    || (Array.isArray(row?.missing_evidence) && row.missing_evidence.length)) {
    add(blockers, 'SCAN_MISSING_EVIDENCE');
    add(blockers, 'SCAN_PARTIAL');
  }
  const scanSignal = row?.signal ?? row?.sig ?? row?.discovery_signal
    ?? row?.decision?.signal ?? null;
  if (scanSignal === null || String(scanSignal).trim() === ''
    || ['UNKNOWN', 'N/A', 'ERR'].includes(String(scanSignal).trim().toUpperCase())) {
    add(blockers, 'SCAN_SIGNAL_UNPROVEN');
  }

  const beforeJoin = blockers.size > 0;
  const candidateFiles = cacheCandidates(scanContext.checkRoot, scanIdentity.short);
  const check = inspectCandidateFiles(candidateFiles, scanContext, scanIdentity, clock.ms, freshnessMs);
  for (const blocker of check.blockers) add(blockers, blocker);
  const adjudicationNeeded = scanIdentity.state !== 'PRESENT'
    || check.duplicate !== 'NONE'
    || check.checks.some(item => item.metrics.batch !== 'EXACT')
    || check.malformed_count > 0;

  return {
    source_values: {
      scan: {
        ticker: row?.ticker ?? row?.symbol ?? null,
        exchange: row?.exchange ?? null,
        signal: row?.signal ?? null,
        status: row?.status ?? null,
        decision_status: row?.decision?.status ?? null,
        priority: row?.priority ?? null,
        candidate_batch_id: scan?.candidate_batch_id ?? null,
        market_date: scan?.market_date ?? scan?.date ?? null,
        generated_at: scan?.generated_at ?? scan?.candidate_computed_at ?? null,
        scan_time: scan?.scan_time ?? null,
      },
      checks: check.checks.map(item => item.source_values),
    },
    metrics: {
      identity: scanIdentity.state,
      cache: check.cache,
      batch: check.checks.length ? [...new Set(check.checks.map(item => item.metrics.batch))].sort() : ['NOT_OBSERVED'],
      date: check.checks.length ? [...new Set(check.checks.map(item => item.metrics.date))].sort() : ['NOT_OBSERVED'],
      temporal: check.checks.length ? [...new Set(check.checks.map(item => item.metrics.temporal))].sort() : ['NOT_OBSERVED'],
      freshness: { scan: scanFreshness, checks: check.checks.map(item => item.metrics.freshness) },
      duplicate: check.duplicate,
      partial: check.malformed_count > 0 ? 'MALFORMED'
        : check.checks.some(item => item.metrics.partial === 'PARTIAL') || blockers.has('SCAN_PARTIAL') ? 'PARTIAL' : 'COMPLETE',
    },
    blocked_before_join: beforeJoin,
    blocked: blockers.size > 0,
    adjudication_needed: adjudicationNeeded,
    blockers: [...blockers].sort(),
    warnings: warningCodes(scan, row),
    cache_paths: check.paths,
    evidence_hashes: check.checks.map(item => item.evidence_hash).sort(),
  };
}

function writeOutput(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

export function inspectScanCheckQuality(options = {}) {
  const paths = resolvePaths(options);
  const clock = resolveClock(options);
  const freshnessMs = resolveFreshness(options);
  const scanResult = readJson(paths.scanPath);
  const scan = scanResult.value ?? {};
  const date = normalizeDate(scan?.market_date ?? scan?.date);
  const generatedMs = timestamp(scan?.generated_at ?? scan?.candidate_computed_at);
  const batch = typeof scan?.candidate_batch_id === 'string' && scan.candidate_batch_id.trim()
    ? scan.candidate_batch_id : null;
  const rows = scanResult.error ? [{}] : scanRows(scan);
  if (!rows.length) rows.push({});
  const scanContext = { date, generatedMs, batch, checkRoot: paths.checkRoot };
  const records = rows.map(row => buildRecord(row, scan, scanContext, clock, freshnessMs));
  if (scanResult.error) records[0].blockers = [...new Set([...records[0].blockers, 'SCAN_MALFORMED'])].sort();

  const blockerDistribution = {};
  for (const record of records) for (const blocker of record.blockers) increment(blockerDistribution, blocker);
  const output = {
    schema_version: 1,
    report_kind: 'SCAN_CHECK_EVIDENCE_QUALITY',
    generated_at: clock.iso,
    effectiveness_proof: false,
    summary: {
      record_count: records.length,
      blocked_record_count: records.filter(record => record.blocked).length,
      blocked_before_join_count: records.filter(record => record.blocked_before_join).length,
      adjudication_needed_count: records.filter(record => record.adjudication_needed).length,
      blocker_distribution: Object.fromEntries(Object.entries(blockerDistribution).sort(([a], [b]) => a.localeCompare(b))),
    },
    records,
  };
  if (paths.outputPath) writeOutput(paths.outputPath, output);
  return output;
}

export function main() {
  try {
    const output = inspectScanCheckQuality();
    if (!process.env.QUALITY_OUTPUT_PATH) process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry === import.meta.url) process.exitCode = main();
