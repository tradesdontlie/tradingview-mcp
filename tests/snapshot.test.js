/**
 * Tests for chart_snapshot (src/core/snapshot.js) — section selection, study
 * filtering, per-section error isolation, and bar_time surfacing. Section
 * fetchers are injected via _deps so no CDP is needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chartSnapshot, SNAPSHOT_SECTIONS } from '../src/core/snapshot.js';

function mockDeps(overrides = {}) {
  const calls = [];
  const track = (name, ret) => async (arg) => { calls.push({ name, arg }); return typeof ret === 'function' ? ret(arg) : ret; };
  const deps = {
    getState: track('state', { success: true, symbol: 'AAPL', resolution: 'D' }),
    getOhlcv: track('ohlcv', { success: true, bars: [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] }),
    getStudyValues: track('studies', { success: true, study_count: 2, studies: [
      { name: 'Relative Strength Index', values: { RSI: 55 } },
      { name: 'My Custom Dashboard', values: { Bias: 'Long' } },
    ] }),
    getPineLines: track('pine_lines', { success: true, study_count: 1, studies: [{ name: 'My Custom Dashboard', horizontal_levels: [100, 90] }] }),
    getPineLabels: track('pine_labels', { success: true, study_count: 1, studies: [{ name: 'My Custom Dashboard', labels: ['Bias Long'] }] }),
    getPineTables: track('pine_tables', { success: true, study_count: 0, studies: [] }),
    getPineBoxes: track('pine_boxes', { success: true, study_count: 0, studies: [] }),
    ...overrides,
  };
  return { deps, calls };
}

describe('chartSnapshot() — sections & shaping', () => {
  it('captures all sections by default and surfaces bar_time', async () => {
    const { deps } = mockDeps();
    const r = await chartSnapshot({ _deps: deps });
    assert.equal(r.success, true);
    for (const s of SNAPSHOT_SECTIONS) assert.ok(r[s], `section ${s} present`);
    assert.equal(r.bar_time, 1700000000, 'bar_time surfaced from last OHLCV bar');
  });

  it('include restricts to the requested sections only', async () => {
    const { deps, calls } = mockDeps();
    const r = await chartSnapshot({ include: ['ohlcv', 'pine_labels'], _deps: deps });
    assert.ok(r.ohlcv && r.pine_labels);
    assert.equal(r.state, undefined, 'state not captured');
    assert.equal(r.studies, undefined, 'studies not captured');
    const called = calls.map(c => c.name).sort();
    assert.deepEqual(called, ['ohlcv', 'pine_labels'], 'only requested fetchers ran');
  });

  it('throws on an unknown include section (fail loud)', async () => {
    const { deps } = mockDeps();
    await assert.rejects(
      () => chartSnapshot({ include: ['ohlcv', 'bogus'], _deps: deps }),
      (err) => err.message.includes('Unknown snapshot section'),
    );
  });

  it('applies study_filter across studies (substring, case-insensitive)', async () => {
    const { deps } = mockDeps();
    const r = await chartSnapshot({ study_filter: 'custom', _deps: deps });
    assert.equal(r.studies.study_count, 1);
    assert.equal(r.studies.studies[0].name, 'My Custom Dashboard');
  });

  it('isolates a failing section as { error } without failing the snapshot', async () => {
    const { deps } = mockDeps({
      getPineTables: async () => { throw new Error('tables boom'); },
    });
    const r = await chartSnapshot({ _deps: deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.pine_tables, { error: 'tables boom' });
    assert.ok(r.studies.success, 'other sections still captured');
  });
});
