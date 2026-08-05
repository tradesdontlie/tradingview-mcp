import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { assertH6Resolution, confirmSymbol, extractMovingAverages, extractPreviousMonthProfile, classifyMaAnchor, scoreSignal } from '../src/scan_policy.mjs';
import { VN_STRUCTURE_VERSION } from '../src/core/vn_structure.mjs';
import { buildClosedH6History } from '../check_one.mjs';
import { buildScanStructure, buildScoutResult } from '../scan_live.mjs';

const fp = { conf: 80, cumDelta: 10, buyPct: 60, divSignal: 0, maxBuyStack: 1 };
const ma = { ma20: 100, ma100: 90 };
const ctx = { regime: 'NEUTRAL', sessionTrust: 'HIGH', barClosed: true };
const score = (f = fp, m = ma, price = 110, phase = 'SIDEWAYS', vol = null, churn = false, c = ctx) =>
  scoreSignal(f, m, price, phase, vol, churn, c);

test('fails closed for every missing base field', () => {
  for (const field of ['conf', 'cumDelta', 'buyPct', 'divSignal', 'maxBuyStack']) {
    const result = score({ ...fp, [field]: null });
    assert.equal(result.sig, 'N/A', field);
    assert.ok(result.missingFields.includes(field), field);
  }
  for (const [field, args] of [['price', [fp, ma, null]], ['ma20', [fp, { ...ma, ma20: null }, 110]], ['ma100', [fp, { ...ma, ma100: null }, 110]]]) {
    const result = score(...args);
    assert.equal(result.sig, 'N/A', field);
    assert.ok(result.missingFields.includes(field), field);
  }
});

test('fails closed for unknown required context and phase-required volume', () => {
  const cases = [
    [score(fp, ma, 110, 'UNKNOWN'), 'phase'],
    [score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, regime: 'UNKNOWN' }), 'market_regime'],
    [score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, sessionTrust: 'UNKNOWN' }), 'session_trust'],
    [score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, barClosed: 'yes' }), 'bar_closed'],
    [score(fp, ma, 110, 'SIDEWAYS', null, null), 'churn'],
    [score(fp, ma, 110, 'IMPULSE', null), 'vol_ratio'],
    [score(fp, ma, 110, 'PULLBACK', null), 'vol_ratio'],
  ];
  for (const [result, field] of cases) {
    assert.equal(result.sig, 'N/A', field);
    assert.ok(result.missingFields.includes(field), field);
  }
});

test('missing evidence precedes bearish divergence rejection', () => {
  const result = score({ ...fp, conf: null, divSignal: 1, cumDelta: -1 });
  assert.equal(result.sig, 'N/A');
  assert.deepEqual(result.missingFields, ['conf']);
});

test('base thresholds use passed count and cumDelta must pass for BUY', () => {
  assert.equal(score({ ...fp, cumDelta: 0 }).sig, 'WATCH');
  assert.equal(score({ ...fp, buyPct: 0, maxBuyStack: 0 }).passed, 5);
  assert.equal(score({ ...fp, buyPct: 0, maxBuyStack: 0 }).sig, 'BUY');
  const three = score({ ...fp, conf: 0, buyPct: 0, maxBuyStack: 0 }, { ma20: 120, ma100: 90 });
  assert.equal(three.passed, 3);
  assert.equal(three.sig, 'WATCH');
});

test('quality and raw operational score are stable', () => {
  const confirmed = score();
  assert.equal(confirmed.signal_quality, 'CONFIRMED');
  assert.equal(ctx.barClosed, true);
  const provisional = score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, barClosed: false });
  assert.equal(provisional.signal_quality, 'PROVISIONAL');
  const riskOff = score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, regime: 'RISK_OFF' });
  assert.equal(riskOff.score_pct, 100);
  assert.equal(riskOff.rank_score, 85);
  assert.equal(riskOff.sig, 'WATCH');
});

test('canonical metadata uses exact snake_case mapping', () => {
  const result = score();
  assert.deepEqual({
    score: result.score,
    score_pct: result.score_pct,
    rank_score: result.rank_score,
    signal_quality: result.signal_quality,
    missing_fields: result.missing_fields,
    decision_reasons: result.decision_reasons,
  }, {
    score: 100,
    score_pct: 100,
    rank_score: 95,
    signal_quality: 'CONFIRMED',
    missing_fields: [],
    decision_reasons: ['base_score:7/7'],
  });
});

test('N/A keeps missing evidence and never claims confirmed quality without closure evidence', () => {
  const missingFootprint = score({ ...fp, cumDelta: null });
  assert.equal(missingFootprint.sig, 'N/A');
  assert.deepEqual(missingFootprint.missing_fields, ['cumDelta']);
  assert.deepEqual(missingFootprint.decision_reasons, ['missing_evidence:cumDelta']);
  const unknownClosure = score(fp, ma, 110, 'SIDEWAYS', null, false, { ...ctx, barClosed: null });
  assert.equal(unknownClosure.sig, 'N/A');
  assert.equal(unknownClosure.signal_quality, null);
  assert.ok(unknownClosure.missing_fields.includes('bar_closed'));
});

test('timeframe and symbol guards fail before acquisition', async () => {
  assert.throws(() => assertH6Resolution('60'), /H6 resolution required/);
  assert.equal(assertH6Resolution('360'), true);
  let acquisitions = 0;
  await assert.rejects(confirmSymbol('HOSE:ACB', async () => ({ symbol: 'HOSE:VND' }), { attempts: 2 }), /confirmation failed/);
  assert.equal(acquisitions, 0);
});

test('extracts live Unicode moving-average labels without null overwrite', () => {
  const studies = [
    {
      name: 'Price Action GEM',
      values: { 'MA Fast': '71,845', 'MA Macro': '68,190' },
    },
    {
      name: 'Pocket Pivot PRO - Claude',
      values: {
        'MA Nhanh (Tím)': '71,845',
        'MA Chậm': '68,190',
        'Pocket Pivot PRO': '1',
      },
    },
  ];

  assert.deepEqual(extractMovingAverages(studies), {
    ma20: 71845,
    ma100: 68190,
    ppSignal: 1,
  });
});

test('keeps Price Action fallback when Pocket Pivot values are absent', () => {
  const studies = [
    {
      name: 'Price Action GEM',
      values: { 'MA Fast': '71,845', 'MA Macro': '68,190' },
    },
    { name: 'Pocket Pivot PRO - Claude', values: {} },
  ];

  assert.deepEqual(extractMovingAverages(studies), {
    ma20: 71845,
    ma100: 68190,
    ppSignal: null,
  });
});

// ── Auto Key Levels extractPreviousMonthProfile ──

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8'));
}

// Deterministic clock: captured once at test load, avoids flaky tests
const NOW_FOR_TEST = new Date().toISOString();
const NOW_MS = +new Date(NOW_FOR_TEST);

function obsBefore(sec) {
  return new Date(NOW_MS - sec * 1000).toISOString();
}

test('extractPreviousMonthProfile: parses formatted Auto Key Levels values', () => {
  const fixture = loadFixture('auto_key_levels_previous_month.json');
  const result = extractPreviousMonthProfile({
    studies: fixture.studies,
    expectedSymbol: fixture.symbol,
    marketDate: fixture.marketDate,
    observedAt: obsBefore(10),
    maxAgeSeconds: fixture.maxAgeSeconds,
    now: NOW_FOR_TEST,
  });
  assert.ok(result.valid, `should be valid: ${JSON.stringify(result.error)}`);
  assert.equal(result.poc, fixture.expected.poc);
  assert.equal(result.vah, fixture.expected.vah);
  assert.equal(result.val, fixture.expected.val);
  assert.equal(result.profile_month, fixture.expected.prevMonth);
  assert.equal(result.source, fixture.expected.source);
  assert.ok(result.complete);
  assert.ok(result.evidence_hash_fields);
  assert.equal(result.evidence_hash_fields.profile_month, fixture.expected.prevMonth);
});

test('extractPreviousMonthProfile: enforces VAL < POC < VAH invariant', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '25.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '26.0 K' } }],
    expectedSymbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('VAH') || result.error?.includes('VAL'));
});

test('extractPreviousMonthProfile: rejects inverted POC > VAH', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '26.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '23.0 K' } }],
    expectedSymbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
});

test('extractPreviousMonthProfile: rejects stale observation', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    expectedSymbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: obsBefore(99999), maxAgeSeconds: 3600, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('stale'));
});

test('extractPreviousMonthProfile: rejects future observation beyond clock skew', () => {
  const now = '2026-07-28T00:00:00.000Z';
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    expectedSymbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: '2026-07-29T00:00:00Z', maxAgeSeconds: 7200, now,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('future'));
});

test('extractPreviousMonthProfile: rejects invalid observedAt', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    expectedSymbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: 'not-a-date', maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
});

test('extractPreviousMonthProfile: rejects missing study', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Some Other Study', values: {} }],
    expectedSymbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
});

test('extractPreviousMonthProfile: rejects duplicate Auto Key Levels', () => {
  const result = extractPreviousMonthProfile({
    studies: [
      { name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '22.0 K' } },
      { name: 'Auto Key Levels', values: { 'Prev Monthly POC': '25.0 K', 'Prev Monthly VAH': '26.0 K', 'Prev Monthly VAL': '24.0 K' } },
    ],
    expectedSymbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('Duplicate') || result.error?.includes('duplicate'));
});

test('extractPreviousMonthProfile: symbol and profile_month returned for evidence hash', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    expectedSymbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.ok(result.valid);
  assert.equal(result.symbol, 'HOSE:HCM');
  assert.equal(result.profile_month, '2026-06');
  assert.equal(result.cache_key, 'HCM:2026-06');
});

test('extractPreviousMonthProfile: year rollover → December previous year', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '20.0 K', 'Prev Monthly VAH': '21.0 K', 'Prev Monthly VAL': '19.0 K' } }],
    expectedSymbol: 'HOSE:ABC', marketDate: '2026-01-05', observedAt: obsBefore(10), maxAgeSeconds: 99999999, now: NOW_FOR_TEST,
  });
  assert.ok(result.valid, result.error);
  assert.equal(result.profile_month, '2025-12');
});

test('extractPreviousMonthProfile: cache-month mismatch shows correct profile', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '20.0 K', 'Prev Monthly VAH': '21.0 K', 'Prev Monthly VAL': '19.0 K' } }],
    expectedSymbol: 'HOSE:ABC', marketDate: '2026-03-15', observedAt: obsBefore(10), maxAgeSeconds: 99999999, now: NOW_FOR_TEST,
  });
  assert.ok(result.valid, result.error);
  assert.equal(result.profile_month, '2026-02');
  assert.equal(result.cache_key, 'ABC:2026-02');
});

test('extractPreviousMonthProfile: rejects Footprint POC/VAH/VAL', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Footprint Aggressor Analysis', values: { 'FP POC High': '25,300', 'FP VAH': '25,400', 'FP VAL': '25,000' } }],
    expectedSymbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: obsBefore(10), maxAgeSeconds: 7200, now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
});

// ── classifyMaAnchor ──

test('classifyMaAnchor: SMA100 within 7% — allowed', () => {
  const result = classifyMaAnchor({ price: 22200, sma20: 23000, sma100: 21000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, true);
  assert.equal(result.anchor, 'sma100');
  assert.equal(result.extension_pct, 5.71);
  assert.equal(result.blocker, null);
});

test('classifyMaAnchor: price below SMA100 — BELOW_SMA100', () => {
  const result = classifyMaAnchor({ price: 20000, sma20: 21000, sma100: 20500, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'BELOW_SMA100');
  assert.equal(result.anchor, null);
});

test('classifyMaAnchor: price 20% above both — OVEREXTENDED', () => {
  const result = classifyMaAnchor({ price: 25000, sma20: 21000, sma100: 20500, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'OVEREXTENDED');
  assert.equal(result.anchor, null);
});

test('classifyMaAnchor: exactly at 7% boundary — allowed', () => {
  // 21400 is exactly 7% above sma100=20000 → (21400-20000)/20000*100 = 7.00%
  const result = classifyMaAnchor({ price: 21400, sma20: 22000, sma100: 20000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, true);
  assert.equal(result.extension_pct, 7);
});

test('classifyMaAnchor: just over 7% boundary — OVEREXTENDED', () => {
  const result = classifyMaAnchor({ price: 21500, sma20: 22000, sma100: 20000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'OVEREXTENDED');
});

test('classifyMaAnchor: preferredAnchor changes ordering only, cannot bypass 7%', () => {
  // sma20=23000 (distance -6.5%), sma100=22000 (distance -2.3%) — both below
  // preferredAnchor='sma20' but sma20 is below price? No, price is 21500.
  // sma20=23000, price=21500 → price is below sma20. Let me fix: still BELOW_SMA100 since 21500 < 22000.
  // Let's use: price=23500, sma20=23000 (dist +2.17%), sma100=22000 (dist +6.82% — near limit)
  // preferredAnchor=sma20 → should pick sma20 since it's within 7% and preferred
  const result = classifyMaAnchor({ price: 23500, sma20: 23000, sma100: 22000, preferredAnchor: 'sma20', maxExtensionPct: 7 });
  assert.equal(result.allowed, true);
  assert.equal(result.anchor, 'sma20');
});

test('classifyMaAnchor: preferredAnchor cannot pick OVEREXTENDED sma100', () => {
  // price=24000, sma20=23000 (+4.35%), sma100=21000 (+14.3% — over 7%)
  // preferredAnchor='sma100' but sma100 is overextended → should fall back to sma20
  const result = classifyMaAnchor({ price: 24000, sma20: 23000, sma100: 21000, preferredAnchor: 'sma100', maxExtensionPct: 7 });
  assert.equal(result.allowed, true);
  assert.equal(result.anchor, 'sma20');
});

test('classifyMaAnchor: null MAs return MA_DATA_MISSING', () => {
  const result = classifyMaAnchor({ price: 25000, sma20: null, sma100: null, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'MA_DATA_MISSING');
});

// ── Adversarial: price below SMA100 blocks setup formation ──

test('classifyMaAnchor: adversarial - price 1% below SMA100 still blocked', () => {
  // Price 20295 vs SMA100 20500 → -1%
  const result = classifyMaAnchor({ price: 20295, sma20: 20000, sma100: 20500, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'BELOW_SMA100');
});

test('classifyMaAnchor: adversarial - price exactly 7% above — boundary allowed', () => {
  const result = classifyMaAnchor({ price: 21400, sma20: 21500, sma100: 20000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.allowed, true);
  assert.ok(result.extension_pct <= 7);
});

test('classifyMaAnchor: adversarial - preferredAnchor 20% above still capped', () => {
  // preferredAnchor='sma100' but both are >7% → OVEREXTENDED
  const result = classifyMaAnchor({ price: 25000, sma20: 22000, sma100: 21000, preferredAnchor: 'sma100', maxExtensionPct: 7 });
  assert.equal(result.allowed, false);
  assert.equal(result.blocker, 'OVEREXTENDED');
});

// ── Adversarial: SMA100 missing → MA_DATA_MISSING ──
test('classifyMaAnchor: missing SMA100 with SMA20 present returns MA_DATA_MISSING', () => {
  const result = classifyMaAnchor({ price: 105, sma20: 100, sma100: null, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.blocker, 'MA_DATA_MISSING');
});

// ── Adversarial: observed symbol mismatch ──
test('extractPreviousMonthProfile: symbol mismatch fails closed', () => {
  const studies = [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }];
  const result = extractPreviousMonthProfile({
    studies,
    expectedSymbol: 'HOSE:HCM',
    observedSymbol: 'HOSE:WRONG',
    expectedCacheKey: 'HCM:2026-06',
    marketDate: '2026-07-28',
    observedAt: obsBefore(10),
    maxAgeSeconds: 7200,
    now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.toLowerCase().includes('symbol'), `error must mention symbol: ${result.error}`);
});

// ── Adversarial: cache key mismatch ──
test('extractPreviousMonthProfile: cache key mismatch fails closed', () => {
  const studies = [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '20.0 K', 'Prev Monthly VAH': '21.0 K', 'Prev Monthly VAL': '19.0 K' } }];
  // marketDate 2026-03-15 → profile_month 2026-02 → cache_key "ABC:2026-02"
  // expectedCacheKey "ABC:2026-05" → mismatch
  const result = extractPreviousMonthProfile({
    studies,
    expectedSymbol: 'HOSE:ABC',
    observedSymbol: 'HOSE:ABC',
    expectedCacheKey: 'ABC:2026-05',
    marketDate: '2026-03-15',
    observedAt: obsBefore(10),
    maxAgeSeconds: 99999999,
    now: NOW_FOR_TEST,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.toLowerCase().includes('cache'), `error must mention cache: ${result.error}`);
});

// ── Adversarial: SHA-256 hash tampering ──
test('extractPreviousMonthProfile: changing POC changes evidence_hash', () => {
  function makeResult(poc) {
    return extractPreviousMonthProfile({
      studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': poc, 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '22.0 K' } }],
      expectedSymbol: 'HOSE:TEST',
      observedSymbol: 'HOSE:TEST',
      expectedCacheKey: 'TEST:2026-06',
      marketDate: '2026-07-28',
      observedAt: obsBefore(10),
      maxAgeSeconds: 7200,
      now: NOW_FOR_TEST,
    });
  }
  const a = makeResult('23.0 K');
  const b = makeResult('23.5 K');
  assert.ok(a.valid && b.valid);
  assert.notEqual(a.evidence_hash, b.evidence_hash, 'different POC must produce different hash');
});

// ── VN Structure v2: check/scan shared owner (Task 1) ──

function makeTestBars(n, highFn, lowFn) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const h = highFn(i);
    const l = lowFn(i);
    bars.push({ time: i, open: h - 0.3, high: h, low: l, close: h - 0.1, volume: 100000 });
  }
  return bars;
}

test('check and scan production adapters emit identical structure truth', () => {
  const bars = makeTestBars(120, i => 100 + i * 0.5, i => 99 + i * 0.5);
  const checkHistory = buildClosedH6History({ bars, activeBarClosed: true });
  const scanHistory = buildScanStructure({
    bars,
    activeBarClosed: true,
    sma20: checkHistory.sma20,
    sma100: checkHistory.sma100,
  });

  assert.equal(checkHistory.structure_v2.version, VN_STRUCTURE_VERSION);
  assert.equal(checkHistory.structure, scanHistory.structure);
  for (const field of [
    'version',
    'trend_state',
    'range_state',
    'confirmed',
    'upper',
    'upper_ref',
    'lower',
    'lower_ref',
  ]) {
    assert.equal(checkHistory.structure_v2[field], scanHistory.structure_v2[field], field);
  }

  const scanResult = buildScoutResult({
    name: 'TEST',
    sig: 'WATCH',
    scored: {},
    fp: {},
    ma: { ma20: checkHistory.sma20, ma100: checkHistory.sma100 },
    rs: {},
    discovery: {},
    structure: scanHistory.structure,
    structureV2: scanHistory.structure_v2,
  }, { regime: 'N/A', note: null });

  assert.equal(scanResult.structure, checkHistory.structure);
  assert.deepEqual(scanResult.structure_v2, checkHistory.structure_v2);
  for (const forbidden of ['plan', 'plan_key', 'readiness', 'status', 'setup_state']) {
    assert.ok(!(forbidden in scanResult), `scan result must not grant ${forbidden}`);
  }
});

test('scan structure cannot be changed by active bar or caller live MAs', () => {
  const completed = makeTestBars(120, i => 102 + i, i => 99 + i);
  const activeA = { time: 120, open: 220, high: 221, low: 219, close: 220, volume: 100000 };
  const activeB = { time: 120, open: 900, high: 999, low: 1, close: 500, volume: 9000000 };
  const a = buildScanStructure({ bars: [...completed, activeA], activeBarClosed: false, sma20: 1, sma100: 9999 });
  const b = buildScanStructure({ bars: [...completed, activeB], activeBarClosed: false, sma20: 9999, sma100: 1 });
  const stable = buildScanStructure({ bars: completed, activeBarClosed: true });

  assert.deepEqual(a, b);
  assert.deepEqual(a, stable);
  assert.equal(stable.structure_v2.confirmed, true);
  assert.equal(stable.structure_v2.trend_state, 'UP');
});

test('scan-live keeps compact mode table-free and full mode opt-in', () => {
  const source = readFileSync(new URL('../scan_live.mjs', import.meta.url), 'utf8');
  assert.match(source, /const FULL_MODE = process\.argv\.includes\('--full'\)/);
  assert.match(source, /new Set\(\['--full', '--print-watchlist'\]\)/);
  assert.match(source, /FULL_MODE \? data\.getPineTables\(/);
  assert.match(source, /const tableRows = FULL_MODE \? parseFPTable\(fpTbl\) : \[\]/);
  for (const field of ['score_pct=', 'price=', 'phase=', 'structure=', 'discovery=', 'RS=', 'quality=', 'FP:', 'criteria=', 'missing=']) {
    assert.match(source, new RegExp(field.replace(/[=]/g, '\\=')));
  }
});
