import assert from 'node:assert/strict';
import { canonicalBarKey, evidenceHash, MONITOR_SCHEMA_VERSION, validateIdentity, withLease, resetLeaseForTests } from './src/monitor/index.js';
const id = { provider: 'tv', exchange: 'HOSE', symbol: 'AAA', full_symbol: 'HOSE:AAA', timeframe: '60', pane: 'p', layout: 'l', profile: 'vn-stock.v1' };
assert.equal(MONITOR_SCHEMA_VERSION, 'monitor.v1'); assert.equal(validateIdentity(id).full_symbol, 'HOSE:AAA');
assert.equal(canonicalBarKey({ identity: id, timeframe: '60', session: 'VN', bar_open_timestamp: 1, bar_index: 2 }).split('|').length, 5);
assert.equal(evidenceHash([{ family: 'levels', source_id: 'x', bar_key: 'b' }]), evidenceHash([{ bar_key: 'b', source_id: 'x', family: 'levels' }]));
assert.throws(() => validateIdentity({}), /IDENTITY_MISSING/); console.log('ALL PASS');
let release; const delayed = new Promise(resolve => { release = resolve; }); setTimeout(() => release({ identity: id }), 20); const timed = withLease({ expectedIdentity: id, timeoutMs: 5, readIdentity: async () => id, readSnapshot: async () => delayed }); const overlap = withLease({ expectedIdentity: id, timeoutMs: 5, readIdentity: async () => id, readSnapshot: async () => ({ identity: id }) }); await assert.rejects(overlap, /LEASE_CONCURRENT/); await assert.rejects(timed, /LEASE_TIMEOUT/); resetLeaseForTests();
