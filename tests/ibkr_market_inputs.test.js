// Phase 2C.1 — tests for the IBKR Client Portal adapter (pure parsers +
// orchestration against an injected fake HTTP client) and the provider-
// precedence/confidence logic. No live IBKR authentication required
// anywhere — every network-shaped call here uses a frozen in-memory fake.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIbkrFeeRate, parseIbkrExpectedDividend, normalizeMarketDataAvailability,
  classifyShortableStatus, probeIbkrConnection, makeConidResolver, snapshotWithPreflight,
  fetchIbkrMarketInputs, CONNECTION_STATUS, IBKR_FIELDS,
} from '../src/providers/ibkr/ibkrMarketInputsProvider.js';
import { resolveBaseUrl } from '../src/providers/ibkr/clientPortalClient.js';
import { resolveDividendWithPrecedence, resolveBorrowWithPrecedence, classifyShadowMarketInputConfidence } from '../src/core/options/marketInputs/marketInputPrecedence.js';
import { computeEffectiveCarryYield, buildShadowSnapshotId } from '../src/core/options/marketInputs/productionMarketInputs.js';
import { priceCrrAmerican } from '../src/core/options/pricing/crrAmerican.js';

describe('resolveBaseUrl', () => {
  it('defaults to localhost:5000 but honors IBKR_API_BASE_URL', () => {
    assert.equal(resolveBaseUrl({}), 'https://localhost:5000/v1/api');
    assert.equal(resolveBaseUrl({ IBKR_API_BASE_URL: 'https://localhost:5001/v1/api' }), 'https://localhost:5001/v1/api');
  });
});

describe('parseIbkrFeeRate — Step 8', () => {
  it('parses a percentage string', () => {
    assert.deepEqual(parseIbkrFeeRate('0.25%'), { value: 0.0025, present: true });
  });
  it('parses a bare numeric string as percentage points', () => {
    assert.deepEqual(parseIbkrFeeRate('1.5'), { value: 0.015, present: true });
  });
  it('parses a numeric value', () => {
    assert.deepEqual(parseIbkrFeeRate(0.5), { value: 0.005, present: true });
  });
  it('null/empty/N-A all resolve to not-present, never a fabricated 0', () => {
    assert.deepEqual(parseIbkrFeeRate(null), { value: null, present: false });
    assert.deepEqual(parseIbkrFeeRate(''), { value: null, present: false });
    assert.deepEqual(parseIbkrFeeRate('N/A'), { value: null, present: false });
    assert.deepEqual(parseIbkrFeeRate('n/a'), { value: null, present: false });
  });
  it('a genuine reported zero stays 0 and present:true, distinct from missing', () => {
    assert.deepEqual(parseIbkrFeeRate('0'), { value: 0, present: true });
    assert.deepEqual(parseIbkrFeeRate(0), { value: 0, present: true });
  });
  it('unexpected garbage resolves to not-present rather than throwing', () => {
    assert.deepEqual(parseIbkrFeeRate('garbage'), { value: null, present: false });
    assert.deepEqual(parseIbkrFeeRate({}), { value: null, present: false });
    assert.deepEqual(parseIbkrFeeRate(undefined), { value: null, present: false });
  });
});

describe('parseIbkrExpectedDividend — Step 12-13', () => {
  it('parses a numeric forward dividend', () => {
    assert.deepEqual(parseIbkrExpectedDividend('1.08'), { value: 1.08, present: true });
  });
  it('a genuine reported zero is distinct from missing', () => {
    assert.deepEqual(parseIbkrExpectedDividend(0), { value: 0, present: true });
    assert.deepEqual(parseIbkrExpectedDividend(null), { value: null, present: false });
  });
});

describe('normalizeMarketDataAvailability — Step 6', () => {
  it('maps known codes and preserves raw', () => {
    assert.deepEqual(normalizeMarketDataAvailability('R'), { normalized: 'REALTIME', raw: 'R' });
    assert.deepEqual(normalizeMarketDataAvailability('D'), { normalized: 'DELAYED', raw: 'D' });
    assert.deepEqual(normalizeMarketDataAvailability('Z'), { normalized: 'FROZEN', raw: 'Z' });
  });
  it('unknown/missing never claims REALTIME', () => {
    assert.equal(normalizeMarketDataAvailability(null).normalized, 'UNKNOWN');
    assert.equal(normalizeMarketDataAvailability('X').normalized, 'UNKNOWN');
  });
});

describe('classifyShortableStatus — Step 11 (diagnostic only)', () => {
  it('classifies available/constrained/unknown without manufacturing a price premium', () => {
    assert.equal(classifyShortableStatus({ shortableShares: 500000, shortableCode: '2' }), 'BORROW_AVAILABLE');
    assert.equal(classifyShortableStatus({ shortableShares: 0, shortableCode: '1' }), 'BORROW_CONSTRAINED');
    assert.equal(classifyShortableStatus({ shortableShares: null, shortableCode: null }), 'BORROW_STATUS_UNKNOWN');
  });
});

// --- Orchestration against an injected fake client --------------------------

function fakeClient(overrides = {}) {
  return {
    getAuthStatus: async () => ({ ok: true, body: { authenticated: true } }),
    searchStock: async () => ({ ok: true, body: [{ symbol: 'NVDA', secType: 'STK', conid: 4815747, currency: 'USD', listingExchange: 'NASDAQ' }] }),
    getSnapshot: async () => ({ ok: true, body: [{ [IBKR_FIELDS.FEE_RATE]: '0.25%', [IBKR_FIELDS.DIVIDENDS_12M]: '0.16', [IBKR_FIELDS.SHORTABLE_SHARES]: 1000000, [IBKR_FIELDS.SHORTABLE]: '2', [IBKR_FIELDS.MARKET_DATA_AVAILABILITY]: 'R', _updated: 1735000000000 }] }),
    ...overrides,
  };
}

describe('probeIbkrConnection — Step 3', () => {
  it('CONNECTED when authenticated', async () => {
    const r = await probeIbkrConnection(fakeClient());
    assert.equal(r.status, CONNECTION_STATUS.CONNECTED);
  });
  it('AUTH_REQUIRED when session is not authenticated, never throws', async () => {
    const client = fakeClient({ getAuthStatus: async () => ({ ok: true, body: { authenticated: false, message: 'please log in' } }) });
    const r = await probeIbkrConnection(client);
    assert.equal(r.status, CONNECTION_STATUS.AUTH_REQUIRED);
  });
  it('UNAVAILABLE on network failure/timeout, never throws (no gateway running)', async () => {
    const client = fakeClient({ getAuthStatus: async () => ({ ok: false, error: 'TIMEOUT' }) });
    const r = await probeIbkrConnection(client);
    assert.equal(r.status, CONNECTION_STATUS.UNAVAILABLE);
  });
});

describe('makeConidResolver — Step 4', () => {
  it('resolves and caches a STK conid, never an option conid', async () => {
    let calls = 0;
    const client = fakeClient({ searchStock: async () => { calls++; return { ok: true, body: [{ symbol: 'NVDA', secType: 'OPT', conid: 999 }, { symbol: 'NVDA', secType: 'STK', conid: 4815747, currency: 'USD' }] }; } });
    const resolve = makeConidResolver(client);
    const r1 = await resolve('NVDA');
    const r2 = await resolve('NVDA'); // cached, second call should not hit the network again
    assert.equal(r1.conid, 4815747);
    assert.deepEqual(r1, r2);
    assert.equal(calls, 1);
  });
  it('reports NO_STOCK_MATCH rather than fabricating a conid', async () => {
    const client = fakeClient({ searchStock: async () => ({ ok: true, body: [] }) });
    const r = await makeConidResolver(client)('NOPE');
    assert.equal(r.conid, null);
    assert.equal(r.error, 'NO_STOCK_MATCH');
  });
});

describe('snapshotWithPreflight — Step 5', () => {
  it('delivers on the second call after an initial empty snapshot, no background polling', async () => {
    let call = 0;
    const client = { getSnapshot: async () => { call++; return call === 1 ? { ok: true, body: [{}] } : { ok: true, body: [{ [IBKR_FIELDS.FEE_RATE]: '0.25%' }] }; } };
    const r = await snapshotWithPreflight(client, 123, [IBKR_FIELDS.FEE_RATE], { sleep: async () => {} });
    assert.equal(r.complete, true);
    assert.equal(r.attempts, 2);
    assert.equal(call, 2);
  });
  it('stops at maxAttempts and reports incomplete rather than hanging forever', async () => {
    const client = { getSnapshot: async () => ({ ok: true, body: [{}] }) };
    const r = await snapshotWithPreflight(client, 123, [IBKR_FIELDS.FEE_RATE], { maxAttempts: 3, sleep: async () => {} });
    assert.equal(r.complete, false);
    assert.equal(r.attempts, 3);
  });
});

describe('fetchIbkrMarketInputs — full orchestration', () => {
  it('returns a normalized result on a healthy connection', async () => {
    const r = await fetchIbkrMarketInputs(fakeClient(), 'NVDA');
    assert.equal(r.connection_status, 'CONNECTED');
    assert.equal(r.fee_rate, 0.0025);
    assert.equal(r.expected_12m_dividend_per_share, 0.16);
    assert.equal(r.market_data_availability, 'REALTIME');
    assert.equal(r.shortable_status, 'BORROW_AVAILABLE');
  });

  it('returns IBKR_AUTH_REQUIRED without throwing, letting the shadow workflow continue', async () => {
    const client = fakeClient({ getAuthStatus: async () => ({ ok: true, body: { authenticated: false } }) });
    const r = await fetchIbkrMarketInputs(client, 'NVDA');
    assert.equal(r.connection_status, 'AUTH_REQUIRED');
    assert.ok(r.warnings.includes('IBKR_AUTH_REQUIRED'));
    assert.equal(r.fee_rate, null);
  });

  it('returns UNAVAILABLE without throwing when no gateway is reachable', async () => {
    const client = fakeClient({ getAuthStatus: async () => ({ ok: false, error: 'NETWORK_ERROR' }) });
    const r = await fetchIbkrMarketInputs(client, 'NVDA');
    assert.equal(r.connection_status, 'UNAVAILABLE');
    assert.ok(r.warnings.includes('IBKR_UNAVAILABLE'));
  });

  it('flags FORWARD_DIVIDEND_ZERO_REPORTED for a genuine reported zero, distinct from unavailable', async () => {
    const client = fakeClient({ getSnapshot: async () => ({ ok: true, body: [{ [IBKR_FIELDS.DIVIDENDS_12M]: 0, [IBKR_FIELDS.FEE_RATE]: '0.10%', [IBKR_FIELDS.SHORTABLE_SHARES]: 0, [IBKR_FIELDS.SHORTABLE]: '1', [IBKR_FIELDS.MARKET_DATA_AVAILABILITY]: 'R' }] }) });
    const r = await fetchIbkrMarketInputs(client, 'NVDA');
    assert.equal(r.expected_12m_dividend_per_share, 0);
    assert.equal(r.dividend_present, true);
    assert.ok(r.warnings.includes('FORWARD_DIVIDEND_ZERO_REPORTED'));
  });

  it('flags non-realtime market data rather than presenting it as live', async () => {
    const client = fakeClient({ getSnapshot: async () => ({ ok: true, body: [{ [IBKR_FIELDS.FEE_RATE]: '0.25%', [IBKR_FIELDS.DIVIDENDS_12M]: '0.1', [IBKR_FIELDS.SHORTABLE_SHARES]: 100, [IBKR_FIELDS.SHORTABLE]: '2', [IBKR_FIELDS.MARKET_DATA_AVAILABILITY]: 'D' }] }) });
    const r = await fetchIbkrMarketInputs(client, 'NVDA');
    assert.equal(r.market_data_availability, 'DELAYED');
    assert.ok(r.warnings.includes('IBKR_MARKET_DATA_NOT_REALTIME'));
  });
});

// --- Provider precedence (Step 14) + confidence (Step 15) -------------------

describe('resolveDividendWithPrecedence', () => {
  it('prefers IBKR forward dividend when present and positive', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: { dividend_present: true, expected_12m_dividend_per_share: 2, as_of_utc: 't' }, tvTrailingYieldPct: 0.5 });
    assert.equal(r.mode, 'FORWARD_ANNUAL_DIVIDEND_APPROXIMATION');
    assert.equal(r.annualized_yield, 0.02);
    assert.equal(r.source, 'IBKR_FORWARD_12M_DIVIDEND');
  });

  it('an IBKR-reported zero without corroboration stays FORWARD_DIVIDEND_ZERO_REPORTED, not auto-promoted', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: { dividend_present: true, expected_12m_dividend_per_share: 0, as_of_utc: 't' }, tvTrailingYieldPct: null });
    assert.equal(r.mode, 'FORWARD_DIVIDEND_ZERO_REPORTED');
    assert.notEqual(r.mode, 'ZERO_DIVIDEND_CONFIRMED');
  });

  it('an IBKR-reported zero WITH a documented source promotes to ZERO_DIVIDEND_CONFIRMED', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: { dividend_present: true, expected_12m_dividend_per_share: 0, as_of_utc: 't' }, documentedZeroSource: 'DOCUMENTED_NO_DIVIDEND' });
    assert.equal(r.mode, 'ZERO_DIVIDEND_CONFIRMED');
  });

  it('falls back to TradingView trailing yield when IBKR is unavailable', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: null, tvTrailingYieldPct: 0.33 });
    assert.equal(r.mode, 'TRAILING_DIVIDEND_YIELD_APPROXIMATION');
  });

  it('falls back to documented zero when neither IBKR nor TV yield is available', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: null, tvTrailingYieldPct: null, documentedZeroSource: 'DOCUMENTED_NO_DIVIDEND' });
    assert.equal(r.mode, 'ZERO_DIVIDEND_CONFIRMED');
  });

  it('DIVIDEND_DATA_UNAVAILABLE when nothing at all is available', () => {
    const r = resolveDividendWithPrecedence({ spot: 100, ibkrResult: null, tvTrailingYieldPct: null });
    assert.equal(r.mode, 'DIVIDEND_DATA_UNAVAILABLE');
  });
});

describe('resolveBorrowWithPrecedence', () => {
  it('uses IBKR fee rate, labeled IBKR_FEE_RATE with borrow-proxy limitation warnings', () => {
    const r = resolveBorrowWithPrecedence({ ibkrResult: { fee_rate_present: true, fee_rate: 0.0025, market_data_availability: 'REALTIME', shortable_status: 'BORROW_AVAILABLE' } });
    assert.equal(r.fee_rate, 0.0025);
    assert.equal(r.source, 'IBKR_FEE_RATE');
    assert.ok(r.warnings.includes('BORROW_PROXY_IBKR_FEE_RATE'));
    assert.ok(r.warnings.includes('IBKR_FEE_RATE_NOT_NET_SHORT_FINANCING_COST'));
  });

  it('unavailable when IBKR did not report a fee rate', () => {
    const r = resolveBorrowWithPrecedence({ ibkrResult: null });
    assert.equal(r.fee_rate, null);
    assert.ok(r.warnings.includes('BORROW_DATA_UNAVAILABLE'));
  });
});

describe('classifyShadowMarketInputConfidence — Step 15', () => {
  it('HIGH requires discount + borrow + non-LOW dividend + realtime data', () => {
    assert.equal(classifyShadowMarketInputConfidence({ discountAvailable: true, dividendConfidence: 'MEDIUM', borrowPresent: true, marketDataAvailability: 'REALTIME' }), 'HIGH');
  });
  it('MEDIUM when borrow missing but discount+dividend available', () => {
    assert.equal(classifyShadowMarketInputConfidence({ discountAvailable: true, dividendConfidence: 'MEDIUM', borrowPresent: false, marketDataAvailability: null }), 'MEDIUM');
  });
  it('LOW when discount unavailable or dividend confidence missing', () => {
    assert.equal(classifyShadowMarketInputConfidence({ discountAvailable: false, dividendConfidence: 'MEDIUM', borrowPresent: true }), 'LOW');
    assert.equal(classifyShadowMarketInputConfidence({ discountAvailable: true, dividendConfidence: null, borrowPresent: true }), 'LOW');
  });
});

// --- Step 16: carry sign convention (IBKR-labeled borrow component) --------

describe('Step 16 — carry convention with IBKR-labeled borrow component', () => {
  it('positive IBKR borrow proxy lowers synthetic-forward-driven call value and raises put value, same direction as dividend', () => {
    const base = { spot: 100, strike: 100, time_to_expiry_years: 0.25, volatility: 0.3, risk_free_rate: 0.04, steps: 200 };
    const qNoBorrow = computeEffectiveCarryYield({ dividendYield: 0.01, borrowFeeRate: 0 });
    const qWithBorrow = computeEffectiveCarryYield({ dividendYield: 0.01, borrowFeeRate: 0.02 });
    const callNoBorrow = priceCrrAmerican({ ...base, option_type: 'call', dividend_yield: qNoBorrow }).price;
    const callWithBorrow = priceCrrAmerican({ ...base, option_type: 'call', dividend_yield: qWithBorrow }).price;
    assert.ok(callWithBorrow < callNoBorrow);
    const putNoBorrow = priceCrrAmerican({ ...base, option_type: 'put', dividend_yield: qNoBorrow }).price;
    const putWithBorrow = priceCrrAmerican({ ...base, option_type: 'put', dividend_yield: qWithBorrow }).price;
    assert.ok(putWithBorrow > putNoBorrow);
  });
});

describe('buildShadowSnapshotId — Step 21', () => {
  it('is deterministic for identical normalized inputs', () => {
    const inputs = { symbol: 'NVDA', discount_rate: 0.04, effective_carry_yield: 0.01, dte: 40 };
    assert.equal(buildShadowSnapshotId(inputs), buildShadowSnapshotId({ ...inputs }));
  });
  it('changes when inputs change', () => {
    const a = buildShadowSnapshotId({ symbol: 'NVDA', discount_rate: 0.04 });
    const b = buildShadowSnapshotId({ symbol: 'NVDA', discount_rate: 0.05 });
    assert.notEqual(a, b);
  });
});
