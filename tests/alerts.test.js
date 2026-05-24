/**
 * Tests for src/core/alerts.js — the REST-based pricealerts integration.
 *
 * No live TradingView required: every test injects a mock evaluate/evaluateAsync
 * via _deps and asserts the URL + body the module would send.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, list, deleteAlerts, buildPayload } from '../src/core/alerts.js';

const CREATE_URL = 'https://pricealerts.tradingview.com/create_alert';
const DELETE_URL = 'https://pricealerts.tradingview.com/delete_alerts';
const LIST_URL = 'https://pricealerts.tradingview.com/list_alerts';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockDeps({ chartSymbol = 'BATS:RDDT', chartResolution = '1', restResponse } = {}) {
  const calls = { evaluate: [], evaluateAsync: [] };

  const evaluate = async (expr) => {
    calls.evaluate.push(expr);
    // Chart-context reads — return symbol + resolution.
    if (expr.includes('chart.symbol()') && expr.includes('chart.resolution()')) {
      return { symbol: chartSymbol, resolution: chartResolution };
    }
    return undefined;
  };

  const evaluateAsync = async (expr) => {
    calls.evaluateAsync.push(expr);
    return restResponse ?? { status: 200, body: JSON.stringify({ s: 'ok', r: { id: 12345 } }) };
  };

  return { deps: { evaluate, evaluateAsync }, calls };
}

function extractFetchUrl(expr) {
  const m = expr.match(/fetch\((['"])(.+?)\1/);
  return m && m[2];
}

function extractFetchBody(expr) {
  // body: "..." in the IIFE — safeString uses JSON.stringify so the outer
  // wrapper is a JSON-escaped string literal. Pull it out via JSON.parse on the
  // first balanced-quoted body: token.
  const m = expr.match(/body:\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

// ── buildPayload() — pure shape contract ─────────────────────────────────

describe('buildPayload() — pricealerts shape contract', () => {
  it('wraps payload in { payload: { ... } }', () => {
    const p = buildPayload({ symbol: 'NASDAQ:AAPL', price: 200, resolution: '1', frequency: 'on_first_fire', expirationDays: 30 });
    assert.ok(p.payload, 'top-level "payload" wrapper required');
  });

  it('uses plural "conditions" as an array with cross + barset + value series', () => {
    const p = buildPayload({ symbol: 'NASDAQ:AAPL', price: 199.5, resolution: '5', frequency: 'on_first_fire', expirationDays: 30 });
    assert.ok(Array.isArray(p.payload.conditions), 'conditions must be plural array');
    assert.equal(p.payload.conditions.length, 1);
    const c = p.payload.conditions[0];
    assert.equal(c.type, 'cross');
    assert.equal(c.frequency, 'on_first_fire');
    assert.deepEqual(c.series[0], { type: 'barset' });
    assert.deepEqual(c.series[1], { type: 'value', value: 199.5 });
    assert.equal(c.resolution, '5');
  });

  it('symbol is "=" + JSON.stringify({adjustment, currency-id, session, symbol}) — plain symbol gets rejected by TV', () => {
    const p = buildPayload({ symbol: 'BATS:RDDT', price: 140, resolution: '1', frequency: 'on_first_fire', expirationDays: 30 });
    assert.ok(p.payload.symbol.startsWith('='), 'symbol must be prefixed with =');
    const inner = JSON.parse(p.payload.symbol.slice(1));
    assert.equal(inner.symbol, 'BATS:RDDT');
    assert.equal(inner.adjustment, 'splits');
    assert.equal(inner['currency-id'], 'USD');
    assert.equal(inner.session, 'extended');
  });

  it('expiration is an ISO 8601 string offset by expirationDays', () => {
    const p = buildPayload({ symbol: 'X', price: 1, resolution: '1', frequency: 'on_first_fire', expirationDays: 7 });
    const exp = new Date(p.payload.expiration);
    const delta = exp.getTime() - Date.now();
    const expectedMs = 7 * 86400 * 1000;
    assert.ok(Math.abs(delta - expectedMs) < 5000, 'expiration ~7 days from now');
  });

  it('falls back to "<symbol> crossing <price>" message when none given', () => {
    const p = buildPayload({ symbol: 'NYSE:F', price: 10, resolution: '1', frequency: 'on_first_fire', expirationDays: 30 });
    assert.equal(p.payload.message, 'NYSE:F crossing 10');
  });

  it('uses caller-supplied message when given', () => {
    const p = buildPayload({ symbol: 'X', price: 1, message: 'breakout', resolution: '1', frequency: 'on_first_fire', expirationDays: 30 });
    assert.equal(p.payload.message, 'breakout');
  });
});

// ── create() ─────────────────────────────────────────────────────────────

describe('create() — REST endpoint integration', () => {
  it('POSTs to /create_alert with the buildPayload() body and no Content-Type header', async () => {
    const { deps, calls } = mockDeps();
    await create({ price: 140.65, _deps: deps });
    assert.equal(calls.evaluateAsync.length, 1);
    const expr = calls.evaluateAsync[0];
    assert.equal(extractFetchUrl(expr), CREATE_URL);
    assert.ok(!/Content-Type/i.test(expr), 'must NOT set Content-Type — triggers CORS preflight');
    const body = extractFetchBody(expr);
    const parsed = JSON.parse(body);
    assert.ok(parsed.payload, 'body wrapped in {payload}');
    assert.equal(parsed.payload.conditions[0].series[1].value, 140.65);
  });

  it('defaults symbol + resolution from the active chart when omitted', async () => {
    const { deps, calls } = mockDeps({ chartSymbol: 'NASDAQ:NVDA', chartResolution: '15' });
    const r = await create({ price: 215, _deps: deps });
    assert.equal(r.symbol, 'NASDAQ:NVDA');
    assert.equal(r.resolution, '15');
    assert.ok(calls.evaluate.some(e => e.includes('chart.symbol()')), 'reads chart context');
  });

  it('honors explicit symbol + resolution without reading the chart', async () => {
    const { deps, calls } = mockDeps();
    const r = await create({ price: 100, symbol: 'BINANCE:BTCUSDT', resolution: '60', _deps: deps });
    assert.equal(r.symbol, 'BINANCE:BTCUSDT');
    assert.equal(r.resolution, '60');
    assert.equal(calls.evaluate.length, 0, 'no chart read needed when both are supplied');
  });

  it('caps expiration_days at 60 (TradingView hard limit)', async () => {
    const { deps } = mockDeps();
    const r = await create({ price: 1, expiration_days: 365, _deps: deps });
    assert.equal(r.expiration_days, 60);
  });

  it('clamps expiration_days below 1 up to 1', async () => {
    const { deps } = mockDeps();
    const r = await create({ price: 1, expiration_days: 0, _deps: deps });
    assert.equal(r.expiration_days, 1);
  });

  it('throws on non-finite price', async () => {
    const { deps } = mockDeps();
    await assert.rejects(create({ price: 'banana', _deps: deps }), /price must be a finite number/);
  });

  it('returns alert_id from a successful response', async () => {
    const { deps } = mockDeps({ restResponse: { status: 200, body: JSON.stringify({ s: 'ok', r: { id: 999888 } }) } });
    const r = await create({ price: 1, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.alert_id, 999888);
    assert.equal(r.error, null);
  });

  it('surfaces TradingView errmsg + err.code on rejection (e.g. quota exceeded)', async () => {
    const { deps } = mockDeps({
      restResponse: {
        status: 200,
        body: JSON.stringify({ s: 'error', errmsg: 'code=max_primitive_alerts_count_exceeded', err: { code: 'max_primitive_alerts_count_exceeded' } }),
      },
    });
    const r = await create({ price: 1, _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /max_primitive_alerts_count_exceeded/);
    assert.equal(r.err_code, 'max_primitive_alerts_count_exceeded');
  });

  it('surfaces network errors (e.g. CORS preflight failure) cleanly', async () => {
    const { deps } = mockDeps({ restResponse: { error: 'Failed to fetch' } });
    const r = await create({ price: 1, _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.error, 'Failed to fetch');
  });
});

// ── deleteAlerts() ───────────────────────────────────────────────────────

describe('deleteAlerts() — REST bulk delete', () => {
  it('POSTs to /delete_alerts with { payload: { alert_ids: [...] } }', async () => {
    const { deps, calls } = mockDeps();
    await deleteAlerts({ alert_id: 12345, _deps: deps });
    assert.equal(calls.evaluateAsync.length, 1);
    const expr = calls.evaluateAsync[0];
    assert.equal(extractFetchUrl(expr), DELETE_URL);
    const parsed = JSON.parse(extractFetchBody(expr));
    assert.deepEqual(parsed, { payload: { alert_ids: [12345] } });
  });

  it('accepts a single alert_id and a list of alert_ids together (merged + deduplicated by caller)', async () => {
    const { deps, calls } = mockDeps();
    await deleteAlerts({ alert_id: 3, alert_ids: [1, 2], _deps: deps });
    const parsed = JSON.parse(extractFetchBody(calls.evaluateAsync[0]));
    assert.deepEqual(parsed.payload.alert_ids, [1, 2, 3]);
  });

  it('with delete_all=true lists first then bulk-deletes every returned id', async () => {
    // list() expression runs the whole fetch+map chain in the browser and resolves
    // to { alerts: [...] }, not the raw {status, body} envelope used by create/delete.
    let callIdx = 0;
    const deps = {
      evaluate: async () => undefined,
      evaluateAsync: async (expr) => {
        callIdx += 1;
        if (callIdx === 1) {
          assert.equal(extractFetchUrl(expr), LIST_URL);
          return { alerts: [{ alert_id: 1, symbol: 'A' }, { alert_id: 2, symbol: 'B' }] };
        }
        assert.equal(extractFetchUrl(expr), DELETE_URL);
        const parsed = JSON.parse(extractFetchBody(expr));
        assert.deepEqual(parsed.payload.alert_ids, [1, 2]);
        return { status: 200, body: JSON.stringify({ s: 'ok', r: null }) };
      },
    };
    const r = await deleteAlerts({ delete_all: true, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 2);
  });

  it('returns deleted_count: 0 without calling the API when delete_all finds no alerts', async () => {
    let deleteCalled = false;
    const deps = {
      evaluate: async () => undefined,
      evaluateAsync: async (expr) => {
        if (extractFetchUrl(expr) === DELETE_URL) { deleteCalled = true; return { status: 200, body: '{"s":"ok"}' }; }
        return { alerts: [] };
      },
    };
    const r = await deleteAlerts({ delete_all: true, _deps: deps });
    assert.equal(r.deleted_count, 0);
    assert.equal(deleteCalled, false);
  });

  it('throws when called without alert_id, alert_ids, or delete_all', async () => {
    const { deps } = mockDeps();
    await assert.rejects(deleteAlerts({ _deps: deps }), /requires alert_id, alert_ids, or delete_all=true/);
  });

  it('throws on non-finite ids before sending the request', async () => {
    const { deps, calls } = mockDeps();
    await assert.rejects(deleteAlerts({ alert_id: 'banana', _deps: deps }), /alert_id must be a finite number/);
    assert.equal(calls.evaluateAsync.length, 0, 'no request sent on invalid input');
  });

  it('surfaces TradingView errmsg on rejection', async () => {
    const { deps } = mockDeps({ restResponse: { status: 200, body: JSON.stringify({ s: 'error', errmsg: 'code=no_such_alert', err: { code: 'no_such_alert' } }) } });
    const r = await deleteAlerts({ alert_id: 1, _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /no_such_alert/);
    assert.equal(r.err_code, 'no_such_alert');
  });
});

// ── list() ───────────────────────────────────────────────────────────────

describe('list() — alert listing', () => {
  it('reports source: internal_api', async () => {
    const deps = {
      evaluate: async () => undefined,
      evaluateAsync: async () => ({ alerts: [] }),
    };
    const r = await list({ _deps: deps });
    assert.equal(r.source, 'internal_api');
    assert.equal(r.alert_count, 0);
  });
});
