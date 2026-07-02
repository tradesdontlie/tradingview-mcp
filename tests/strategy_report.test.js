/**
 * Tests for the strategyReport reader (src/sidecar/strategy_report.js) — T119.
 *
 * The socket fetch is injected (_deps.fetchStrategyReport) so the normalization
 * layer is exercised without a token or network. The mocked report mirrors the
 * shape @mathieuc/tradingview exposes on `study.strategyReport` after its own
 * parsing (see node_modules/@mathieuc/tradingview/src/chart/study.js):
 *   { currency, performance:{ all:{...}, maxDrawDown, ... }, trades:[{entry,exit,...}], history:{equity[]} }
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backtestRunStrategy, normalizeStrategyReport } from '../src/sidecar/strategy_report.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

// 3 trades: long +10, long -4, short +6 → mirrors the signal-engine fixture so
// the two engines demonstrably produce the same canonical schema.
const REPORT = {
  currency: 'USD',
  performance: {
    all: {
      netProfit: 12, grossProfit: 16, grossLoss: -4, profitFactor: 4,
      percentProfitable: 2 / 3, totalTrades: 3,
      numberOfWiningTrades: 2, numberOfLosingTrades: 1,
    },
    maxStrategyDrawDown: 4, maxStrategyDrawDownPercent: 0.004, sharpeRatio: 1.2, sortinoRatio: 1.7,
  },
  trades: [
    { entry: { name: 'Long', type: 'long', value: 100, time: 10 }, exit: { name: 'Exit', value: 110, time: 12 }, quantity: 1, profit: { v: 10, p: 0.10 } },
    { entry: { name: 'Long', type: 'long', value: 108, time: 13 }, exit: { name: 'Exit', value: 104, time: 14 }, quantity: 1, profit: { v: -4, p: -0.037 } },
    { entry: { name: 'Short', type: 'short', value: 106, time: 15 }, exit: { name: 'Exit', value: 100, time: 16 }, quantity: 1, profit: { v: 6, p: 0.0566 } },
  ],
  history: { equity: [1000, 1010, 1006, 1012] },
};

describe('normalizeStrategyReport() — canonical metrics recomputed from the trade list', () => {
  const r = normalizeStrategyReport(REPORT, { initial_capital: 0 });

  it('recomputes the same canonical schema the signal engine emits', () => {
    near(r.net_profit, 12);
    near(r.gross_profit, 16);
    near(r.gross_loss, 4);
    near(r.profit_factor, 4);
    assert.equal(r.total_trades, 3);
    assert.equal(r.winning_trades, 2);
    assert.equal(r.losing_trades, 1);
    near(r.win_rate, 2 / 3);
    near(r.avg_trade, 4);
  });

  it('maps the TV trade list into the canonical trade shape', () => {
    assert.equal(r.trades.length, 3);
    assert.deepEqual(
      [r.trades[0].side, r.trades[0].entry_t, r.trades[0].entry_price, r.trades[0].exit_t, r.trades[0].exit_price, r.trades[0].qty, r.trades[0].pnl],
      ['long', 10, 100, 12, 110, 1, 10],
    );
    assert.equal(r.trades[2].side, 'short');
    near(r.trades[2].pnl, 6);
    near(r.trades[0].return_pct, 0.10);
  });

  it('builds a timestamped equity curve from the trades', () => {
    assert.deepEqual(r.equity_curve.map((p) => [p.t, p.equity]), [[10, 0], [12, 10], [14, 6], [16, 12]]);
  });

  it('preserves TV\'s own aggregates under tv_native for cross-check', () => {
    near(r.tv_native.net_profit, 12);
    near(r.tv_native.profit_factor, 4);
    near(r.tv_native.win_rate, 2 / 3);
    near(r.tv_native.max_drawdown, 4);
    near(r.tv_native.max_drawdown_pct, 0.004);
    near(r.tv_native.sharpe_ratio, 1.2);
    assert.equal(r.tv_native.currency, 'USD');
  });

  it('normalizes a percentProfitable given as a percent (>1) to a fraction', () => {
    const rr = normalizeStrategyReport({ ...REPORT, performance: { ...REPORT.performance, all: { ...REPORT.performance.all, percentProfitable: 66.67 } } });
    near(rr.tv_native.win_rate, 0.6667, 1e-3);
  });

  it('normalizes millisecond trade times (TV\'s real format) to seconds', () => {
    const rr = normalizeStrategyReport({
      performance: { all: {} },
      trades: [
        { entry: { type: 'short', value: 290.74, time: 1781098200000 }, exit: { value: 307.48, time: 1782999000000 }, quantity: 2155, profit: { v: -36074.7, p: -0.0576 } },
      ],
    });
    assert.equal(rr.trades[0].entry_t, 1781098200); // ms → s
    assert.equal(rr.trades[0].exit_t, 1782999000);
    assert.equal(rr.equity_curve[0].t, 1781098200); // curve keyed on seconds too
  });

  it('reads the maxStrategyDrawDown key (falls back to maxDrawDown for older TV)', () => {
    near(normalizeStrategyReport(REPORT).tv_native.max_drawdown, 4);
    const legacy = normalizeStrategyReport({ performance: { all: {}, maxDrawDown: 9, maxDrawDownPercent: 0.09 }, trades: [] });
    near(legacy.tv_native.max_drawdown, 9);
    near(legacy.tv_native.max_drawdown_pct, 0.09);
  });

  it('is null-safe on an empty report', () => {
    const rr = normalizeStrategyReport({ performance: {}, trades: [] });
    assert.equal(rr.total_trades, 0);
    assert.equal(rr.win_rate, null);
    assert.deepEqual(rr.trades, []);
  });
});

describe('backtestRunStrategy() — orchestration with injected socket fetch', () => {
  function mockDeps() {
    const deps = {
      fetchStrategyReport: async (opts) => { deps._opts = opts; return { strategyReport: REPORT }; },
    };
    return deps;
  }

  it('passes symbol/timeframe/range/scriptId/token through to the socket layer', async () => {
    const deps = mockDeps();
    const r = await backtestRunStrategy({ scriptId: 'USER;abc', symbol: 'NASDAQ:AAPL', timeframe: '60', range: 300, token: 'tok', signature: 'sig', _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.engine, 'strategy');
    assert.equal(r.script_id, 'USER;abc');
    assert.equal(deps._opts.symbol, 'NASDAQ:AAPL');
    assert.equal(deps._opts.timeframe, '60');
    assert.equal(deps._opts.range, 300);
    assert.equal(deps._opts.indicatorId, 'USER;abc');
    assert.equal(deps._opts.token, 'tok');
    near(r.net_profit, 12);
  });

  it('throws on missing scriptId / symbol / token', async () => {
    const deps = mockDeps();
    await assert.rejects(() => backtestRunStrategy({ symbol: 'X', token: 't', _deps: deps }), /script_id` is required/);
    await assert.rejects(() => backtestRunStrategy({ scriptId: 'USER;x', token: 't', _deps: deps }), /symbol` is required/);
    await assert.rejects(() => backtestRunStrategy({ scriptId: 'USER;x', symbol: 'X', _deps: deps }), /No session token/);
  });
});
