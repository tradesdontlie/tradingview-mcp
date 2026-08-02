/**
 * Tests for alert symbol targeting.
 *
 * WHY THIS EXISTS. `create()` used to have no `symbol` parameter at all: it read
 * the active chart symbol and armed on that, so a caller asking for one
 * instrument silently got another. That is the worst shape of wrong — the call
 * returns success, the alert lists correctly, and it simply never fires. It bit
 * a downstream consumer twice in two days: once arming an alert at a price the
 * (wrong) instrument could never reach, once arming two alerts on a leftover
 * chart symbol.
 *
 * Measured while fixing it: the endpoint was NEVER tied to the chart. Requesting
 * `NYSE:SW` while charting `BATS:MSFT` returns `s:ok` and arms on `BATS:SW` —
 * the right instrument, with TradingView normalizing the venue to its
 * consolidated US feed server-side. So a VENUE rewrite is expected and must not
 * be treated as an error, while a TICKER change is exactly the failure to catch.
 * `bareSymbol` is the comparison that draws that line, and `symbolFromMarker`
 * is what lets the response report the instrument TradingView actually armed
 * instead of the one we asked for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bareSymbol, symbolFromMarker } from '../src/core/alerts.js';

describe('bareSymbol', () => {
  it('strips an exchange prefix', () => {
    assert.equal(bareSymbol('NYSE:SW'), 'SW');
    assert.equal(bareSymbol('NASDAQ:JBHT'), 'JBHT');
    assert.equal(bareSymbol('BATS:MSFT'), 'MSFT');
  });

  it('leaves a bare symbol alone and is idempotent', () => {
    assert.equal(bareSymbol('SW'), 'SW');
    assert.equal(bareSymbol(bareSymbol('NYSE:SW')), 'SW');
  });

  it('upper-cases and trims', () => {
    assert.equal(bareSymbol('  nyse:sw  '), 'SW');
  });

  it('treats a venue rewrite as the SAME instrument', () => {
    // TradingView normalizes NYSE:SW -> BATS:SW server-side. Expected, not a bug.
    assert.equal(bareSymbol('NYSE:SW'), bareSymbol('BATS:SW'));
  });

  it('treats a different ticker as DIFFERENT', () => {
    // The two field incidents: an O alert on CDE, and SW/PM alerts on TJX.
    assert.notEqual(bareSymbol('NYSE:O'), bareSymbol('BATS:CDE'));
    assert.notEqual(bareSymbol('NYSE:SW'), bareSymbol('BATS:TJX'));
  });

  it('survives empty and nullish input', () => {
    assert.equal(bareSymbol(''), '');
    assert.equal(bareSymbol(null), '');
    assert.equal(bareSymbol(undefined), '');
  });
});

describe('symbolFromMarker', () => {
  it('parses the marker TradingView echoes back', () => {
    const marker = '=' + JSON.stringify({
      symbol: 'BATS:SW', adjustment: 'dividends', 'currency-id': 'USD',
    });
    assert.equal(symbolFromMarker(marker), 'BATS:SW');
  });

  it('returns null on a malformed marker rather than throwing', () => {
    // A throw here would take down a create() that actually succeeded.
    assert.equal(symbolFromMarker('=not json'), null);
    assert.equal(symbolFromMarker(''), null);
    assert.equal(symbolFromMarker(undefined), null);
  });

  it('returns null when the payload has no symbol field', () => {
    assert.equal(symbolFromMarker('=' + JSON.stringify({ adjustment: 'dividends' })), null);
  });

  it('round-trips with bareSymbol to detect a mis-target', () => {
    const armed = symbolFromMarker('=' + JSON.stringify({ symbol: 'BATS:TJX' }));
    assert.equal(bareSymbol(armed) === bareSymbol('NYSE:SW'), false,
      'a mis-targeted alert must compare unequal');
    const ok = symbolFromMarker('=' + JSON.stringify({ symbol: 'BATS:SW' }));
    assert.equal(bareSymbol(ok) === bareSymbol('NYSE:SW'), true,
      'a venue rewrite must compare equal');
  });
});
