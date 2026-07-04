/**
 * Tests for Volume Profile bias filters in core/volume_profile.js.
 * Pure functions over OHLC+volume bar arrays — no live chart/exchange connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSessionVWAP,
  classifyVWAPBias,
  calculateValueArea,
  classifyValueAreaBias,
} from '../src/core/volume_profile.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function vwapBar({ day, price, volume }) {
  return { open_time: day * MS_PER_DAY, high: price, low: price, close: price, volume };
}

describe('calculateSessionVWAP()', () => {
  it('computes a cumulative volume-weighted typical price within a session', () => {
    // bar1: typicalPrice=10, volume=2 -> vwap=10
    // bar2: typicalPrice=20, volume=2 -> cumPV=20+40=60, cumVol=4 -> vwap=15
    const bars = [
      vwapBar({ day: 0, price: 10, volume: 2 }),
      vwapBar({ day: 0, price: 20, volume: 2 }),
    ];
    const vwap = calculateSessionVWAP(bars);
    assert.equal(vwap[0], 10);
    assert.equal(vwap[1], 15);
  });

  it('resets the cumulative sums at each UTC day boundary', () => {
    const bars = [
      vwapBar({ day: 0, price: 10, volume: 2 }),
      vwapBar({ day: 0, price: 20, volume: 2 }),
      vwapBar({ day: 1, price: 100, volume: 1 }), // new session — resets, doesn't blend with day 0
    ];
    const vwap = calculateSessionVWAP(bars);
    assert.equal(vwap[2], 100);
  });
});

describe('classifyVWAPBias()', () => {
  it('returns bias=long (Ch.17: "above VWAP, don\'t short") when the latest close is above VWAP', () => {
    const bars = [
      vwapBar({ day: 0, price: 10, volume: 2 }),
      vwapBar({ day: 0, price: 20, volume: 2 }), // vwap=15, close=20 > 15
    ];
    const result = classifyVWAPBias(bars);
    assert.equal(result.bias, 'long');
    assert.equal(result.vwap, 15);
    assert.equal(result.close, 20);
  });

  it('returns bias=short (Ch.17: "below VWAP, don\'t long") when the latest close is below VWAP', () => {
    const bars = [
      vwapBar({ day: 0, price: 20, volume: 2 }),
      vwapBar({ day: 0, price: 10, volume: 2 }), // vwap=15, close=10 < 15
    ];
    const result = classifyVWAPBias(bars);
    assert.equal(result.bias, 'short');
  });

  it('returns bias=null when the latest close exactly equals VWAP', () => {
    const bars = [vwapBar({ day: 0, price: 10, volume: 1 })]; // vwap=10, close=10
    const result = classifyVWAPBias(bars);
    assert.equal(result.bias, null);
  });
});

describe('calculateValueArea()', () => {
  // closes 0..8 (range 8, bins=9 -> binSize=8/9). volumes [1,1,1,1,10,1,1,1,1]
  // -> POC bin is index 4 (close=4, volume=10). Value area (70% of total=18,
  // target=12.6) expands from 10 -> 11 (bin5) -> 12 (bin6) -> 13 (bin7), tying
  // ties broken toward the higher-price side.
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((close, i) => ({
    close,
    volume: i === 4 ? 10 : 1,
  }));

  it('finds the POC and expands the Value Area until it covers valueAreaPercent of total volume', () => {
    const { poc, vah, val, totalVolume } = calculateValueArea(bars, { bins: 9, valueAreaPercent: 70 });
    assert.equal(totalVolume, 18);
    assert.ok(Math.abs(poc - 4) < 1e-9, `poc ~4, got ${poc}`);
    assert.ok(Math.abs(vah - 64 / 9) < 1e-9, `vah ~${64 / 9}, got ${vah}`);
    assert.ok(Math.abs(val - 32 / 9) < 1e-9, `val ~${32 / 9}, got ${val}`);
  });

  it('returns a degenerate profile (poc=vah=val=close) when every bar has the same close', () => {
    const flat = [10, 10, 10].map(close => ({ close, volume: 5 }));
    const { poc, vah, val } = calculateValueArea(flat);
    assert.equal(poc, 10);
    assert.equal(vah, 10);
    assert.equal(val, 10);
  });

  it('rejects a non-positive-integer bins', () => {
    assert.throws(() => calculateValueArea(bars, { bins: 0 }), /bins must be a positive integer/);
  });

  it('rejects an out-of-range valueAreaPercent', () => {
    assert.throws(() => calculateValueArea(bars, { valueAreaPercent: 0 }), /valueAreaPercent must be between/);
    assert.throws(() => calculateValueArea(bars, { valueAreaPercent: 101 }), /valueAreaPercent must be between/);
  });
});

describe('classifyValueAreaBias()', () => {
  it('returns bias=short (Ch.14: "Above VaH, look for shorts") when the latest close is above VaH', () => {
    // Same profile as above: vah ~ 7.111. Last bar's close=8 > vah.
    const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((close, i) => ({ close, volume: i === 4 ? 10 : 1 }));
    const result = classifyValueAreaBias(bars, { bins: 9, valueAreaPercent: 70 });
    assert.equal(result.position, 'above');
    assert.equal(result.bias, 'short');
  });

  it('returns bias=long (Ch.14: "Below VaL, look for longs") when the latest close is below VaL', () => {
    // Same (close,volume) pairs as the POC test, reordered -> same profile (val ~ 32/9 ~ 3.556).
    // Last bar's close=0 < val.
    const bars = [8, 7, 6, 5, 4, 3, 2, 1, 0].map((close, i) => ({ close, volume: i === 4 ? 10 : 1 }));
    const result = classifyValueAreaBias(bars, { bins: 9, valueAreaPercent: 70 });
    assert.equal(result.position, 'below');
    assert.equal(result.bias, 'long');
  });

  it('returns bias=null when the latest close is inside the Value Area', () => {
    // POC bar itself (close=4) is always inside [val, vah].
    const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 4].map((close, i) => ({ close, volume: i < 9 && i === 4 ? 10 : 1 }));
    const result = classifyValueAreaBias(bars, { bins: 9, valueAreaPercent: 70 });
    assert.equal(result.position, 'inside');
    assert.equal(result.bias, null);
  });
});
