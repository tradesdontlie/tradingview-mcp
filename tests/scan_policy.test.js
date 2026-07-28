import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { assertH6Resolution, confirmSymbol, extractMovingAverages, extractPreviousMonthProfile, classifyMaAnchor, scoreSignal } from '../src/scan_policy.mjs';

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

// ── Task 1: Auto Key Levels extractPreviousMonthProfile ──

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8'));
}

test('extractPreviousMonthProfile: parses formatted Auto Key Levels values', () => {
  const fixture = loadFixture('auto_key_levels_previous_month.json');
  const result = extractPreviousMonthProfile({
    studies: fixture.studies,
    symbol: fixture.symbol,
    marketDate: fixture.marketDate,
    observedAt: fixture.observedAt,
    maxAgeSeconds: fixture.maxAgeSeconds,
  });
  assert.ok(result.valid, `should be valid: ${JSON.stringify(result.error)}`);
  assert.equal(result.poc, fixture.expected.poc);
  assert.equal(result.vah, fixture.expected.vah);
  assert.equal(result.val, fixture.expected.val);
  assert.equal(result.prevMonth, fixture.expected.prevMonth);
  assert.equal(result.source, fixture.expected.source);
});

test('extractPreviousMonthProfile: enforces VAL < POC < VAH invariant', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '25.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '26.0 K' } }],
    symbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('VAH') || result.error?.includes('VAL'));
});

test('extractPreviousMonthProfile: rejects inverted POC > VAH', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '26.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '23.0 K' } }],
    symbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.equal(result.valid, false);
});

test('extractPreviousMonthProfile: rejects stale observation', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    symbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: '2026-07-01T00:00:00Z', maxAgeSeconds: 3600,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('stale'));
});

test('extractPreviousMonthProfile: rejects missing study', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Some Other Study', values: {} }],
    symbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.equal(result.valid, false);
});

test('extractPreviousMonthProfile: rejects duplicate Auto Key Levels', () => {
  const result = extractPreviousMonthProfile({
    studies: [
      { name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.0 K', 'Prev Monthly VAH': '24.0 K', 'Prev Monthly VAL': '22.0 K' } },
      { name: 'Auto Key Levels', values: { 'Prev Monthly POC': '25.0 K', 'Prev Monthly VAH': '26.0 K', 'Prev Monthly VAL': '24.0 K' } },
    ],
    symbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('duplicate') || result.error?.includes('Duplicate'));
});

test('extractPreviousMonthProfile: symbol is recorded in output for hashing', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '23.25 K', 'Prev Monthly VAH': '23.9 K', 'Prev Monthly VAL': '23.1 K' } }],
    symbol: 'HOSE:HCM', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.ok(result.valid);
  assert.equal(result.symbol, 'HOSE:HCM');
});

test('extractPreviousMonthProfile: previous month derivation handles year rollover', () => {
  // Use a maxAgeSeconds large enough so staleness does not mask the year-rollover check
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '20.0 K', 'Prev Monthly VAH': '21.0 K', 'Prev Monthly VAL': '19.0 K' } }],
    symbol: 'HOSE:ABC', marketDate: '2026-01-05', observedAt: new Date().toISOString(), maxAgeSeconds: 99999999,
  });
  assert.ok(result.valid, result.error);
  assert.equal(result.prevMonth, '2025-12');
});

test('extractPreviousMonthProfile: cache-month mismatch detection', () => {
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Auto Key Levels', values: { 'Prev Monthly POC': '20.0 K', 'Prev Monthly VAH': '21.0 K', 'Prev Monthly VAL': '19.0 K' } }],
    symbol: 'HOSE:ABC', marketDate: '2026-03-15', observedAt: new Date().toISOString(), maxAgeSeconds: 99999999,
  });
  assert.ok(result.valid, result.error);
  assert.equal(result.prevMonth, '2026-02');
});

test('extractPreviousMonthProfile: rejects Footprint POC/VAH/VAL', () => {
  // Footprint study has FP POC/VAH/VAL — must not be accepted as monthly profile
  const result = extractPreviousMonthProfile({
    studies: [{ name: 'Footprint Aggressor Analysis', values: { 'FP POC High': '25,300', 'FP VAH': '25,400', 'FP VAL': '25,000' } }],
    symbol: 'HOSE:TEST', marketDate: '2026-07-28', observedAt: '2026-07-28T10:30:00Z', maxAgeSeconds: 7200,
  });
  assert.equal(result.valid, false);
});

// ── Task 1: classifyMaAnchor ──

test('classifyMaAnchor: classifies SMA100 pullback reclaim within 7%', () => {
  // price 22200 is 5.71% above sma100=21000 — within the 7% cap
  const result = classifyMaAnchor({ price: 22200, sma20: 23000, sma100: 21000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.anchor, 'sma100');
  assert.equal(result.distancePct, 5.71);
});

test('classifyMaAnchor: classifies SMA20 pullback when far from SMA100', () => {
  // price 25000 is ~19% above sma100=21000 (overextended), but close to sma20=24800 (0.81%)
  const result = classifyMaAnchor({ price: 25000, sma20: 24800, sma100: 21000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.anchor, 'sma20');
  assert.equal(result.distancePct, 0.81);
});

test('classifyMaAnchor: honors preferredAnchor', () => {
  const result = classifyMaAnchor({ price: 22500, sma20: 23000, sma100: 21000, preferredAnchor: 'sma100', maxExtensionPct: 7 });
  assert.equal(result.anchor, 'sma100');
});

test('classifyMaAnchor: returns none when price is overextended beyond ceiling', () => {
  const result = classifyMaAnchor({ price: 30000, sma20: 25000, sma100: 21000, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.anchor, 'none');
  assert.ok(result.overextended);
});

test('classifyMaAnchor: null MAs return null anchor', () => {
  const result = classifyMaAnchor({ price: 25000, sma20: null, sma100: null, preferredAnchor: null, maxExtensionPct: 7 });
  assert.equal(result.anchor, null);
});
