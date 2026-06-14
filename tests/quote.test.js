/**
 * Tests for getQuote() symbol-integrity guard.
 *
 * quote_get reads the ACTIVE chart's bars. When a caller passes an explicit
 * `symbol` that differs from the chart, the old code stamped the requested
 * symbol onto another ticker's prices — silently returning wrong-symbol data
 * (e.g. asking for SMCI while the chart was on TSLA returned Tesla's price
 * labeled "SMCI"). These tests lock in the guard that refuses the mismatch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote } from '../src/core/data.js';

// Mock evaluate: returns a canned payload and records the generated expression.
function mockEval(payload) {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return payload; };
  fn.calls = calls;
  return fn;
}

describe('getQuote() — symbol integrity', () => {
  it('throws when the chart symbol differs from the requested symbol', async () => {
    const evaluate = mockEval({ symbol_mismatch: true, requested: 'SMCI', chart_symbol: 'BATS:TSLA' });
    await assert.rejects(
      () => getQuote({ symbol: 'SMCI', _deps: { evaluate } }),
      /Chart is on BATS:TSLA, not SMCI/,
    );
  });

  it('mismatch error names the correct chart_set_symbol remedy', async () => {
    const evaluate = mockEval({ symbol_mismatch: true, requested: 'AAPL', chart_symbol: 'NASDAQ:MSFT' });
    await assert.rejects(
      () => getQuote({ symbol: 'AAPL', _deps: { evaluate } }),
      /chart_set_symbol\("AAPL"\)/,
    );
  });

  it('returns the quote when the symbol matches', async () => {
    const evaluate = mockEval({ symbol: 'BATS:TSLA', last: 406.43, close: 406.43, description: 'Tesla, Inc.' });
    const q = await getQuote({ symbol: 'TSLA', _deps: { evaluate } });
    assert.equal(q.success, true);
    assert.equal(q.symbol, 'BATS:TSLA');
    assert.equal(q.last, 406.43);
  });

  it('quotes the active chart when no symbol is given', async () => {
    const evaluate = mockEval({ symbol: 'BATS:SNAP', last: 12.5, close: 12.5 });
    const q = await getQuote({ _deps: { evaluate } });
    assert.equal(q.success, true);
    assert.equal(q.symbol, 'BATS:SNAP');
  });

  it('passes the requested symbol through safeString (no raw interpolation)', async () => {
    const evaluate = mockEval({ symbol: 'AAPL', last: 1, close: 1 });
    await getQuote({ symbol: 'AAPL"; alert(1); //', _deps: { evaluate } });
    const expr = evaluate.calls[0];
    // safeString JSON-encodes the value; a raw break-out quote must not appear.
    assert.ok(!expr.includes('AAPL"; alert(1); //'), 'symbol was interpolated without sanitization');
    assert.ok(expr.includes('symbol_mismatch'), 'guard clause missing from generated expression');
  });
});
