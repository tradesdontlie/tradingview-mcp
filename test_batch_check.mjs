import assert from 'node:assert/strict';
import { buildResults } from './batch_check.mjs';

const line = payload => 'DATA_JSON:' + JSON.stringify(payload);
const stdout = [
  line({ ticker: 'HOSE:AAA', price: 100 }),
  'BATCH_ERROR HOSE:BBB: SYMBOL_UNCONFIRMED:HOSE:BBB',
  line({ ticker: 'HOSE:CCC', price: 200 }),
].join('\n');
const results = buildResults(['AAA', 'BBB', 'CCC'], stdout, '12.3');
assert.equal(results.length, 3);
assert.equal(results[0].success, true);
assert.equal(results[0].json.price, 100);
assert.equal(results[1].success, false, 'failed ticker must not receive the next payload');
assert.equal(results[1].ticker, 'BBB');
assert.match(results[1].error, /SYMBOL_UNCONFIRMED/);
assert.equal(results[2].success, true);
assert.equal(results[2].json.price, 200);
assert.equal(results[0].elapsed, '12.3');

const missing = buildResults(['AAA', 'ZZZ'], line({ ticker: 'HOSE:AAA', price: 100 }), '1.0');
assert.equal(missing[0].success, true);
assert.equal(missing[1].success, false);
assert.equal(missing[1].error, 'no DATA_JSON output');

// Importing this module must not execute the batch entrypoint (IS_DIRECT guard).
console.log('ALL PASS');
