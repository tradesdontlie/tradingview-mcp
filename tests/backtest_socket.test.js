/**
 * Tests for the headless backtest sidecar (src/sidecar/backtest_socket.js).
 * Socket I/O (fetchStudy) and fs are injected — no network/token needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backtestPull, NA_SENTINEL } from '../src/sidecar/backtest_socket.js';

const T = (d) => Math.floor(new Date(d).getTime() / 1000);

// Socket returns newest-first, with an na sentinel in one plot.
function mockDeps() {
  const written = [];
  const deps = {
    fetchStudy: async (opts) => {
      deps._fetchOpts = opts;
      return {
        studyPeriods: [
          { $time: T('2025-03-05'), EMA_5: 12, EMA_20: NA_SENTINEL }, // newest first
          { $time: T('2025-03-04'), EMA_5: 11, EMA_20: 10 },
          { $time: T('2025-03-03'), EMA_5: 10, EMA_20: 9 },
          { $time: T('2025-02-20'), EMA_5: 8, EMA_20: 7 },            // before `from`
        ],
        graphic: { labels: [{}, {}, {}], lines: [{}], boxes: [], tables: [{}] },
      };
    },
    writeFile: () => { written.length = 0; },
    appendFile: (p, s) => { written.push(s); },
  };
  return { deps, written };
}

describe('backtestPull() — normalize / filter / shape', () => {
  it('normalizes na sentinel to null, sorts ascending, filters by date', async () => {
    const { deps } = mockDeps();
    const r = await backtestPull({ symbol: 'NASDAQ:AAPL', indicatorId: 'USER;x', from: '2025-03-03', to: '2025-03-05', token: 'tok', _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.engine, 'socket');
    assert.equal(r.bars_pulled, 3);                       // 02-20 filtered out
    assert.equal(r.series[0].t, T('2025-03-03'));         // ascending
    assert.equal(r.series[2].t, T('2025-03-05'));
    assert.equal(r.series[2].values.EMA_20, null);        // na sentinel cleaned
    assert.equal(r.series[0].values.EMA_5, 10);
  });

  it('reports graphic counts', async () => {
    const { deps } = mockDeps();
    const r = await backtestPull({ symbol: 'X', indicatorId: 'USER;x', token: 'tok', _deps: deps });
    assert.deepEqual(r.graphic, { labels: 3, lines: 1, boxes: 0, tables: 1 });
  });

  it('streams JSONL to out and omits the inline series', async () => {
    const { deps, written } = mockDeps();
    const r = await backtestPull({ symbol: 'X', indicatorId: 'USER;x', out: 'pull.jsonl', token: 'tok', _deps: deps });
    assert.equal(r.out_path, 'pull.jsonl');
    assert.equal(r.series, undefined);
    assert.equal(written.length, r.bars_pulled);
    assert.equal(JSON.parse(written[0]).t, T('2025-02-20'));  // no from filter → all 4, oldest first
  });

  it('passes symbol/timeframe/range/indicator through to the socket layer', async () => {
    const { deps } = mockDeps();
    await backtestPull({ symbol: 'NYSE:F', timeframe: '60', range: 300, indicatorId: 'STD;RSI', token: 'tok', _deps: deps });
    assert.equal(deps._fetchOpts.symbol, 'NYSE:F');
    assert.equal(deps._fetchOpts.timeframe, '60');
    assert.equal(deps._fetchOpts.range, 300);
    assert.equal(deps._fetchOpts.indicatorId, 'STD;RSI');
    assert.equal(deps._fetchOpts.token, 'tok');
  });

  it('notes when the pulled window did not reach `from`', async () => {
    const { deps } = mockDeps();
    const r = await backtestPull({ symbol: 'X', indicatorId: 'USER;x', from: '2020-01-01', token: 'tok', _deps: deps });
    assert.ok(r.note && r.note.includes('increase range'));
  });

  it('throws on missing symbol / indicatorId / token', async () => {
    const { deps } = mockDeps();
    await assert.rejects(() => backtestPull({ indicatorId: 'USER;x', token: 't', _deps: deps }), /symbol` is required/);
    await assert.rejects(() => backtestPull({ symbol: 'X', token: 't', _deps: deps }), /indicatorId` is required/);
    await assert.rejects(() => backtestPull({ symbol: 'X', indicatorId: 'USER;x', _deps: deps }), /No session token/);
  });
});
