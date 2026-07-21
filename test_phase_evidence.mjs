import assert from 'node:assert/strict';
import { phaseEvidence } from './check_one.mjs';

const breakout = phaseEvidence({ volRatio: 1.5, closePos: 50, conf: 60, buyPct: 55, buyStack: 1, churn: false, resistance: 99, price: 100, wideDownCloseLow: false, cumDelta: 10, previousCumDelta: -5 });
assert.deepEqual(breakout.breakout, {
  closed_above: true, volume_ratio: 1.5, close_position_pct: 50,
  footprint_confidence: 60, buy_pct: 55, buy_stack: 1, churn: false,
});
assert.equal(breakout.retest.supply_dry, false);
assert.equal(breakout.retest.micro_confirm, true);
assert.equal(breakout.range.absorption, true);
assert.equal(breakout.range.delta_flip, true);

const retest = phaseEvidence({ volRatio: 0.8, closePos: 60, conf: 50, buyPct: 40, buyStack: 0, churn: false, resistance: 101, price: 98, wideDownCloseLow: false, cumDelta: 4, previousCumDelta: null });
assert.equal(retest.retest.supply_dry, true);
assert.equal(retest.retest.micro_confirm, false);
assert.equal(retest.range.delta_flip, null);

const unknown = phaseEvidence({ volRatio: null, closePos: 60, conf: 60, buyPct: 55, buyStack: 1, churn: false, resistance: 99, price: 100, wideDownCloseLow: false, cumDelta: null, previousCumDelta: null });
assert.equal(unknown.breakout.volume_ratio, null);
assert.equal(unknown.range.absorption, null);
assert.equal(unknown.range.delta_flip, null);
console.log('ALL PASS');
