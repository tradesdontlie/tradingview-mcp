import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QUALITY_OUTPUT_BASENAME, inspectScanCheckQuality } from './scan_check_quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-check-quality-p0-'));
const now = '2026-08-09T09:10:00.000Z';
const freshnessMs = 60 * 60 * 1000;
const forbidden = ['B' + 'UY', 'S' + 'ELL', 'ALL' + 'OWED'];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

function scanRow(overrides = {}) {
  return { ticker: 'HOSE:ACB', signal: 'POSITIVE', priority: 'CHECK_NOW', ...overrides };
}

function scanArtifact(results = [scanRow()], overrides = {}) {
  return {
    date: '2026-08-09',
    generated_at: '2026-08-09T09:00:00.000Z',
    candidate_batch_id: 'batch-1',
    results,
    ...overrides,
  };
}

function checkPayload(overrides = {}) {
  return {
    ticker: 'HOSE:ACB',
    exchange: 'HOSE',
    timeframe: '360',
    market_date: '2026-08-09',
    generated_at: '2026-08-09T09:01:00.000Z',
    as_of: '2026-08-09T09:01:00.000Z',
    candidate_batch_id: 'batch-1',
    ...overrides,
  };
}

function fixture(name, scan = scanArtifact(), checks = []) {
  const fixtureRoot = path.join(root, name);
  const scanPath = writeJson(path.join(fixtureRoot, 'source', 'scan_latest.json'), scan);
  const checkRoot = path.join(fixtureRoot, 'source', 'checks');
  fs.mkdirSync(checkRoot, { recursive: true });
  for (const [file, value] of checks) {
    const target = path.join(checkRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof value === 'string') fs.writeFileSync(target, value, 'utf8');
    else writeJson(target, value);
  }
  return { fixtureRoot, scanPath, checkRoot };
}

function run(fx, options = {}) {
  return inspectScanCheckQuality({
    scanLatestPath: fx.scanPath,
    checkDataRoot: fx.checkRoot,
    now,
    freshnessMs,
    ...options,
  });
}

function one(report) {
  assert.equal(report.schema_version, 1);
  assert.equal(report.report_kind, 'SCAN_CHECK_EVIDENCE_QUALITY');
  assert.equal(report.effectiveness_proof, false);
  assert.deepEqual(Object.keys(report).sort(), [
    'effectiveness_proof', 'generated_at', 'records', 'report_kind', 'schema_version', 'summary',
  ]);
  assert.deepEqual(Object.keys(report.summary).sort(), [
    'adjudication_needed_count', 'blocked_before_join_count', 'blocked_record_count',
    'blocker_distribution', 'record_count',
  ]);
  assert.equal(report.records.length, 1);
  const record = report.records[0];
  assert.deepEqual(Object.keys(record).sort(), [
    'adjudication_needed', 'blocked', 'blocked_before_join', 'blockers', 'cache_paths',
    'evidence_hashes', 'metrics', 'source_values', 'warnings',
  ]);
  return record;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  // P0-A1: reproduce the current all-blocked shape without inventing exchange or cache provenance.
  const liveShapeRows = Array.from({ length: 16 }, (_, index) => scanRow({
    ticker: `T${String(index).padStart(2, '0')}`,
    signal: index < 5 ? 'N/A' : 'WATCH',
    missing_fields: index < 5 ? ['evidence'] : [],
  }));
  const currentFailure = run(fixture('current-failure', scanArtifact(liveShapeRows)));
  assert.equal(currentFailure.summary.record_count, 16);
  assert.equal(currentFailure.summary.blocked_record_count, 16);
  assert.equal(currentFailure.summary.blocked_before_join_count, 16);
  assert.equal(currentFailure.summary.adjudication_needed_count, 16);
  assert.equal(currentFailure.summary.blocker_distribution.SCAN_IDENTITY_MISSING, 16);
  assert.equal(currentFailure.summary.blocker_distribution.CHECK_MISSING, 16);
  assert.equal(currentFailure.summary.blocker_distribution.SCAN_SIGNAL_UNPROVEN, 5);
  assert.equal(currentFailure.summary.blocker_distribution.SCAN_MISSING_EVIDENCE, 5);

  // P0-A2: exact/mismatch/missing batch provenance.
  let record = one(run(fixture('batch-exact', scanArtifact(), [
    ['check_ACB_360.json', checkPayload()],
  ])));
  assert.deepEqual(record.metrics.batch, ['EXACT']);
  assert.equal(record.blocked, false);

  record = one(run(fixture('batch-mismatch', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ candidate_batch_id: 'batch-2' })],
  ])));
  assert.deepEqual(record.metrics.batch, ['MISMATCH']);
  assert.ok(record.blockers.includes('CHECK_BATCH_MISMATCH'));

  record = one(run(fixture('batch-missing', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ candidate_batch_id: undefined })],
  ])));
  assert.deepEqual(record.metrics.batch, ['MISSING']);
  assert.ok(record.blockers.includes('CHECK_BATCH_MISSING'));

  // Full/short/conflicting identities; HSX/HOSE is canonical identity normalization, not inference.
  record = one(run(fixture('identity-full', scanArtifact([
    scanRow({ ticker: 'HSX:ACB', exchange: 'HOSE' }),
  ]), [['check_ACB_360.json', checkPayload({ ticker: 'HOSE:ACB', exchange: 'HSX' })]])));
  assert.equal(record.metrics.identity, 'PRESENT');
  assert.equal(record.blocked, false);

  record = one(run(fixture('identity-short', scanArtifact([
    scanRow({ ticker: 'ACB', exchange: undefined }),
  ]), [['check_ACB_360.json', checkPayload()]])));
  assert.equal(record.metrics.identity, 'MISSING');
  assert.ok(record.blockers.includes('SCAN_IDENTITY_MISSING'));
  assert.equal(record.source_values.scan.ticker, 'ACB');
  assert.equal(record.source_values.scan.exchange, null);

  record = one(run(fixture('identity-conflict', scanArtifact([
    scanRow({ ticker: 'HOSE:ACB', exchange: 'HNX' }),
  ]), [['check_ACB_360.json', checkPayload()]])));
  assert.equal(record.metrics.identity, 'CONFLICT');
  assert.ok(record.blockers.includes('SCAN_IDENTITY_CONFLICT'));

  record = one(run(fixture('check-identity-conflict', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ ticker: 'HOSE:ACB', exchange: 'HNX' })],
  ])));
  assert.ok(record.blockers.includes('CHECK_IDENTITY_CONFLICT'));

  // Date, temporal order/future, and inclusive freshness boundaries.
  record = one(run(fixture('date-mismatch', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ market_date: '2026-08-08' })],
  ])));
  assert.deepEqual(record.metrics.date, ['MISMATCH']);

  record = one(run(fixture('temporal-order', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ generated_at: '2026-08-09T09:02:00.000Z', as_of: '2026-08-09T09:01:00.000Z' })],
  ])));
  assert.deepEqual(record.metrics.temporal, ['MISORDERED']);

  record = one(run(fixture('temporal-future', scanArtifact(), [
    ['check_ACB_360.json', checkPayload({ generated_at: '2026-08-09T09:11:00.000Z', as_of: '2026-08-09T09:11:00.000Z' })],
  ])));
  assert.deepEqual(record.metrics.temporal, ['FUTURE']);

  for (const [offset, expected] of [[999, 'PASS'], [1000, 'PASS'], [1001, 'STALE']]) {
    const stamp = new Date(Date.parse(now) - offset).toISOString();
    record = one(run(fixture(`freshness-${offset}`, scanArtifact([], { generated_at: stamp, results: [scanRow()] }), [
      ['check_ACB_360.json', checkPayload({ generated_at: stamp, as_of: stamp })],
    ]), { freshnessMs: 1000 }));
    assert.equal(record.metrics.freshness.scan, expected);
    assert.deepEqual(record.metrics.freshness.checks, [expected]);
  }

  // Duplicate alias (same hash), duplicate conflict, malformed, and partial are distinct blockers.
  const aliasPayload = checkPayload();
  record = one(run(fixture('duplicate-alias', scanArtifact(), [
    ['check_ACB_360.json', aliasPayload],
    ['check_ACB_360_latest.json', aliasPayload],
  ])));
  assert.equal(record.metrics.duplicate, 'ALIAS');
  assert.ok(record.blockers.includes('CHECK_DUPLICATE_ALIAS'));
  assert.equal(record.cache_paths.length, 2);
  assert.equal(record.evidence_hashes[0], record.evidence_hashes[1]);

  record = one(run(fixture('duplicate-conflict', scanArtifact(), [
    ['check_ACB_360.json', checkPayload()],
    ['check_ACB_latest.json', checkPayload({ as_of: '2026-08-09T09:02:00.000Z' })],
  ])));
  assert.equal(record.metrics.duplicate, 'CONFLICT');
  assert.ok(record.blockers.includes('CHECK_DUPLICATE_CONFLICT'));

  record = one(run(fixture('malformed', scanArtifact(), [['check_ACB_360.json', '{']] )));
  assert.equal(record.metrics.partial, 'MALFORMED');
  assert.ok(record.blockers.includes('CHECK_MALFORMED'));

  record = one(run(fixture('partial', scanArtifact([
    scanRow({ missing_fields: ['volume'] }),
  ]), [['check_ACB_360.json', checkPayload({ partial: true })]])));
  assert.equal(record.metrics.partial, 'PARTIAL');
  assert.ok(record.blockers.includes('SCAN_PARTIAL'));
  assert.ok(record.blockers.includes('CHECK_PARTIAL'));

  // P0-A3/P0-A4: warnings stay warning-only; source signal/status/priority values round-trip unchanged.
  const sourceValues = scanRow({ signal: 'AVOID', status: 'EXCLUDE', priority: 'WATCH' });
  const warningReport = run(fixture('warning-only', scanArtifact([sourceValues], {
    sector_warnings: ['raw-sector-warning'],
    heat_warnings: ['raw-heat-warning'],
  }), [['check_ACB_360.json', checkPayload()]]));
  record = one(warningReport);
  assert.equal(record.blocked, false);
  assert.deepEqual(record.warnings, ['HEAT_WARNING', 'SECTOR_WARNING']);
  assert.deepEqual(record.source_values.scan.signal, 'AVOID');
  assert.deepEqual(record.source_values.scan.status, 'EXCLUDE');
  assert.deepEqual(record.source_values.scan.priority, 'WATCH');
  assert.equal(Object.hasOwn(record, 'status'), false);
  assert.equal(forbidden.some(word => JSON.stringify(warningReport).includes(word)), false);

  // Source status is evidence only: top-level, nested decision, and check status cannot change derivation.
  const statusCases = [
    { scan: 'WATCH', decision: 'POSITIVE', check: 'COMPLETE' },
    { scan: 'BLOCKED', decision: 'N/A', check: 'PARTIAL' },
  ];
  const statusReports = statusCases.map((values, index) => run(fixture(`status-only-${index}`, scanArtifact([
    scanRow({ signal: undefined, status: values.scan, decision: { status: values.decision } }),
  ]), [['check_ACB_360.json', checkPayload({ status: values.check })]])));
  const derived = report => ({
    summary: report.summary,
    blockers: report.records[0].blockers,
    metrics: report.records[0].metrics,
    blocked: report.records[0].blocked,
    blocked_before_join: report.records[0].blocked_before_join,
    adjudication_needed: report.records[0].adjudication_needed,
  });
  assert.deepEqual(derived(statusReports[0]), derived(statusReports[1]));
  for (const [index, values] of statusCases.entries()) {
    const source = statusReports[index].records[0].source_values;
    assert.equal(source.scan.status, values.scan);
    assert.equal(source.scan.decision_status, values.decision);
    assert.equal(source.checks[0].status, values.check);
  }

  // P0-A5: caller-injected isolated output only; source/check/journal hashes and mtimes are unchanged.
  const isolation = fixture('isolation', scanArtifact(), [['check_ACB_360.json', checkPayload()]]);
  const journalPath = path.join(here, 'journal.db');
  const tracked = [isolation.scanPath, path.join(isolation.checkRoot, 'check_ACB_360.json'), journalPath]
    .filter(fs.existsSync);
  const before = new Map(tracked.map(file => [file, { hash: hash(file), mtime: fs.statSync(file).mtimeMs }]));
  const outputRoot = path.join(isolation.fixtureRoot, 'isolated-shadow');
  const outputPath = path.join(outputRoot, QUALITY_OUTPUT_BASENAME);
  const isolatedReport = run(isolation, { outputRoot, outputPath });
  assert.equal(fs.existsSync(outputPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), isolatedReport);
  for (const [file, snapshot] of before) {
    assert.equal(hash(file), snapshot.hash, `${file} hash changed`);
    assert.equal(fs.statSync(file).mtimeMs, snapshot.mtime, `${file} mtime changed`);
  }
  assert.throws(() => run(isolation, {
    outputRoot: path.dirname(isolation.scanPath),
    outputPath: isolation.scanPath,
  }), /QUALITY_OUTPUT_NOT_ISOLATED|QUALITY_OUTPUT_PROTECTED_DESTINATION/);
  assert.throws(() => run(isolation, {
    outputRoot: isolation.checkRoot,
    outputPath: path.join(isolation.checkRoot, QUALITY_OUTPUT_BASENAME),
  }), /QUALITY_OUTPUT_PROTECTED_DESTINATION/);
  assert.throws(() => run(isolation, { outputPath }), /QUALITY_OUTPUT_ROOT_REQUIRED/);

  // P0-A7: bounded isolated shadow reports distributions/adjudication and explicitly is not effectiveness proof.
  assert.equal(currentFailure.effectiveness_proof, false);
  assert.ok(Object.keys(currentFailure.summary.blocker_distribution).length > 0);
  assert.equal(Number.isInteger(currentFailure.summary.adjudication_needed_count), true);

  const cliOutputRoot = path.join(root, 'cli-shadow');
  const cliOutputPath = path.join(cliOutputRoot, QUALITY_OUTPUT_BASENAME);
  const cli = spawnSync(process.execPath, [path.join(here, 'scan_check_quality.mjs')], {
    cwd: here,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCAN_LATEST_PATH: isolation.scanPath,
      CHECK_DATA_ROOT: isolation.checkRoot,
      QUALITY_OUTPUT_ROOT: cliOutputRoot,
      QUALITY_OUTPUT_PATH: cliOutputPath,
      QUALITY_NOW: now,
      QUALITY_FRESHNESS_MS: String(freshnessMs),
    },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(fs.existsSync(cliOutputPath), true);

  console.log(JSON.stringify({
    status: 'ALL PASS',
    shadow: currentFailure.summary,
    output_basename: QUALITY_OUTPUT_BASENAME,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
