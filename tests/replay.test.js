/**
 * Tests for all replay functions in src/core/replay.js.
 * Covers: start, step, autoplay, stop, trade, status + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { start, step, autoplay, stop, trade, status, VALID_AUTOPLAY_DELAYS } from '../src/core/replay.js';
import {
  REPLAY_TRADING_ACK,
  REPLAY_TRADING_ENV,
  requireReplayTrading,
} from '../src/capabilities.js';
import { registerReplayTools } from '../src/tools/replay.js';
import { getRegisteredHandler } from '../src/cli/router.js';
import '../src/cli/commands/replay.js';

const replayTradingEnv = { [REPLAY_TRADING_ENV]: REPLAY_TRADING_ACK };

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockGetReplayApi() {
  return async () => 'window.__rp';
}

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi() }, evaluate };
}

async function callReplayTradeThroughSdk(args, deps) {
  const server = new McpServer({ name: 'replay-test', version: '1.0.0' });
  const client = new Client({ name: 'replay-test-client', version: '1.0.0' });
  registerReplayTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name: 'replay_trade', arguments: args });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

// ── start() ──────────────────────────────────────────────────────────────

describe('start() — date selection and polling', () => {
  it('awaits selectDate with timestamp in ms for date param', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    });
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.success, true);
    assert.equal(result.replay_started, true);
    assert.equal(result.current_date, 1773532799);
    assert.equal(result.date, '2026-03-15');
    // Verify selectDate was called with timestamp and .then()
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called');
    assert.ok(selectCall.includes('.then('), 'promise is awaited via .then()');
    assert.ok(selectCall.includes('1773532800000') || selectCall.includes('177'), 'passes ms timestamp');
  });

  it('calls selectFirstAvailableDate when no date given', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    const result = await start({ _deps });
    assert.equal(result.date, '(first available)');
    const firstAvail = evaluate.calls.find(c => c.includes('selectFirstAvailableDate'));
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
  });

  it('throws on invalid date string', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: 'not-a-date', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid date'));
        assert.ok(err.message.includes('not-a-date'));
        return true;
      },
    );
  });

  it('throws when replay not available', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': false });
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps }),
      (err) => err.message.includes('not available'),
    );
  });

  it('polls until isReplayStarted AND currentDate are set', async () => {
    let pollCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) {
        pollCount++;
        return pollCount >= 3; // becomes true on 3rd poll
      }
      if (expr.includes('currentDate')) {
        return pollCount >= 4 ? 1700000000 : null; // non-null on 4th poll
      }
      return undefined;
    };
    evaluate.calls = [];
    const result = await start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 1700000000);
    assert.ok(pollCount >= 4, 'polled multiple times');
  });

  it('throws and stops replay when polling times out (never started)', async () => {
    let stopCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) return false; // never starts
      if (expr.includes('currentDate')) return null;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } }),
      (err) => {
        assert.ok(err.message.includes('Replay failed to start'));
        return true;
      },
    );
    assert.ok(stopCalled, 'stopReplay called for cleanup');
  });
});

// ── step() ───────────────────────────────────────────────────────────────

describe('step() — doStep and polling', () => {
  it('calls doStep and polls until currentDate changes', async () => {
    let stepDone = false;
    let dateReadCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) {
        dateReadCount++;
        // First read (before) returns 1000, then after doStep: 1000 twice, then 2000
        if (!stepDone) return 1000;
        return dateReadCount >= 4 ? 2000 : 1000;
      }
      if (expr.includes('doStep')) { stepDone = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000);
    assert.equal(result.action, 'step');
  });

  it('returns stale date if poll times out (date never changes)', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 5000; // never changes
      if (expr.includes('doStep')) return undefined;
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.current_date, 5000);
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => step({ _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── autoplay() ───────────────────────────────────────────────────────────

describe('autoplay() — delay validation', () => {
  for (const delay of VALID_AUTOPLAY_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        'changeAutoplayDelay': undefined,
        'toggleAutoplay': undefined,
        'isAutoplayStarted': true,
        'autoplayDelay': delay,
      });
      const result = await autoplay({ speed: delay, _deps });
      assert.equal(result.success, true);
      assert.equal(result.delay_ms, delay);
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms before any CDP call`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => autoplay({ speed: delay, _deps }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          return true;
        },
      );
      // No CDP calls should have been made
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid speed');
    });
  }

  it('toggles without changing speed when speed is 0', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': true,
      'autoplayDelay': 100,
    });
    const result = await autoplay({ speed: 0, _deps });
    assert.equal(result.success, true);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called for speed=0');
  });

  it('toggles without changing speed when speed omitted', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': false,
      'autoplayDelay': 300,
    });
    const result = await autoplay({ _deps });
    assert.equal(result.autoplay_active, false);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called when speed omitted');
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => autoplay({ speed: 1000, _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('calls stopReplay when started', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'stopReplay': undefined,
    });
    const result = await stop({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.ok(stopCall, 'stopReplay was called');
  });

  it('returns already_stopped when not started', async () => {
    const { _deps, evaluate } = mockDeps({ 'isReplayStarted': false });
    const result = await stop({ _deps });
    assert.equal(result.action, 'already_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.equal(stopCall, undefined, 'stopReplay not called');
  });

  it('does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'), 'hideReplayToolbar must not appear anywhere');
  });
});

// ── trade() ──────────────────────────────────────────────────────────────

describe('trade()', () => {
  it('is denied by default before resolving the replay API or calling CDP', async () => {
    let replayApiCalls = 0;
    let evaluateCalls = 0;

    await assert.rejects(
      () => trade({
        action: 'buy',
        _deps: {
          env: {},
          getReplayApi: async () => { replayApiCalls++; },
          evaluate: async () => { evaluateCalls++; },
        },
      }),
      new RegExp(`${REPLAY_TRADING_ENV}=${REPLAY_TRADING_ACK}`),
    );

    assert.equal(replayApiCalls, 0);
    assert.equal(evaluateCalls, 0);
  });

  it('rejects truthy and near-match capability values', () => {
    for (const value of ['1', 'true', REPLAY_TRADING_ACK.toLowerCase(), `${REPLAY_TRADING_ACK} `]) {
      assert.throws(() => requireReplayTrading({ [REPLAY_TRADING_ENV]: value }), /disabled/);
    }
  });

  for (const action of ['buy', 'sell', 'close']) {
    it(`executes ${action} action`, async () => {
      const { _deps, evaluate } = mockDeps({
        'isReplayStarted': true,
        [action === 'close' ? 'closePosition' : action]: undefined,
        'position': 1,
        'realizedPL': 50.5,
      });
      _deps.env = replayTradingEnv;
      const result = await trade({ action, _deps });
      assert.equal(result.success, true);
      assert.equal(result.action, action);
      assert.equal(result.position, 1);
      assert.equal(result.realized_pnl, 50.5);
    });
  }

  it('throws on invalid action', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': true });
    _deps.env = replayTradingEnv;
    await assert.rejects(
      () => trade({ action: 'hold', _deps }),
      (err) => err.message.includes('Invalid action'),
    );
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    _deps.env = replayTradingEnv;
    await assert.rejects(
      () => trade({ action: 'buy', _deps }),
      (err) => err.message.includes('not started'),
    );
  });

  it('denies present and missing CLI actions before CDP access', async () => {
    let evaluated = false;
    const handler = getRegisteredHandler('replay', 'trade');
    for (const positionals of [['buy'], []]) {
      await assert.rejects(
        () => handler({}, positionals, { env: {}, evaluate: async () => { evaluated = true; } }),
        new RegExp(REPLAY_TRADING_ENV),
      );
    }
    assert.equal(evaluated, false);
  });

  it('validates missing CLI action only after exact opt-in', async () => {
    const handler = getRegisteredHandler('replay', 'trade');
    await assert.rejects(
      () => handler({}, [], { env: replayTradingEnv }),
      /Invalid action/,
    );
  });

  it('allows the actual registered CLI replay trade handler with exact opt-in', async () => {
    const { _deps } = mockDeps({
      'isReplayStarted': true,
      'buy': undefined,
      'position': 1,
      'realizedPL': 0,
    });
    _deps.env = replayTradingEnv;
    const handler = getRegisteredHandler('replay', 'trade');

    const result = await handler({}, ['buy'], _deps);
    assert.deepEqual(result, { success: true, action: 'buy', position: 1, realized_pnl: 0 });
  });

  it('denies arbitrary and missing MCP actions at the gate through the SDK boundary', async () => {
    for (const args of [{ action: 'buy' }, { action: { arbitrary: true } }, {}]) {
      const response = await callReplayTradeThroughSdk(args, {
        env: {},
        evaluate: async () => assert.fail('must not evaluate'),
        getReplayApi: async () => assert.fail('must not resolve replay API'),
      });
      const body = JSON.parse(response.content[0].text);

      assert.equal(response.isError, true);
      assert.match(body.error, new RegExp(REPLAY_TRADING_ENV));
      assert.doesNotMatch(body.error, /Invalid action/);
    }
  });

  it('validates MCP action only after exact opt-in through the SDK boundary', async () => {
    for (const args of [{ action: 'hold' }, {}]) {
      const response = await callReplayTradeThroughSdk(args, { env: replayTradingEnv });
      const body = JSON.parse(response.content[0].text);

      assert.equal(response.isError, true);
      assert.match(body.error, /Invalid action/);
      assert.doesNotMatch(body.error, /disabled/);
    }
  });
});

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('remains available without enabling simulated Replay trades', async () => {
    let callIdx = 0;
    const evaluate = async (expr) => {
      callIdx++;
      // Call 1: big inline IIFE for status fields
      if (callIdx === 1) {
        return {
          is_replay_available: true,
          is_replay_started: true,
          is_autoplay_started: false,
          replay_mode: 'ActiveChart',
          current_date: 1700000000,
          autoplay_delay: 1000,
        };
      }
      // Call 2: position
      if (callIdx === 2) return 2;
      // Call 3: realizedPL
      if (callIdx === 3) return 123.45;
      return undefined;
    };
    evaluate.calls = [];
    const result = await status({ _deps: { env: {}, evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.is_replay_started, true);
    assert.equal(result.current_date, 1700000000);
    assert.equal(result.position, 2);
    assert.equal(result.realized_pnl, 123.45);
  });
});
