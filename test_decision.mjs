import assert from 'node:assert/strict';
import { computeDecision } from './check_one.mjs';

const scenario = { label: 'retest', entry_low: 100, entry_high: 110 };

assert.equal(computeDecision([], 105).setup_state, 'NO_SETUP');
assert.equal(computeDecision([scenario], 95).setup_state, 'NEAR_ZONE');
const inZone = computeDecision([scenario], 105);
assert.equal(inZone.setup_state, 'IN_ZONE');
assert.notEqual(inZone.setup_state, 'READY');
console.log('ALL PASS');
