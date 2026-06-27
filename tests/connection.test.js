/**
 * Offline unit tests for connection-layer resilience.
 *
 * Covers the parts of `improve-cdp-connection-resilience` that are deterministic
 * without a live TradingView at port 9222:
 *   - isConnectionResetError() classifies transport drops vs. real JS errors.
 *   - evaluate() retries exactly ONCE on a connection-reset class error after
 *     reconnecting, then succeeds.
 *   - evaluate() does NOT retry on a real page-side JS exception.
 *
 * fetchWithTimeout abort-on-deadline is already covered by tests/tab.test.js and
 * is intentionally not duplicated here.
 *
 * The retry path is exercised via the test-only seams __setClientForTest() /
 * __setConnectImplForTest() so no live CDP attach is needed.
 *
 * Run: node --test tests/connection.test.js
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  isConnectionResetError,
  __setClientForTest,
  __setConnectImplForTest,
} from '../src/connection.js';

afterEach(() => {
  __setClientForTest(null);
  __setConnectImplForTest(null);
});

describe('isConnectionResetError', () => {
  it('matches connection-reset class messages', () => {
    for (const m of [
      'read ECONNRESET',
      'socket hang up',
      'Target closed',
      'WebSocket is not open: readyState 3 (CLOSED)',
      'Session closed. Most likely the page has been closed.',
    ]) {
      assert.equal(isConnectionResetError(m), true, `expected reset match: ${m}`);
    }
  });

  it('does not match real page-side JS errors', () => {
    for (const m of [
      'JS evaluation error: ReferenceError: foo is not defined',
      'TypeError: cannot read property of undefined',
      undefined,
      '',
    ]) {
      assert.equal(isConnectionResetError(m), false, `expected no match: ${m}`);
    }
  });
});

describe('evaluate — connection-reset retry', () => {
  it('retries once after a Target closed error then succeeds', async () => {
    let calls = 0;
    // Fake CDP client whose first evaluate throws a transport drop, second succeeds.
    const flakyClient = {
      Runtime: {
        evaluate: async () => {
          calls++;
          if (calls === 1) throw new Error('Target closed');
          return { result: { value: 42 } };
        },
      },
    };
    __setClientForTest(flakyClient);

    // The reconnect path returns a FRESH healthy client for the single retry.
    let reconnects = 0;
    const freshClient = {
      Runtime: { evaluate: async () => { reconnects++; return { result: { value: 42 } }; } },
    };
    __setConnectImplForTest(async () => freshClient);

    const value = await evaluate('1 + 41');
    assert.equal(value, 42);
    assert.equal(calls, 1, 'original client should be called exactly once (then dropped)');
    assert.equal(reconnects, 1, 'reconnected client should be used for the single retry');
  });

  it('throws if the retry also fails (no second retry)', async () => {
    let calls = 0;
    const deadClient = {
      Runtime: {
        evaluate: async () => { calls++; throw new Error('socket hang up'); },
      },
    };
    __setClientForTest(deadClient);

    let reconnects = 0;
    const stillDead = {
      Runtime: { evaluate: async () => { reconnects++; throw new Error('socket hang up'); } },
    };
    __setConnectImplForTest(async () => stillDead);

    await assert.rejects(() => evaluate('boom'), /socket hang up/);
    assert.equal(calls, 1, 'original client called once');
    assert.equal(reconnects, 1, 'retry attempted exactly once');
  });

  it('does NOT retry on a real page-side JS exception', async () => {
    let reconnects = 0;
    const client = {
      Runtime: {
        evaluate: async () => ({
          exceptionDetails: { text: 'ReferenceError: foo is not defined' },
        }),
      },
    };
    __setClientForTest(client);
    __setConnectImplForTest(async () => { reconnects++; return client; });

    await assert.rejects(() => evaluate('foo'), /JS evaluation error/);
    assert.equal(reconnects, 0, 'a real JS exception must not trigger a reconnect/retry');
  });
});
