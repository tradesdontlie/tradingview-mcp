/**
 * Unit tests for strategy-results extraction logic (data_get_strategy_results).
 * No TradingView connection needed — exercises the pure helpers directly.
 *
 * Fixture shape captured live from TradingView Desktop 3.2.0 (new strategy tester):
 *   dataSource.reportData() === { currency, trades, filledOrders, buyHoldPercent,
 *                                 settings, performance: { <scalars>, all, long, short } }
 *   dataSource.performance() === null  (NOT the metrics source in the new tester)
 *
 * Run: node --test tests/strategy_results.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findStrategySource,
  flattenStrategyReport,
  getStrategyResults,
} from '../src/core/data.js';

// ── Fixture: real report shape from a live MA-cross strategy on BTCUSDT.P 60m ──
const REAL_PERFORMANCE = {
  // top-level scalar metrics
  maxStrategyDrawDown: 6531.179023799979,
  openPL: 0,
  buyHoldReturn: 4250.5576191,
  sharpeRatio: 0.05490388357994154,
  sortinoRatio: 0.09152865649589953,
  maxStrategyDrawDownPercent: 0.385925896387918,
  maxStrategyRunUp: 7839.5670689,
  maxMarginUsed: 17288.91382,
  avgMarginUsed: 6231.811589,
  // per-side buckets
  all: {
    netProfit: 734.0950199000217,
    netProfitPercent: 0.07340950199000218,
    grossProfit: 40034.53835990002,
    grossLoss: 39300.44334,
    profitFactor: 1.0186790518760602,
    percentProfitable: 0.327455919395466,
    totalTrades: 397,
    numberOfWiningTrades: 130,
    numberOfLosingTrades: 267,
    avgTrade: 1.849105844,
    commissionPaid: 0,
  },
  long: {
    netProfit: 734.0950199000217,
    totalTrades: 397,
    profitFactor: 1.0186790518760602,
    percentProfitable: 0.327455919395466,
  },
  short: {
    netProfit: 0,
    totalTrades: 0,
    profitFactor: 0,
    percentProfitable: 0,
  },
};

const RAW = { currency: 'USDT', tradesCount: 397, performance: REAL_PERFORMANCE };

// ── flattenStrategyReport() ────────────────────────────────────────────────
describe('flattenStrategyReport()', () => {
  it('extracts headline metrics from the "all" bucket, unprefixed', () => {
    const m = flattenStrategyReport(RAW);
    assert.equal(m.netProfit, 734.0950199000217);
    assert.equal(m.profitFactor, 1.0186790518760602);
    assert.equal(m.percentProfitable, 0.327455919395466);
    assert.equal(m.totalTrades, 397);
  });

  it('includes top-level performance scalars (sharpe, sortino, drawdown)', () => {
    const m = flattenStrategyReport(RAW);
    assert.equal(m.sharpeRatio, 0.05490388357994154);
    assert.equal(m.sortinoRatio, 0.09152865649589953);
    assert.equal(m.maxStrategyDrawDown, 6531.179023799979);
  });

  it('prefixes long/short bucket metrics', () => {
    const m = flattenStrategyReport(RAW);
    assert.equal(m.long_netProfit, 734.0950199000217);
    assert.equal(m.short_totalTrades, 0);
    assert.equal(m.short_netProfit, 0);
  });

  it('includes currency and tradesCount', () => {
    const m = flattenStrategyReport(RAW);
    assert.equal(m.currency, 'USDT');
    assert.equal(m.tradesCount, 397);
  });

  it('emits only scalar values — never nested objects or arrays', () => {
    const m = flattenStrategyReport(RAW);
    for (const [k, v] of Object.entries(m)) {
      const t = typeof v;
      assert.ok(
        t === 'number' || t === 'string' || t === 'boolean',
        `metric ${k} must be scalar, got ${t}`
      );
    }
  });

  it('returns an empty object for missing/blank input', () => {
    assert.deepEqual(flattenStrategyReport(null), {});
    assert.deepEqual(flattenStrategyReport({}), {});
    assert.deepEqual(flattenStrategyReport({ performance: null }), {});
  });
});

// ── findStrategySource() ─────────────────────────────────────────────────────
describe('findStrategySource()', () => {
  // A real strategy: overlay (is_price_study === true) exposing reportData()
  const overlayStrategy = {
    metaInfo: () => ({ is_price_study: true, description: 'MCP Test Strategy' }),
    reportData: () => ({ performance: {} }),
    performance: () => null,
  };
  // A non-strategy study (e.g. Volume): performance() exists on EVERY study,
  // is_price_study === false, but no reportData/ordersData.
  const volumeLike = {
    metaInfo: () => ({ is_price_study: false, description: 'Volume' }),
    performance: () => null,
  };

  it('selects an overlay strategy (is_price_study true) — regression for the is_price_study filter bug', () => {
    assert.equal(findStrategySource([volumeLike, overlayStrategy]), overlayStrategy);
  });

  it('does NOT select a study that only has performance() — regression for the performance-discriminator bug', () => {
    assert.equal(findStrategySource([volumeLike]), null);
  });

  it('matches on ordersData when reportData is absent', () => {
    const ordersOnly = { metaInfo: () => ({ is_price_study: true }), ordersData: () => [] };
    assert.equal(findStrategySource([volumeLike, ordersOnly]), ordersOnly);
  });

  it('returns null when no strategy is present', () => {
    assert.equal(findStrategySource([volumeLike, { metaInfo: () => ({}) }]), null);
  });
});

// ── getStrategyResults() glue (mocked evaluate) ──────────────────────────────
describe('getStrategyResults() — wiring', () => {
  function depsReturning(value) {
    return { _deps: { evaluate: async () => value } };
  }

  it('flattens the raw payload returned by the browser into metric_count + metrics', async () => {
    const res = await getStrategyResults(depsReturning(RAW));
    assert.equal(res.success, true);
    assert.equal(res.source, 'internal_api');
    assert.ok(res.metric_count > 10, `expected many metrics, got ${res.metric_count}`);
    assert.equal(res.metrics.netProfit, 734.0950199000217);
    assert.equal(res.metrics.currency, 'USDT');
  });

  it('surfaces the no-strategy error with zero metrics', async () => {
    const res = await getStrategyResults(depsReturning({ error: 'No strategy found on chart. Add a strategy indicator first.' }));
    assert.equal(res.success, true);
    assert.equal(res.metric_count, 0);
    assert.match(res.error, /No strategy found/);
  });
});
