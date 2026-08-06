// Self-check computeDecision. Chay: node test_decision.mjs
import assert from 'node:assert';
import { computeDecision } from './check_one.mjs';

// AVOID khi khong co scenario
assert.equal(computeDecision([], 100).state, 'AVOID');
assert.equal(computeDecision(null, 100).state, 'AVOID');

// READY khi gia trong entry zone (retest co vung)
const retest = { label: 'retest', entry_low: 95, entry_high: 105 };
assert.equal(computeDecision([retest], 100).state, 'READY');
assert.equal(computeDecision([retest], 100).setup, 'retest');

// WATCH khi co setup nhung gia ngoai zone
assert.equal(computeDecision([retest], 120).state, 'WATCH');

// Breakout (entry_low===entry_high) -> WATCH tru khi gia dung level (can dong nen xac nhan)
const brk = { label: 'breakout', entry_low: 110, entry_high: 110 };
assert.equal(computeDecision([brk], 108).state, 'WATCH');

console.log('PASS test_decision');
