import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, atomicWriteCache, cachePaths, evidenceHash, releaseLock, runtimeDataRoot } from './src/core/check_runtime.mjs';
import { buildCacheEnvelope, restoreChartState, withChartLifecycle } from './check_one.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-runtime-'));
const lockPath = path.join(root, 'locks', 'tradingview-chart.lock');
const fixedNow = 1_000_000;
const lockOptions = { now: () => fixedNow, pid: 4321, isPidAlive: () => true };
const lock = acquireLock(root, 'HOSE:AAA', '360', 1_000, lockOptions);
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), {
  pid: 4321, created_at: fixedNow, ticker: 'HOSE:AAA', timeframe: '360',
});
assert.throws(
  () => acquireLock(root, 'HOSE:BBB', '60', 1_000, lockOptions),
  /LOCK_CONTENDED:TRADINGVIEW_CHART/,
);
releaseLock(lock);
assert.ok(!fs.existsSync(lockPath));

fs.mkdirSync(path.dirname(lockPath), { recursive: true });
fs.writeFileSync(lockPath, JSON.stringify({
  pid: 4321, created_at: 0, ticker: 'HOSE:AAA', timeframe: '360',
}));
assert.throws(
  () => acquireLock(root, 'HOSE:BBB', '60', 1, lockOptions),
  /LOCK_CONTENDED:TRADINGVIEW_CHART/,
);
assert.ok(fs.existsSync(lockPath));

fs.writeFileSync(lockPath, JSON.stringify({
  pid: 9876, created_at: 0, ticker: 'HOSE:AAA', timeframe: '360',
}));
const reclaimed = acquireLock(root, 'HOSE:BBB', '60', 1, {
  now: () => fixedNow, pid: 4321, isPidAlive: pid => pid === 4321,
});
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), {
  pid: 4321, created_at: fixedNow, ticker: 'HOSE:BBB', timeframe: '60',
});
releaseLock(reclaimed);

fs.writeFileSync(lockPath, JSON.stringify({
  pid: 9876, created_at: 0, ticker: 'HOSE:AAA', timeframe: '360',
}));
assert.throws(
  () => acquireLock(root, 'HOSE:BBB', '60', 1, {
    now: () => fixedNow, pid: 4321, isPidAlive: () => undefined,
  }),
  /LOCK_PID_CHECK_FAILED:TRADINGVIEW_CHART/,
);
assert.ok(fs.existsSync(lockPath));

fs.writeFileSync(lockPath, JSON.stringify({ created_at: 0, ticker: 'HOSE:AAA', timeframe: '360' }));
assert.throws(
  () => acquireLock(root, 'HOSE:BBB', '60', 1, lockOptions),
  /LOCK_INVALID_METADATA:TRADINGVIEW_CHART/,
);
assert.ok(fs.existsSync(lockPath));
fs.writeFileSync(lockPath, '{malformed');
assert.throws(
  () => acquireLock(root, 'HOSE:BBB', '60', 1, lockOptions),
  /LOCK_INVALID_METADATA:TRADINGVIEW_CHART/,
);
assert.ok(fs.existsSync(lockPath));
fs.unlinkSync(lockPath);
const h6 = cachePaths(root, 'HOSE:AAA', '360');
const h1 = cachePaths(root, 'HOSE:AAA', '60');
atomicWriteCache(h6, { ticker: 'HOSE:AAA', timeframe: '360' });
atomicWriteCache(h1, { ticker: 'HOSE:AAA', timeframe: '60' });
assert.notEqual(h6.latest, h1.latest);
assert.equal(JSON.parse(fs.readFileSync(h6.latest)).timeframe, '360');
assert.ok(fs.existsSync(path.join(root, 'check_HOSE_AAA_latest.json')));
assert.ok(!fs.existsSync(path.join(root, 'check_HOSE_AAA_60_latest.json')) === false);
assert.throws(() => runtimeDataRoot({ sourceRoot: 'C:/repo/.worktrees/feature' }), /CHECK_DATA_ROOT/);
assert.equal(runtimeDataRoot({ dataRoot: root, sourceRoot: 'C:/repo/.worktrees/feature' }), path.resolve(root));
assert.equal(evidenceHash({ text: 'VN', nested: { b: true }, value: 1 }), '3a28da6c2850a8698bd3f610b4736a584f6a9fa1b158efb8e19ac60aae08e261');
const envelope = buildCacheEnvelope({ ticker: 'HOSE:AAA', timeframe: '360', date: '2026-07-21' }, '2026-07-21T09:15:00.000Z');
assert.equal(envelope.schema_version, 1);
assert.equal(envelope.market_date, '2026-07-21');
assert.equal(envelope.generated_at, '2026-07-21T09:15:00.000Z');
assert.equal(envelope.as_of, envelope.generated_at);
assert.equal(envelope.date, envelope.market_date);

const chartCalls = [];
const fakeChart = {
  async setSymbol({ symbol }) { chartCalls.push(['symbol', symbol]); },
  async setTimeframe({ timeframe }) { chartCalls.push(['timeframe', timeframe]); },
};
await restoreChartState(fakeChart, { symbol: 'HOSE:VNINDEX', resolution: 'D' });
assert.deepEqual(chartCalls, [['symbol', 'HOSE:VNINDEX'], ['timeframe', 'D']]);
const order = [];
let lifecycleOwner;
await assert.rejects(() => withChartLifecycle(root, 'HNX:SHS', '60', async () => {
  lifecycleOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  order.push('mutation');
  throw new Error('boom');
}), /boom/);
assert.deepEqual(order, ['mutation']);
assert.equal(lifecycleOwner.ticker, 'HNX:SHS');
assert.equal(lifecycleOwner.timeframe, '60');
assert.ok(!fs.existsSync(lockPath));
assert.doesNotThrow(() => acquireLock(root, 'OTHER', '60', 1_000));
console.log('ALL PASS');
