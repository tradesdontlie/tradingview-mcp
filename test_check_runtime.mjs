import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, atomicWriteCache, cachePaths, evidenceHash, releaseLock, runtimeDataRoot } from './src/core/check_runtime.mjs';
import { buildCacheEnvelope, restoreChartState, withChartLifecycle } from './check_one.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-runtime-'));
const lock = acquireLock(root, 'HOSE:AAA', '360', 1_000);
assert.throws(() => acquireLock(root, 'HOSE:AAA', '360', 1_000), /LOCK_CONTENDED/);
releaseLock(lock);
const stale = path.join(root, 'locks', 'HOSE_AAA_360.lock');
fs.mkdirSync(path.dirname(stale), { recursive: true });
fs.writeFileSync(stale, JSON.stringify({ created_at: 0 }));
assert.doesNotThrow(() => releaseLock(acquireLock(root, 'HOSE:AAA', '360', 1)));
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
await assert.rejects(() => withChartLifecycle(root, async () => { order.push('mutation'); throw new Error('boom'); }), /boom/);
assert.deepEqual(order, ['mutation']);
assert.doesNotThrow(() => acquireLock(root, 'OTHER', '60', 1_000));
console.log('ALL PASS');
