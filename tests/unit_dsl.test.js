// Signal DSL evaluator unit tests — offline, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRule, validateRule } from '../src/core/signals/dsl.js';
import { RingBuffer } from '../src/core/streaming/ring.js';

function ringWithPrices(prices) {
  const r = new RingBuffer(prices.length + 10);
  for (const p of prices) r.push({ price: p, ts: Date.now() });
  return r;
}

test('evaluateRule — close < const fires when last price below', () => {
  const ring = ringWithPrices([100, 99, 80]);
  const rule = {
    name: 't', sub_id: 's',
    conditions: [{ left: { metric: 'close' }, op: '<', right: { const: 90 } }],
  };
  assert.equal(evaluateRule(rule, ring).matched, true);
});

test('evaluateRule — close > const does NOT fire when last below', () => {
  const ring = ringWithPrices([100, 99, 80]);
  const rule = {
    name: 't', sub_id: 's',
    conditions: [{ left: { metric: 'close' }, op: '>', right: { const: 90 } }],
  };
  assert.equal(evaluateRule(rule, ring).matched, false);
});

test('evaluateRule — RSI threshold (need enough samples)', () => {
  // Steadily rising prices → RSI high. We need >= period + 1 samples.
  const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
  const ring = ringWithPrices(prices);
  const rule = {
    name: 't', sub_id: 's',
    conditions: [{ left: { metric: 'rsi', period: 14 }, op: '>', right: { const: 50 } }],
  };
  assert.equal(evaluateRule(rule, ring).matched, true);
});

test('evaluateRule — require:any vs require:all', () => {
  const ring = ringWithPrices([100, 99, 80]);
  const ruleAny = {
    name: 't', sub_id: 's', require: 'any',
    conditions: [
      { left: { metric: 'close' }, op: '<', right: { const: 90 } },
      { left: { metric: 'close' }, op: '>', right: { const: 200 } },
    ],
  };
  const ruleAll = { ...ruleAny, require: 'all' };
  assert.equal(evaluateRule(ruleAny, ring).matched, true);
  assert.equal(evaluateRule(ruleAll, ring).matched, false);
});

test('validateRule — flags missing fields + bad op', () => {
  assert.deepEqual(validateRule({}).sort(), [
    'missing conditions[]', 'missing name', 'missing sub_id',
  ].sort());
  const errs = validateRule({
    name: 't', sub_id: 's',
    conditions: [{ left: { metric: 'close' }, op: '=', right: { const: 1 } }],
  });
  assert.ok(errs.includes('unknown op ='));
});

test('evaluateRule — non-matching metric returns false (no throw)', () => {
  const ring = ringWithPrices([100]);
  const rule = {
    name: 't', sub_id: 's',
    conditions: [{ left: { metric: 'unknown' }, op: '<', right: { const: 1 } }],
  };
  const res = evaluateRule(rule, ring);
  assert.equal(res.matched, false);
});
