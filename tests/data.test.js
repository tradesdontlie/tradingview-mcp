/**
 * Tests for src/core/data.js strategy/trades/equity functions.
 * Verifies the internal_api → dom_fallback fallback chain, the relaxed
 * is_price_study filter (B11), and the parseReportValue() parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStrategyResults,
  getTrades,
  getEquity,
  parseReportValue,
} from '../src/core/data.js';
import { POPULATED_METRICS } from './fixtures/strategy-report-dom.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Build a mock `evaluate` from an ordered handler list. Each handler is
 * { match: substring|regex, value: any|fn }. First match wins per call.
 * Calls are recorded in fn.calls.
 */
function makeEvaluate(handlers) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    for (const h of handlers) {
      const match = h.match instanceof RegExp ? h.match.test(expr) : expr.includes(h.match);
      if (match) return typeof h.value === 'function' ? h.value(expr) : h.value;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

// ── parseReportValue() ───────────────────────────────────────────────────

describe('parseReportValue()', () => {
  it('parses "+15,437.00USD+1.54%" into value + currency + percent', () => {
    const r = parseReportValue('+15,437.00USD+1.54%');
    assert.equal(r.value, 15437);
    assert.equal(r.currency, 'USD');
    assert.equal(r.percent, 1.54);
    assert.equal(r.raw, '+15,437.00USD+1.54%');
  });

  it('parses negative P&L "-1,234.50USD-2.10%"', () => {
    const r = parseReportValue('-1,234.50USD-2.10%');
    assert.equal(r.value, -1234.5);
    assert.equal(r.currency, 'USD');
    assert.equal(r.percent, -2.10);
  });

  it('parses bare number with thousands separator "7,256.00"', () => {
    const r = parseReportValue('7,256.00');
    assert.equal(r.value, 7256);
    assert.equal(r.currency, undefined);
    assert.equal(r.percent, undefined);
  });

  it('parses integer "748"', () => {
    const r = parseReportValue('748');
    assert.equal(r.value, 748);
  });

  it('parses percent-only "33.29%"', () => {
    const r = parseReportValue('33.29%');
    assert.equal(r.percent, 33.29);
    assert.equal(r.value, undefined);
  });

  it('parses small decimal "1.172"', () => {
    const r = parseReportValue('1.172');
    assert.equal(r.value, 1.172);
  });

  it('handles empty/null safely', () => {
    assert.deepEqual(parseReportValue(''), { raw: '' });
    assert.deepEqual(parseReportValue(null), { raw: '' });
    assert.deepEqual(parseReportValue(undefined), { raw: '' });
  });
});

// ── getStrategyResults() ─────────────────────────────────────────────────

describe('getStrategyResults() — internal_api → dom_fallback', () => {
  it('returns metrics from internal_api when populated', async () => {
    const evaluate = makeEvaluate([
      { match: 'reportData', value: { metrics: { net_profit: 1500, win_rate: 0.45 }, source: 'internal_api' } },
    ]);
    const out = await getStrategyResults({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'internal_api');
    assert.equal(out.metric_count, 2);
    assert.equal(out.metrics.net_profit, 1500);
    // DOM scrape should NOT have run
    assert.ok(!evaluate.calls.some(c => c.includes('reportContainer')), 'DOM scrape skipped on internal_api success');
  });

  it('falls back to dom_fallback when internal_api returns empty', async () => {
    const evaluate = makeEvaluate([
      { match: 'chart.model().model().dataSources', value: { metrics: {}, source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: true, metrics: POPULATED_METRICS, card_count: 5 } },
    ]);
    const out = await getStrategyResults({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'dom_fallback');
    assert.equal(out.metric_count, 5);
    // Parsed structure
    assert.equal(out.metrics['Total P&L'].value, 15437);
    assert.equal(out.metrics['Total P&L'].currency, 'USD');
    assert.equal(out.metrics['Total P&L'].percent, 1.54);
    assert.equal(out.metrics['Profit factor'].value, 1.172);
    assert.equal(out.metrics['Profitable trades'].percent, 33.29);
    // Raw map preserved
    assert.equal(out.metrics_raw['Total trades'], '748');
  });

  it('returns explicit error when BOTH paths fail', async () => {
    const evaluate = makeEvaluate([
      { match: 'chart.model().model().dataSources', value: { metrics: {}, source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: false, error: 'reportContainer not in DOM' } },
    ]);
    const out = await getStrategyResults({ _deps: { evaluate } });
    assert.equal(out.success, false);
    assert.equal(out.source, 'none');
    assert.equal(out.metric_count, 0);
    assert.ok(out.error.includes('internal_api'), 'error mentions internal_api');
    assert.ok(out.error.includes('dom_fallback'), 'error mentions dom_fallback');
    assert.ok(out.error.includes('No strategy found on chart'), 'error includes internal status');
    assert.ok(out.error.includes('reportContainer not in DOM'), 'error includes DOM status');
  });
});

// ── getTrades() ──────────────────────────────────────────────────────────

describe('getTrades() — internal_api → dom_fallback', () => {
  it('returns internal_api trades when populated', async () => {
    const fakeTrades = [{ price: 100, qty: 1 }, { price: 101, qty: 1 }];
    const evaluate = makeEvaluate([
      { match: 'ordersData', value: { trades: fakeTrades, source: 'internal_api' } },
    ]);
    const out = await getTrades({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'internal_api');
    assert.equal(out.trade_count, 2);
  });

  it('falls back to DOM trades table when internal_api empty', async () => {
    const evaluate = makeEvaluate([
      { match: 'chart.model().model().dataSources', value: { trades: [], source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: true, trades: [{ Trade: '1', Type: 'Long', Price: '100.50' }, { Trade: '2', Type: 'Short', Price: '101.25' }], headers: ['Trade', 'Type', 'Price'] } },
    ]);
    const out = await getTrades({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'dom_fallback');
    assert.equal(out.trade_count, 2);
    assert.equal(out.trades[0].Type, 'Long');
  });

  it('returns explicit error when both paths fail', async () => {
    const evaluate = makeEvaluate([
      { match: 'chart.model().model().dataSources', value: { trades: [], source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: false, error: 'trades table not in reportContainer' } },
    ]);
    const out = await getTrades({ _deps: { evaluate } });
    assert.equal(out.success, false);
    assert.equal(out.source, 'none');
    assert.ok(out.error.includes('internal_api'));
    assert.ok(out.error.includes('dom_fallback'));
  });
});

// ── getEquity() ──────────────────────────────────────────────────────────

describe('getEquity() — internal_api → dom_fallback', () => {
  it('returns equity series from internal_api when populated', async () => {
    const series = [{ time: 1, equity: 100 }, { time: 2, equity: 110 }];
    const evaluate = makeEvaluate([
      { match: 'equityData', value: { data: series, source: 'internal_api' } },
    ]);
    const out = await getEquity({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'internal_api');
    assert.equal(out.data_points, 2);
  });

  it('returns internal_api equity_summary when curve empty but summary present', async () => {
    const evaluate = makeEvaluate([
      { match: 'equityData', value: { data: [], equity_summary: { net_profit: 1500 }, source: 'internal_api' } },
    ]);
    const out = await getEquity({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'internal_api');
    assert.equal(out.data_points, 0);
    assert.equal(out.equity_summary.net_profit, 1500);
  });

  it('falls back to DOM summary metrics when internal_api empty', async () => {
    const evaluate = makeEvaluate([
      { match: 'equityData', value: { data: [], equity_summary: null, source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: true, metrics: POPULATED_METRICS } },
    ]);
    const out = await getEquity({ _deps: { evaluate } });
    assert.equal(out.success, true);
    assert.equal(out.source, 'dom_fallback');
    // Equity-related labels should be present (Total P&L, Max equity drawdown)
    assert.ok(out.equity_summary['Total P&L'], 'Total P&L scraped');
    assert.equal(out.equity_summary['Total P&L'].value, 15437);
    assert.ok(out.equity_summary['Max equity drawdown'], 'Max equity drawdown scraped');
    // Unrelated labels (Total trades — no profit/equity/drawdown keyword) filtered out
    assert.equal(out.equity_summary['Total trades'], undefined);
  });

  it('returns error when both paths fail', async () => {
    const evaluate = makeEvaluate([
      { match: 'equityData', value: { data: [], equity_summary: null, source: 'internal_api', error: 'No strategy found on chart.' } },
      { match: 'reportContainer', value: { found: false, error: 'reportContainer not in DOM' } },
    ]);
    const out = await getEquity({ _deps: { evaluate } });
    assert.equal(out.success, false);
    assert.equal(out.source, 'none');
    assert.ok(out.error.includes('internal_api'));
    assert.ok(out.error.includes('dom_fallback'));
  });
});

// ── B11: relaxed is_price_study filter ───────────────────────────────────

describe('B11 — relaxed strategy filter (must accept overlay strategies)', () => {
  it('source code uses !s.metaInfo()?.is_price_study OR strategy-data check', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/core/data.js', import.meta.url), 'utf8');
    // The old weak filter should be gone
    assert.ok(!src.includes('is_price_study === false'), 'old strict equality filter removed');
    // New filter should accept data sources that have strategy-related fields
    assert.ok(src.includes('reportData') && src.includes('ordersData') && src.includes('equityData'), 'filter checks for strategy-data fields');
    // Should accept !is_price_study (relaxed form)
    assert.ok(/is_price_study/.test(src), 'still references is_price_study');
  });
});
