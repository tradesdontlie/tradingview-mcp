import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTimeframe } from '../src/tools/chart.js';

describe('normalizeTimeframe', () => {
  it('keeps minute resolutions as TradingView minute counts', () => {
    assert.equal(normalizeTimeframe('5'), '5');
    assert.equal(normalizeTimeframe('5m'), '5');
    assert.equal(normalizeTimeframe('15 minutes'), '15');
  });

  it('converts hour aliases to TradingView minute counts', () => {
    assert.equal(normalizeTimeframe('1h'), '60');
    assert.equal(normalizeTimeframe('4H'), '240');
    assert.equal(normalizeTimeframe('2 hours'), '120');
  });

  it('normalizes daily, weekly, and monthly periods', () => {
    assert.equal(normalizeTimeframe('D'), 'D');
    assert.equal(normalizeTimeframe('1D'), 'D');
    assert.equal(normalizeTimeframe('2D'), '2D');
    assert.equal(normalizeTimeframe('W'), 'W');
    assert.equal(normalizeTimeframe('1W'), 'W');
    assert.equal(normalizeTimeframe('M'), 'M');
    assert.equal(normalizeTimeframe('1M'), 'M');
    assert.equal(normalizeTimeframe('3 months'), '3M');
  });

  it('rejects missing or unsupported resolutions with useful errors', () => {
    assert.throws(() => normalizeTimeframe(undefined), /timeframe is required/);
    assert.throws(() => normalizeTimeframe(''), /timeframe cannot be empty/);
    assert.throws(() => normalizeTimeframe('quarterly'), /Unsupported timeframe/);
  });
});
