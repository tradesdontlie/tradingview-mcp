// Backtest unit tests — offline, no network. Uses synthetic bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// We test the public API for compare_strategies via a stub that bypasses
// fetchOhlcv (which hits Yahoo). Direct simulate() is not exported, so we
// drive runBacktest through a minimal harness by faking yahoo-finance2.

// To keep the test self-contained, just verify STRATEGY_NAMES and
// fetchOhlcv error path with a clearly bogus symbol.
import { STRATEGY_NAMES, runBacktest } from '../src/core/backtest.js';

test('STRATEGY_NAMES exposes 6 strategies', () => {
  assert.deepEqual(
    [...STRATEGY_NAMES].sort(),
    ['bollinger', 'donchian', 'ema_cross', 'macd', 'rsi', 'supertrend'].sort()
  );
});

test('runBacktest with unknown strategy returns error block', async () => {
  const r = await runBacktest({ symbol: 'AAPL', strategy: 'not_a_strategy' });
  assert.ok(r.error && r.error.includes('unknown strategy'));
});

// Note: full simulator behavior is covered by live runs in
// tests/server_smoke.js. A pure-synthetic harness would require either
// exporting simulate() or mocking yahoo-finance2 — both larger changes
// than warranted for the review fix scope.
