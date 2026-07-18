import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findKeywordBias, findSequenceBias } from '../src/core/bias.js';

describe('findKeywordBias', () => {
  it('detects explicit bullish text', () => {
    const r = findKeywordBias([{ text: 'Bias: Bullish', price: 4100 }]);
    assert.equal(r.bias, 'bullish');
    assert.equal(r.evidence.type, 'keyword');
  });

  it('detects explicit bearish text', () => {
    const r = findKeywordBias([{ text: 'Bias Short', price: 4100 }]);
    assert.equal(r.bias, 'bearish');
  });

  it('prefers the most recent match when x is present', () => {
    const r = findKeywordBias([
      { text: 'Bias Long', price: 4000, x: 1 },
      { text: 'Bias Short', price: 4100, x: 2 },
    ]);
    assert.equal(r.bias, 'bearish');
    assert.equal(r.evidence.price, 4100);
  });

  it('returns null for sweep/CSD-only text (no keyword)', () => {
    const r = findKeywordBias([{ text: 'sweep', price: 4140 }, { text: 'CSD', price: 4105 }]);
    assert.equal(r, null);
  });
});

describe('findSequenceBias', () => {
  it('CSD below sweep price => bearish', () => {
    const labels = [
      { text: 'sweep', price: 4140.39, x: 100 },
      { text: 'CSD', price: 4105.43, x: 110 },
    ];
    const r = findSequenceBias(labels);
    assert.equal(r.bias, 'bearish');
    assert.equal(r.evidence.sweep.price, 4140.39);
    assert.equal(r.evidence.confirmation.price, 4105.43);
    assert.equal(r.evidence.orderingSource, 'x');
  });

  it('CSD above sweep price => bullish', () => {
    const labels = [
      { text: 'sweep', price: 4093.86, x: 100 },
      { text: 'CSD', price: 4136.61, x: 110 },
    ];
    const r = findSequenceBias(labels);
    assert.equal(r.bias, 'bullish');
  });

  it('pairs CSD with the NEAREST prior sweep, not the earliest', () => {
    const labels = [
      { text: 'sweep', price: 4200, x: 1 },   // earliest sweep (should be ignored)
      { text: 'sweep', price: 4150, x: 2 },   // nearest prior sweep (should be paired)
      { text: 'CSD', price: 4160, x: 3 },
    ];
    const r = findSequenceBias(labels);
    assert.equal(r.evidence.sweep.price, 4150);
    assert.equal(r.bias, 'bullish'); // 4160 > 4150
  });

  it('falls back to array order (orderingSource=array_order) when x is absent', () => {
    const labels = [
      { text: 'sweep', price: 4140.39 },
      { text: 'CSD', price: 4105.43 },
    ];
    const r = findSequenceBias(labels);
    assert.equal(r.evidence.orderingSource, 'array_order');
    assert.equal(r.bias, 'bearish');
  });

  it('returns null when no sweep precedes a confirmation event', () => {
    const labels = [{ text: 'CSD', price: 4105.43, x: 1 }];
    const r = findSequenceBias(labels);
    assert.equal(r, null);
  });

  it('returns null when there are no events at all', () => {
    assert.equal(findSequenceBias([]), null);
  });
});
