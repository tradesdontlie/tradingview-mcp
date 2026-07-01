/**
 * Tests for replay_walk (src/core/backtest.js) — termination reasons (end date,
 * end-of-data, max_bars), JSONL output, and passthrough of capture/sections.
 * All collaborators (start/step/setResolution/chartSnapshot/fs) are injected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayWalk } from '../src/core/backtest.js';

const DAY = 86400;
const T0 = Math.floor(Date.parse('2025-03-03') / 1000);

// Stateful simulation: start() seeds the cursor; step() advances one "day" and
// throws once it has stepped `throwAfter` times; chartSnapshot() reports the
// current bar. Records snapshot args + written JSONL lines.
function sim({ throwAfter = Infinity } = {}) {
  let cur = T0;
  let steps = 0;
  const snapCalls = [];
  const written = [];
  const deps = {
    start: async () => { cur = T0; steps = 0; return { success: true, current_date: cur }; },
    setResolution: async (a) => { deps._resCalled = a; return { success: true }; },
    step: async () => {
      steps++;
      if (steps > throwAfter) throw new Error('Replay bar did not advance');
      cur += DAY;
      return { success: true, current_date: cur };
    },
    chartSnapshot: async (arg) => {
      snapCalls.push(arg);
      return {
        success: true,
        bar_time: cur - 23400, // bar.time (open) vs cursor (session close), like live
        ohlcv: { bars: [{ time: cur - 23400, close: 10 + steps }] },
        studies: { studies: [{ name: 'My Indicator', values: { signal: steps } }] },
        pine_labels: { studies: [] },
        pine_lines: { studies: [] },
      };
    },
    waitReady: async () => true, // skip the real readiness poll in unit tests
    appendFile: (p, s) => { written.push(s); },
    writeFile: (p, s) => { written.length = 0; },
  };
  return { deps, snapCalls, written };
}

describe('replayWalk() — termination & capture', () => {
  it('captures inclusive bars and stops at the end date', async () => {
    const { deps } = sim();
    const r = await replayWalk({ from: '2025-03-03', to: '2025-03-06', _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.reason, 'reached_end_date');
    assert.equal(r.truncated, false);
    assert.equal(r.bars_captured, 4);            // 03,04,05,06
    assert.equal(r.series.length, 4);
    assert.equal(r.series[0].t, T0 - 23400);     // keyed on bar.time, not cursor
    assert.equal(r.series[0].current_date, T0);
  });

  it('stops with no_more_data when step() throws (end of available data)', async () => {
    const { deps } = sim({ throwAfter: 1 });
    const r = await replayWalk({ from: '2025-03-03', to: '2025-12-31', _deps: deps });
    assert.equal(r.reason, 'no_more_data');
    assert.equal(r.bars_captured, 2);            // captured T0, stepped once, captured, then throw
    assert.equal(r.truncated, false);
  });

  it('respects max_bars and flags truncated', async () => {
    const { deps } = sim();
    const r = await replayWalk({ from: '2025-03-03', to: '2025-12-31', max_bars: 3, _deps: deps });
    assert.equal(r.reason, 'max_bars');
    assert.equal(r.truncated, true);
    assert.equal(r.bars_captured, 3);
    assert.ok(r.note && r.note.includes('max_bars'));
  });

  it('streams JSONL to out and omits the inline series', async () => {
    const { deps, written } = sim();
    const r = await replayWalk({ from: '2025-03-03', to: '2025-03-05', out: 'walk.jsonl', _deps: deps });
    assert.equal(r.out_path, 'walk.jsonl');
    assert.equal(r.series, undefined, 'no inline series when writing to file');
    assert.equal(written.length, r.bars_captured, 'one JSONL line per bar');
    const firstRow = JSON.parse(written[0]);
    assert.equal(firstRow.t, T0 - 23400);
  });

  it('passes capture as study_filter and sections as include to chart_snapshot', async () => {
    const { deps, snapCalls } = sim();
    await replayWalk({ from: '2025-03-03', to: '2025-03-04', capture: 'My Indicator', sections: ['ohlcv', 'studies'], _deps: deps });
    assert.equal(snapCalls[0].study_filter, 'My Indicator');
    assert.deepEqual(snapCalls[0].include, ['ohlcv', 'studies']);
  });

  it('applies resolution when provided', async () => {
    const { deps } = sim();
    await replayWalk({ from: '2025-03-03', to: '2025-03-04', resolution: '1H', _deps: deps });
    assert.deepEqual(deps._resCalled, { resolution: '1H' });
  });

  it('throws on missing/invalid dates', async () => {
    const { deps } = sim();
    await assert.rejects(() => replayWalk({ to: '2025-03-04', _deps: deps }), /`from` date is required/);
    await assert.rejects(() => replayWalk({ from: '2025-03-03', _deps: deps }), /`to` date is required/);
    await assert.rejects(() => replayWalk({ from: 'nope', to: '2025-03-04', _deps: deps }), /Invalid from date/);
  });
});
