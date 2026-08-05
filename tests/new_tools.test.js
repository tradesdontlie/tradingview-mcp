/**
 * Offline unit tests for the four new tools:
 *   - alert_get_log      (core: getLog)
 *   - chart_add_comparison (core: addComparison / removeComparison)
 *   - data_export_ohlcv  (core: exportOhlcv)
 *   - watchlist_manage   (core: listLists / createList)
 *
 * All CDP + filesystem access is dependency-injected via `_deps`, so these run
 * without a live TradingView or touching disk. Run: node --test tests/new_tools.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLog } from '../src/core/alerts.js';
import { addComparison, removeComparison } from '../src/core/chart.js';
import { exportOhlcv } from '../src/core/data.js';
import { listLists, createList } from '../src/core/watchlist.js';

// ── alert_get_log ─────────────────────────────────────────────────────────

describe('getLog — fired alerts', () => {
  it('returns fired-events when the fires feed is available', async () => {
    const _deps = { evaluateAsync: async () => ({
      fires: [{ fire_id: 1, alert_id: 10, time: 1700000000, symbol: 'AAPL', message: 'AAPL crossing 150' }],
      derived: [],
      error: null,
    }) };
    const r = await getLog({ limit: 5, _deps });
    assert.equal(r.success, true);
    assert.equal(r.source, 'internal_api_fires');
    assert.equal(r.fired_count, 1);
    assert.equal(r.fires[0].symbol, 'AAPL');
  });

  it('falls back to the list-derived log when the fires feed is unavailable', async () => {
    const _deps = { evaluateAsync: async () => ({
      fires: null,
      derived: [
        { alert_id: 10, time: 1700000060, symbol: 'MSFT', message: 'x', active: true },
        { alert_id: 11, time: 1700000000, symbol: 'AAPL', message: 'y', active: false },
      ],
      error: 'HTTP 404',
    }) };
    const r = await getLog({ limit: 5, _deps });
    assert.equal(r.success, true);
    assert.equal(r.source, 'internal_api_list');
    assert.equal(r.fired_count, 2);
    assert.match(r.note, /HTTP 404/);
  });

  it('caps results at the requested limit', async () => {
    const derived = Array.from({ length: 10 }, (_, i) => ({ alert_id: i, time: i, symbol: 'X', message: '' }));
    const _deps = { evaluateAsync: async () => ({ fires: null, derived, error: null }) };
    const r = await getLog({ limit: 3, _deps });
    assert.equal(r.fired_count, 3);
    assert.equal(r.fires.length, 3);
  });

  it('treats an empty-but-successful fires feed as authoritative, not as a failure', async () => {
    // feed responded with zero fires (fires=[]); derived must NOT shadow it.
    const _deps = { evaluateAsync: async () => ({
      fires: [],
      derived: [{ alert_id: 1, time: 1, symbol: 'X', message: '' }],
      error: null,
    }) };
    const r = await getLog({ limit: 5, _deps });
    assert.equal(r.success, true);
    assert.equal(r.source, 'internal_api_fires');
    assert.equal(r.fired_count, 0);
    assert.deepEqual(r.fires, []);
    assert.equal(r.note, undefined);
  });
});

// ── chart_add_comparison ──────────────────────────────────────────────────

function compareMock() {
  const calls = [];
  let studiesCalls = 0;
  const evaluate = async (expr) => {
    calls.push(expr);
    if (/getAllStudies\(\)\.map/.test(expr)) {
      studiesCalls++;
      return studiesCalls === 1 ? [] : ['study_1']; // before → after (one new study)
    }
    if (/createStudy/.test(expr)) return undefined;
    if (/getInputValues[\s\S]*setInputValues/.test(expr)) return { confirmed: { symbol: 'SPY', source: 'close' } };
    return undefined;
  };
  return { _deps: { evaluate }, calls };
}

describe('addComparison / removeComparison', () => {
  it('creates a Compare study carrying the symbol and returns the new entity id', async () => {
    const { _deps, calls } = compareMock();
    const r = await addComparison({ symbol: 'SPY', _deps });
    assert.equal(r.success, true);
    assert.equal(r.entity_id, 'study_1');
    assert.equal(r.symbol, 'SPY');
    assert.equal(r.source, 'close');
    const createCall = calls.find(c => /createStudy/.test(c));
    assert.ok(createCall.includes('Compare@tv-basicstudies'), 'uses the Compare study id');
    assert.ok(createCall.includes('"SPY"'), 'injects the sanitized symbol');
    assert.deepEqual(r.inputs, { symbol: 'SPY', source: 'close' });
  });

  it('requires a symbol', async () => {
    await assert.rejects(() => addComparison({ _deps: { evaluate: async () => [] } }), /symbol is required/);
  });

  it('removes matching comparison studies and reports what was removed', async () => {
    const hits = [{ entity_id: 'study_1', symbol: 'AMEX:SPY', name: 'SPY' }];
    const calls = [];
    const evaluate = async (expr) => { calls.push(expr); return hits; };
    const r = await removeComparison({ symbol: 'SPY', _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.removed_count, 1);
    assert.deepEqual(r.removed, hits);
    assert.ok(calls[0].includes('"SPY"'), 'injects the uppercased symbol to match on');
  });
});

// ── data_export_ohlcv ─────────────────────────────────────────────────────

describe('exportOhlcv', () => {
  const bars = [
    { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    { time: 1700000060, open: 1.5, high: 2.5, low: 1.2, close: 2.0, volume: 200 },
  ];

  it('writes a CSV with header + rows and returns metadata', async () => {
    let written = null;
    const r = await exportOhlcv({
      count: 2,
      path: 'out.csv',
      _deps: {
        getOhlcv: async ({ count }) => ({ bars: bars.slice(0, count) }),
        getState: async () => ({ symbol: 'AAPL', resolution: '5' }),
        writeFile: (fp, contents) => { written = { fp, contents }; },
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.bar_count, 2);
    assert.equal(r.symbol, 'AAPL');
    assert.equal(r.timeframe, '5');
    assert.deepEqual(r.columns, ['time', 'date', 'open', 'high', 'low', 'close', 'volume']);

    const lines = written.contents.trim().split('\n');
    assert.equal(lines[0], 'time,date,open,high,low,close,volume');
    assert.equal(lines.length, 3); // header + 2 bars
    assert.ok(lines[1].startsWith('1700000000,'));
    assert.ok(lines[1].includes(new Date(1700000000 * 1000).toISOString()), 'derives an ISO date column');
    assert.ok(lines[1].endsWith(',100'));
  });

  it('switches symbol/timeframe before exporting when requested', async () => {
    const calls = [];
    await exportOhlcv({
      symbol: 'MSFT', timeframe: '60', path: 'x.csv',
      _deps: {
        getOhlcv: async () => ({ bars: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }] }),
        getState: async () => ({ symbol: 'MSFT', resolution: '60' }),
        setSymbol: async ({ symbol }) => calls.push(['sym', symbol]),
        setTimeframe: async ({ timeframe }) => calls.push(['tf', timeframe]),
        writeFile: () => {},
      },
    });
    assert.deepEqual(calls, [['sym', 'MSFT'], ['tf', '60']]);
  });

  it('throws when the chart has no bars', async () => {
    await assert.rejects(() => exportOhlcv({
      path: 'y.csv',
      _deps: {
        getOhlcv: async () => ({ bars: [] }),
        getState: async () => ({ symbol: 'X', resolution: '1' }),
        writeFile: () => {},
      },
    }), /No OHLCV bars/);
  });
});

// ── watchlist_manage ──────────────────────────────────────────────────────

describe('listLists — response shape handling', () => {
  it('parses a bare array response and marks the active list', async () => {
    const _deps = {
      evaluateAsync: async () => ({ status: 200, ok: true, body: '', data: [
        { id: 1, name: 'Tech', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
        { id: 2, name: 'Energy', symbols: ['NYMEX:CL1!'] },
      ] }),
      getActiveListInfo: async () => ({ id: 2, name: 'Energy' }),
    };
    const r = await listLists({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(r.active_id, 2);
    assert.equal(r.lists[0].symbol_count, 2);
    assert.equal(r.lists[1].active, true);
    assert.equal(r.lists[0].active, false);
  });

  it('parses a { lists: [...] } wrapper', async () => {
    const _deps = {
      evaluateAsync: async () => ({ status: 200, ok: true, body: '', data: { lists: [{ id: 9, name: 'A', symbols: [] }] } }),
      getActiveListInfo: async () => null,
    };
    const r = await listLists({ _deps });
    assert.equal(r.count, 1);
    assert.equal(r.lists[0].id, 9);
  });

  it('parses a { r: [...] } wrapper', async () => {
    const _deps = {
      evaluateAsync: async () => ({ status: 200, ok: true, body: '', data: { r: [{ id: 3, name: 'B' }] } }),
      getActiveListInfo: async () => null,
    };
    const r = await listLists({ _deps });
    assert.equal(r.count, 1);
  });

  it('throws a diagnostic error on HTTP failure', async () => {
    const _deps = {
      evaluateAsync: async () => ({ status: 403, ok: false, data: null, body: 'Forbidden' }),
      getActiveListInfo: async () => null,
    };
    await assert.rejects(() => listLists({ _deps }), /HTTP 403[\s\S]*Forbidden/);
  });
});

describe('createList', () => {
  it('posts name + symbols and returns the new list id', async () => {
    let sent = null;
    const _deps = { evaluateAsync: async (expr) => { sent = expr; return { status: 200, ok: true, body: '', data: { id: 42, name: 'My List' } }; } };
    const r = await createList({ name: 'My List', symbols: ['NASDAQ:AAPL'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.list_id, 42);
    assert.ok(sent.includes('"My List"'), 'injects the list name');
    assert.ok(sent.includes('NASDAQ:AAPL'), 'injects seed symbols');
    assert.ok(/method['"]?\s*:\s*['"]POST/.test(sent), 'POSTs the request');
  });

  it('throws on HTTP failure', async () => {
    const _deps = { evaluateAsync: async () => ({ status: 400, ok: false, data: null, body: 'bad' }) };
    await assert.rejects(() => createList({ name: 'X', _deps }), /Create watchlist failed[\s\S]*HTTP 400/);
  });

  it('requires a name', async () => {
    await assert.rejects(() => createList({ _deps: { evaluateAsync: async () => ({}) } }), /name is required/);
  });
});
