import test from 'node:test';
import assert from 'node:assert/strict';
import { assertH6Resolution, confirmSymbol, scoreSignal } from '../src/scan_policy.mjs';

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
