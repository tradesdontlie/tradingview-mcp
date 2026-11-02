import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseReplayStart, start, stop } from '../src/core/replay.js';
import { registerReplayTools } from '../src/tools/replay.js';

function runtime({ goToRealtime = true, legacy = true, settleAfter = 0, reject = false, stuck = false } = {}) {
  const state = { started: true, date: 1700000000, selected: [], calls: [], sleeps: 0 };
  const api = {
    isReplayAvailable: () => true,
    isReplayStarted: () => ({ value: () => state.started }),
    currentDate: () => ({ value: () => state.date }),
    showReplayToolbar: () => { state.calls.push('toolbar'); },
    selectDate: milliseconds => { state.selected.push(milliseconds); return Promise.resolve(); },
    selectFirstAvailableDate: () => Promise.resolve(),
  };
  const leave = name => {
    state.calls.push(name);
    if (reject) return Promise.reject(new Error('uncertain operation failure'));
    if (!stuck && settleAfter === 0) { state.started = false; state.date = null; }
    return Promise.resolve();
  };
  if (goToRealtime) api.goToRealtime = () => leave('goToRealtime');
  if (legacy) api.stopReplay = () => leave('stopReplay');
  const _deps = {
    getReplayApi: async () => 'window.__rp',
    evaluate: async (expression, opts) => {
      if (expression.includes('Promise.resolve')) assert.equal(opts.awaitPromise, true);
      return vm.runInNewContext(expression, { window: { __rp: api } });
    },
    sleep: async () => {
      state.sleeps++;
      if (!stuck && settleAfter && state.sleeps >= settleAfter) { state.started = false; state.date = null; }
    },
  };
  return { state, _deps };
}

describe('exact replay start time contract', () => {
  it('retains UTC date-only compatibility and matches equivalent offset/Z instants', () => {
    assert.equal(parseReplayStart({ date: '2026-03-15' }), Date.parse('2026-03-15T00:00:00Z'));
    assert.equal(parseReplayStart({ date: '2026-03-15T09:30:15.123+01:00' }), parseReplayStart({ date: '2026-03-15T08:30:15.123Z' }));
    assert.equal(parseReplayStart({ date: '2024-02-29T09:30Z' }), Date.parse('2024-02-29T09:30Z'));
  });

  it('treats zero, negative and fractional numeric timestamps as seconds, never guesses units', () => {
    assert.equal(parseReplayStart({ timestamp: 0 }), 0);
    assert.equal(parseReplayStart({ timestamp: -1 }), -1000);
    assert.equal(parseReplayStart({ timestamp: 1700000000.123 }), 1700000000123);
    assert.throws(() => parseReplayStart({ timestamp: 1700000000123 }), /milliseconds are not accepted/);
  });

  it('rejects ambiguous or invalid calendar times and conflicting selectors before touching CDP', async () => {
    for (const date of ['2026-03-15T09:30', '2026-03-15 09:30:00', '2026-02-29', '2026-02-31T09:30Z', '2026-13-01', '2026-03-15T09:30:00+14:30', '', '2026-03-15T24:00:00Z']) {
      const { state, _deps } = runtime();
      await assert.rejects(start({ date, _deps }), /Invalid date/);
      assert.deepEqual(state.calls, []);
    }
    for (const timestamp of [NaN, Infinity, -Infinity, null, '1700000000', true, -62135596801, 253402300800]) {
      assert.throws(() => parseReplayStart({ timestamp }), /finite Unix seconds/);
    }
    assert.throws(() => parseReplayStart({ date: '2026-03-15', timestamp: 0 }), /not both/);
  });

  it('passes the exact converted instant to TradingView and returns a UTC receipt', async () => {
    const { state, _deps } = runtime();
    const result = await start({ timestamp: 1773563415.123, _deps });
    assert.deepEqual(state.selected, [1773563415123]);
    assert.equal(result.requested_timestamp, 1773563415.123);
    assert.equal(result.requested_time_utc, new Date(1773563415123).toISOString());
  });

  it('exposes the strict timestamp input in the preserved upstream replay_start schema', () => {
    let schema;
    registerReplayTools({ tool(name, description, parameters) { if (name === 'replay_start') schema = parameters; } });
    assert.equal(schema.timestamp.parse(0), 0);
    assert.equal(schema.timestamp.safeParse('1700000000').success, false);
    assert.equal(schema.timestamp.safeParse(1700000000123).success, false);
  });
});

describe('verified stop to realtime', () => {
  it('prefers goToRealtime, waits for actual live state and never calls the legacy close first', async () => {
    const { state, _deps } = runtime({ settleAfter: 3 });
    const result = await stop({ _deps });
    assert.equal(result.method, 'goToRealtime');
    assert.deepEqual(state.calls, ['goToRealtime']);
    assert.equal(state.sleeps, 3);
    assert.equal(result.current_date, null);
    assert.equal(result.is_replay_started, false);
  });

  it('supports an older API only if its fallback proves the chart is live', async () => {
    const { state, _deps } = runtime({ goToRealtime: false });
    assert.equal((await stop({ _deps })).method, 'stopReplay');
    assert.deepEqual(state.calls, ['stopReplay']);
    await assert.rejects(stop({ _deps: runtime({ goToRealtime: false, stuck: true })._deps }), /did not return to verified realtime/);
  });

  it('never retries an uncertain mutation or falls back after goToRealtime throws', async () => {
    const { state, _deps } = runtime({ reject: true });
    await assert.rejects(stop({ _deps }), /uncertain operation failure/);
    assert.deepEqual(state.calls, ['goToRealtime']);
  });

  it('does not report success on a stuck or contradictory manager state', async () => {
    const { state, _deps } = runtime({ stuck: true });
    await assert.rejects(stop({ _deps }), /did not return to verified realtime/);
    assert.equal(state.sleeps, 19);
    state.started = false; // A closed toolbar alone is not a live chart.
    await assert.rejects(stop({ _deps }), /did not return to verified realtime/);
    state.date = null;
    assert.equal((await stop({ _deps })).action, 'already_stopped');
  });

  it('fails visibly without changing the chart when neither supported API is present', async () => {
    const { state, _deps } = runtime({ goToRealtime: false, legacy: false });
    await assert.rejects(stop({ _deps }), /No supported replay-to-live/);
    assert.deepEqual(state.calls, []);
  });
});
