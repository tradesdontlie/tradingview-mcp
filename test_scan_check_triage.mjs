import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cachePaths } from './src/core/check_runtime.mjs';
import { triageScanCheck } from './scan_check_triage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-check-triage-'));
const dataRoot = path.join(root, 'check-data');
const outputPath = path.join(root, 'derived', 'triage.json');
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(path.join(dataRoot, 'check_ACB_20260809_360.json'), JSON.stringify(checkPayload?.() ?? {}));

const now = '2026-08-09T09:10:00.000Z';
const forbidden = ['B' + 'UY', 'S' + 'ELL', 'ALL' + 'OWED'];
const hasForbidden = value => forbidden.some(word => JSON.stringify(value).includes(word));

function scanRecord(overrides = {}) {
  return {
    ticker: 'HOSE:ACB',
    signal: 'POSITIVE',
    priority: 'CHECK_NOW',
    ...overrides,
  };
}

function scanArtifact(results = [scanRecord()], overrides = {}) {
  return {
    schema_version: 1,
    date: '2026-08-09',
    generated_at: '2026-08-09T09:00:00.000Z',
    candidate_batch_id: 'batch-1',
    results,
    ...overrides,
  };
}

function checkPayload(overrides = {}) {
  return {
    schema_version: 1,
    ticker: 'HOSE:ACB',
    timeframe: '360',
    tf_confirmed: true,
    symbol_confirmed: true,
    market_date: '2026-08-09',
    generated_at: '2026-08-09T09:01:00.000Z',
    as_of: '2026-08-09T09:01:00.000Z',
    candidate_batch_id: 'batch-1',
    ...overrides,
  };
}

function writeScan(value, file = path.join(root, 'scan_latest.json')) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function writeCheck(value, name = 'check_ACB_20260809_360.json') {
  const target = path.join(dataRoot, name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
  return target;
}

function run(options = {}) {
  const scanLatestPath = options.scanLatestPath ?? writeScan(scanArtifact());
  return triageScanCheck({
    scanLatestPath,
    checkDataRoot: dataRoot,
    now,
    freshnessMs: 60 * 60 * 1000,
    ...options,
  });
}

function one(result) {
  assert.equal(result.schema_version, 1);
  assert.equal(result.records.length, 1);
  return result.records[0];
}

// A1/A2: import-safe API, all four statuses, single and batch determinism.
let record = one(run());
assert.equal(record.status, 'CHECK_NOW');
assert.equal(record.ticker, 'HOSE:ACB');
assert.equal(record.timeframe, '360');
assert.equal(record.scan_ref.candidate_batch_id, 'batch-1');
assert.equal(record.check_ref.as_of, '2026-08-09T09:01:00.000Z');
assert.deepEqual(record.blockers, []);

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ ticker: 'HNX:SHS', priority: 'WATCH' })])),
  checkDataRoot: (() => {
    const dir = path.join(root, 'watch-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'check_SHS_20260809_360.json'), JSON.stringify(checkPayload({ ticker: 'HNX:SHS' })));
    return dir;
  })(),
}));
assert.equal(record.status, 'WATCH');

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ signal: 'A' + 'VOID', priority: undefined })])),
}));
assert.equal(record.status, 'EXCLUDE');
assert.match(record.manual_next_step, /manual|shortlist/i);

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ ticker: 'HOSE:VHM', priority: 'WATCH' })])),
  checkDataRoot: path.join(root, 'missing-data'),
}));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('CHECK_MISSING'));

const batchRoot = path.join(root, 'batch-data');
fs.mkdirSync(batchRoot, { recursive: true });
fs.writeFileSync(path.join(batchRoot, 'check_ACB_20260809_360.json'), JSON.stringify(checkPayload()));
fs.writeFileSync(path.join(batchRoot, 'check_SHS_20260809_360.json'), JSON.stringify(checkPayload({ ticker: 'HNX:SHS' })));
const batch = triageScanCheck({
  scanLatestPath: writeScan(scanArtifact([
    scanRecord(), scanRecord({ ticker: 'HNX:SHS', priority: 'WATCH' }),
  ])),
  checkDataRoot: batchRoot,
  now,
  freshnessMs: 60 * 60 * 1000,
});
assert.deepEqual(batch.records.map(item => item.ticker), ['HNX:SHS', 'HOSE:ACB']);
assert.deepEqual(batch.records.map(item => item.status), ['WATCH', 'CHECK_NOW']);
assert.deepEqual(batch, triageScanCheck({
  scanLatestPath: path.join(root, 'scan_latest.json'),
  checkDataRoot: batchRoot,
  now,
  freshnessMs: 60 * 60 * 1000,
}));

// A3/A4: identity, timeframe, date, ordering, join proof and fail-closed cases.
for (const [name, overrides, code] of [
  ['identity', { ticker: 'HNX:ACB' }, 'CHECK_IDENTITY_MISMATCH'],
  ['timeframe', { timeframe: '60' }, 'CHECK_TIMEFRAME'],
  ['date', { market_date: '2026-08-08' }, 'CHECK_DATE_MISMATCH'],
  ['ordering', { generated_at: '2026-08-09T09:02:00.000Z', as_of: '2026-08-09T09:01:00.000Z' }, 'CHECK_TEMPORAL_ORDER'],
  ['future', { as_of: '2026-08-09T09:11:00.000Z' }, 'CHECK_FUTURE'],
  ['batch', { candidate_batch_id: undefined }, 'CHECK_JOIN_UNPROVEN'],
  ['partial', { partial: true }, 'CHECK_PARTIAL'],
]) {
  const dir = path.join(root, `case-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'check_ACB_20260809_360.json'), JSON.stringify(checkPayload(overrides)));
  record = one(run({ checkDataRoot: dir }));
  assert.equal(record.status, 'BLOCKED', name);
  assert.ok(record.blockers.includes(code), `${name}: ${record.blockers.join(',')}`);
}

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ exchange: 'HNX' })])),
}));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('SCAN_IDENTITY_CONFLICT'));

const contradictoryCheckDir = path.join(root, 'contradictory-check-data');
fs.mkdirSync(contradictoryCheckDir, { recursive: true });
fs.writeFileSync(
  path.join(contradictoryCheckDir, 'check_ACB_20260809_360.json'),
  JSON.stringify(checkPayload({ exchange: 'HNX' })),
);
record = one(run({ checkDataRoot: contradictoryCheckDir }));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('CHECK_IDENTITY_CONFLICT'));

const aliasCheckDir = path.join(root, 'alias-check-data');
fs.mkdirSync(aliasCheckDir, { recursive: true });
fs.writeFileSync(
  path.join(aliasCheckDir, 'check_ACB_20260809_360.json'),
  JSON.stringify(checkPayload({ ticker: 'HOSE:ACB', exchange: 'HSX' })),
);
record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ ticker: 'HSX:ACB', exchange: 'HOSE' })])),
  checkDataRoot: aliasCheckDir,
}));
assert.equal(record.status, 'CHECK_NOW');
assert.equal(record.ticker, 'HOSE:ACB');
assert.deepEqual(record.blockers, []);

const duplicateDir = path.join(root, 'duplicate-data');
fs.mkdirSync(duplicateDir, { recursive: true });
fs.writeFileSync(path.join(duplicateDir, 'check_ACB_20260809_360.json'), JSON.stringify(checkPayload()));
fs.writeFileSync(path.join(duplicateDir, 'check_ACB_20260808_360.json'), JSON.stringify(checkPayload({ as_of: '2026-08-09T09:00:30.000Z' })));
record = one(run({ checkDataRoot: duplicateDir }));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('CHECK_DUPLICATE'));

const identicalDuplicateDir = path.join(root, 'identical-duplicate-data');
fs.mkdirSync(identicalDuplicateDir, { recursive: true });
const identicalPayload = JSON.stringify(checkPayload());
fs.writeFileSync(path.join(identicalDuplicateDir, 'check_ACB_20260809_360.json'), identicalPayload);
fs.writeFileSync(path.join(identicalDuplicateDir, 'check_ACB_360_latest.json'), identicalPayload);
record = one(run({ checkDataRoot: identicalDuplicateDir }));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('CHECK_DUPLICATE'));

const malformedDir = path.join(root, 'malformed-data');
fs.mkdirSync(malformedDir, { recursive: true });
fs.writeFileSync(path.join(malformedDir, 'check_ACB_20260809_360.json'), '{');
record = one(run({ checkDataRoot: malformedDir }));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('CHECK_MALFORMED'));

// A5/A7: only explicit canonical negative evidence excludes; freshness is inclusive at threshold.
for (const [offset, expected] of [[999, 'CHECK_NOW'], [1000, 'CHECK_NOW'], [1001, 'BLOCKED']]) {
  const stamp = new Date(Date.parse(now) - offset).toISOString();
  const dir = path.join(root, `fresh-${offset}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'check_ACB_20260809_360.json'), JSON.stringify(checkPayload({ generated_at: stamp, as_of: stamp })));
  record = one(run({
    scanLatestPath: writeScan(scanArtifact([scanRecord()], { generated_at: stamp })),
    checkDataRoot: dir,
    freshnessMs: 1000,
  }));
  assert.equal(record.status, expected, `freshness ${offset}`);
  if (expected === 'BLOCKED') assert.ok(record.blockers.includes('CHECK_STALE'));
}

for (const [offset, expected] of [[999, 'CHECK_NOW'], [1000, 'CHECK_NOW'], [1001, 'BLOCKED']]) {
  const stamp = new Date(Date.parse(now) - offset).toISOString();
  const dir = path.join(root, `scan-fresh-${offset}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'check_ACB_20260809_360.json'),
    JSON.stringify(checkPayload({ generated_at: now, as_of: now })),
  );
  record = one(run({
    scanLatestPath: writeScan(scanArtifact([scanRecord()], { generated_at: stamp })),
    checkDataRoot: dir,
    freshnessMs: 1000,
  }));
  assert.equal(record.status, expected, `scan freshness ${offset}`);
  if (expected === 'BLOCKED') assert.ok(record.blockers.includes('SCAN_STALE'));
}

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord()], { generated_at: '2026-08-09T09:10:00.001Z' })),
}));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('SCAN_FUTURE'));

record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ missing_fields: ['volume'] })])),
}));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('SCAN_MISSING_EVIDENCE'));
record = one(run({
  scanLatestPath: writeScan(scanArtifact([scanRecord({ signal: 'UNKNOWN' })])),
}));
assert.equal(record.status, 'BLOCKED');
assert.ok(record.blockers.includes('SCAN_SIGNAL_UNPROVEN'));

// A6: derived output never contains execution-status words.
assert.equal(hasForbidden(batch), false);
assert.equal(hasForbidden(record), false);

// A8: write only the isolated output and preserve input bytes + mtimes, including journal.db when present.
const sourcePath = writeScan(scanArtifact());
const checkPath = writeCheck(checkPayload());
const tracked = [sourcePath, checkPath, path.join(here, 'journal.db')].filter(fs.existsSync);
const before = new Map(tracked.map(file => [file, {
  bytes: fs.readFileSync(file),
  mtime: fs.statSync(file).mtimeMs,
}]));
const isolated = triageScanCheck({
  scanLatestPath: sourcePath,
  checkDataRoot: dataRoot,
  outputPath,
  now,
  freshnessMs: 60 * 60 * 1000,
});
assert.equal(fs.existsSync(outputPath), true);
assert.equal(hasForbidden(isolated), false);
for (const [file, snapshot] of before) {
  assert.deepEqual(fs.readFileSync(file), snapshot.bytes, `${file} bytes changed`);
  assert.equal(fs.statSync(file).mtimeMs, snapshot.mtime, `${file} mtime changed`);
}
assert.equal(path.resolve(outputPath) === path.resolve(sourcePath), false);
const cliOut = path.join(root, 'cli', 'triage.json');
const cli = spawnSync(process.execPath, [path.join(here, 'scan_check_triage.mjs')], {
  cwd: here,
  encoding: 'utf8',
  env: {
    ...process.env,
    SCAN_LATEST_PATH: sourcePath,
    CHECK_DATA_ROOT: dataRoot,
    TRIAGE_OUTPUT_PATH: cliOut,
    TRIAGE_NOW: now,
    TRIAGE_FRESHNESS_MS: '3600000',
  },
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(fs.existsSync(cliOut), true);
assert.equal(hasForbidden(JSON.parse(fs.readFileSync(cliOut, 'utf8'))), false);

console.log('ALL PASS');
