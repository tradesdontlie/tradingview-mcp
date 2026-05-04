/**
 * Offline unit tests for the Pine v5 parser.
 * Run with: node --test tests/parser.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser/index.js';

// ── Example 1: EMA Crossover ───────────────────────────────────────────────

const EMA_CROSS = `
//@version=5
strategy("EMA Cross", overlay=true, initial_capital=10000)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
`;

describe('Example 1 — EMA Crossover', () => {
  const result = parse(EMA_CROSS);

  test('script type is strategy', () => {
    assert.equal(result.scriptType, 'strategy');
  });

  test('name is EMA Cross', () => {
    assert.equal(result.name, 'EMA Cross');
  });

  test('has exactly 2 Indicator blocks', () => {
    const indicators = result.blocks.filter(b => b.type === 'Indicator');
    assert.equal(indicators.length, 2);
  });

  test('fast indicator is ta.ema with close and 9', () => {
    const fast = result.blocks.find(b => b.type === 'Indicator' && b.variableName === 'fast');
    assert.ok(fast, 'fast indicator should exist');
    assert.equal(fast.function, 'ta.ema');
    assert.ok(fast.args.includes('close'));
    assert.ok(fast.args.includes('9'));
  });

  test('slow indicator is ta.ema with close and 21', () => {
    const slow = result.blocks.find(b => b.type === 'Indicator' && b.variableName === 'slow');
    assert.ok(slow, 'slow indicator should exist');
    assert.equal(slow.function, 'ta.ema');
    assert.ok(slow.args.includes('21'));
  });

  test('has one Entry block with side long', () => {
    const entries = result.blocks.filter(b => b.type === 'Entry');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].side, 'long');
    assert.equal(entries[0].label, 'Long');
  });

  test('entry condition contains crossover', () => {
    const entry = result.blocks.find(b => b.type === 'Entry');
    assert.ok(entry?.conditionRaw?.includes('crossover'));
  });

  test('has one Exit block for Long', () => {
    const exits = result.blocks.filter(b => b.type === 'Exit');
    assert.equal(exits.length, 1);
  });
});

// ── Example 2: RSI Mean Reversion with ATR Sizing ─────────────────────────

const RSI_REVERSION = `
//@version=5
strategy("RSI Reversion", overlay=false, initial_capital=10000)
rsi = ta.rsi(close, 14)
atr14 = ta.atr(14)
in_session = (hour >= 9) and (hour < 16)
qty = math.floor(strategy.equity * 0.02 / (close * atr14))
if rsi < 30 and in_session
    strategy.entry("Long", strategy.long, qty=qty)
if rsi > 70 and in_session
    strategy.entry("Short", strategy.short, qty=qty)
strategy.exit("Long TP/SL", "Long", stop=close - 2*atr14, limit=close + 3*atr14)
strategy.exit("Short TP/SL", "Short", stop=close + 2*atr14, limit=close - 3*atr14)
`;

describe('Example 2 — RSI Mean Reversion', () => {
  const result = parse(RSI_REVERSION);

  test('has rsi and atr14 indicator blocks', () => {
    const indicators = result.blocks.filter(b => b.type === 'Indicator');
    const names = indicators.map(b => b.variableName);
    assert.ok(names.includes('rsi'), 'should have rsi');
    assert.ok(names.includes('atr14'), 'should have atr14');
  });

  test('in_session is a Filter block', () => {
    const filters = result.blocks.filter(b => b.type === 'Filter');
    assert.ok(filters.length > 0, 'should have filter blocks');
    const session = filters.find(b => b.variableName === 'in_session');
    assert.ok(session, 'in_session should be a filter');
  });

  test('qty is a Sizing block with atr_based method', () => {
    const sizing = result.blocks.find(b => b.type === 'Sizing' && b.label === 'qty');
    assert.ok(sizing, 'qty sizing block should exist');
    assert.equal(sizing.method, 'atr_based');
  });

  test('has two Entry blocks (long and short)', () => {
    const entries = result.blocks.filter(b => b.type === 'Entry');
    assert.equal(entries.length, 2);
    const sides = entries.map(e => e.side);
    assert.ok(sides.includes('long'));
    assert.ok(sides.includes('short'));
  });

  test('has two Exit blocks with stop and limit', () => {
    const exits = result.blocks.filter(b => b.type === 'Exit');
    assert.equal(exits.length, 2);
    exits.forEach(e => {
      assert.ok(e.stopExpr, 'should have stop expression');
      assert.ok(e.limitExpr, 'should have limit expression');
    });
  });

  test('Long entry has rsi condition', () => {
    const longEntry = result.blocks.find(b => b.type === 'Entry' && b.side === 'long');
    assert.ok(longEntry?.conditionRaw?.includes('rsi'));
  });
});

// ── Example 3: Multi-Filter Breakout ─────────────────────────────────────

const BREAKOUT = `
//@version=5
strategy("Breakout + Regime", overlay=true)
ema200  = ta.ema(close, 200)
atr     = ta.atr(14)
adx_val = ta.dmi(14, 14).adx
hh20    = ta.highest(high, 20)
trend_ok  = close > ema200
trending  = adx_val > 25
breakout  = close > hh20[1]
if trend_ok and trending and breakout
    strategy.entry("BO Long", strategy.long)
strategy.exit("BO Long Exit", "BO Long", stop=close - 2 * atr, trail_price=close + 3 * atr, trail_offset=atr)
`;

describe('Example 3 — Multi-Filter Breakout', () => {
  const result = parse(BREAKOUT);

  test('has 4 indicator blocks', () => {
    const indicators = result.blocks.filter(b => b.type === 'Indicator');
    assert.ok(indicators.length >= 3, `expected ≥ 3 indicators, got ${indicators.length}`);
  });

  test('has filter blocks for trend_ok, trending, breakout', () => {
    const filters = result.blocks.filter(b => b.type === 'Filter');
    const names = filters.map(b => b.variableName);
    assert.ok(names.includes('trend_ok') || names.includes('trending') || names.includes('breakout'),
      `expected at least one filter variable, got ${JSON.stringify(names)}`);
  });

  test('has one Entry block for BO Long', () => {
    const entries = result.blocks.filter(b => b.type === 'Entry');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].label, 'BO Long');
    assert.equal(entries[0].side, 'long');
  });

  test('entry condition contains all three filter variables', () => {
    const entry = result.blocks.find(b => b.type === 'Entry');
    const cond = entry?.conditionRaw ?? '';
    assert.ok(cond.includes('trend_ok'), 'condition should include trend_ok');
    assert.ok(cond.includes('trending'), 'condition should include trending');
    assert.ok(cond.includes('breakout'), 'condition should include breakout');
  });

  test('has one Exit block with stop and trail', () => {
    const exits = result.blocks.filter(b => b.type === 'Exit');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].fromEntry, 'BO Long');
    assert.ok(exits[0].stopExpr, 'should have stop expression');
    assert.ok(exits[0].trailExpr, 'should have trail expression');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('empty source returns empty blocks', () => {
    const r = parse('');
    assert.equal(r.blocks.length, 0);
  });

  test('indicator-only script has no Entry blocks', () => {
    const src = `//@version=5\nindicator("RSI")\nrsi = ta.rsi(close, 14)\nplot(rsi)`;
    const r = parse(src);
    assert.equal(r.scriptType, 'indicator');
    assert.equal(r.blocks.filter(b => b.type === 'Entry').length, 0);
  });

  test('multi-line strategy.entry call is handled', () => {
    const src = `//@version=5
strategy("Test")
if close > open
    strategy.entry("L",
        strategy.long,
        qty=10)
`;
    const r = parse(src);
    const entries = r.blocks.filter(b => b.type === 'Entry');
    assert.ok(entries.length >= 1, 'should parse multi-line entry');
  });
});
