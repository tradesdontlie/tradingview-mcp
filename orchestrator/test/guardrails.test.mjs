import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateProposal, clampToUniverse } from '../lib/guardrails.mjs';
import { estimatePerformance } from '../lib/estimate.mjs';

const SPOT_ALL = ['sfp', 'divergence', 'cvd_divergence', 'levels', 'fibonacci', 'market_structure'];
const allFiltersOn = (names) => Object.fromEntries(names.map((f) => [f, { enabled: true }]));
const SPOT_CURRENT = {
  active_strategies: SPOT_ALL,
  active_filters: allFiltersOn(['pinbar_bias_4h', 'daily_structure', 'vwap_bias', 'value_area_bias']),
  param_overrides: { HISTORICAL_WIN_RATE: 58 },
};
const PASS = { winRate: 0.7, expectancy: 0.8, sample: 40, pairsUsed: 3 };

test('clamp strips out-of-universe strategy and filter (spot)', () => {
  const { clamped, clampViolations } = clampToUniverse('spot', {
    active_strategies: ['sfp', 'levels', 'HACK_btc_moonshot', 'pinbar'], // pinbar not in spot universe
    active_filters: { vwap_bias: { enabled: true }, made_up_filter: { enabled: true } },
  });
  assert.deepEqual(clamped.active_strategies, ['sfp', 'levels']);  // pinbar is futures-only — stripped from spot
  assert.deepEqual(Object.keys(clamped.active_filters), ['vwap_bias']);
  assert.equal(clampViolations.length, 3);  // HACK_btc_moonshot, pinbar, made_up_filter
});

test('reaffirming the current config is an auto no-op (objective not enforced)', () => {
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate: SPOT_CURRENT, estimate: { winRate: null, expectancy: null, sample: 0 } });
  assert.equal(r.classification, 'auto');
  assert.equal(r.changes.length, 0);
});

test('< 2 strategies is rejected', () => {
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate: { active_strategies: ['levels'], active_filters: SPOT_CURRENT.active_filters }, estimate: PASS });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /< 2 active strategies/);
});

test('disabling one strategy with passing estimate auto-applies', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: PASS });
  assert.equal(r.classification, 'auto');
  assert.equal(r.changes.length, 1);
});

test('two changes in one cycle is rejected (rate limit)', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence' && s !== 'fibonacci') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: PASS });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /max 1 per cycle/);
});

test('fails win floor', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: { winRate: 0.55, expectancy: 0.8, sample: 40, pairsUsed: 3 } });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /below floor 60%/);
});

test('fails expectancy floor (the high-win%/tiny-R trap)', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: { winRate: 0.88, expectancy: 0.1, sample: 40, pairsUsed: 3 } });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /expectancy 0.10R below floor/);
});

test('null expectancy (no trustworthy avg-R) is rejected', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: { winRate: 0.7, expectancy: null, sample: 40, pairsUsed: 3 } });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /expectancy unknown/);
});

test('low sample is rejected (the 5/5 noise rule)', () => {
  const candidate = { ...SPOT_CURRENT, active_strategies: SPOT_ALL.filter((s) => s !== 'cvd_divergence') };
  const r = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate, estimate: { winRate: 1.0, expectancy: 5, sample: 5, pairsUsed: 1 } });
  assert.equal(r.classification, 'reject');
  assert.match(r.violations.join(' '), /insufficient sample/);
});

test('raising the risk gate requires approval; lowering auto-applies', () => {
  const raise = { ...SPOT_CURRENT, param_overrides: { HISTORICAL_WIN_RATE: 65 } };
  const rUp = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate: raise, estimate: PASS });
  assert.equal(rUp.classification, 'approval');

  const lower = { ...SPOT_CURRENT, param_overrides: { HISTORICAL_WIN_RATE: 55 } };
  const rDown = validateProposal({ bot: 'spot', current: SPOT_CURRENT, candidate: lower, estimate: PASS });
  assert.equal(rDown.classification, 'auto');
  assert.equal(rDown.clamped.param_overrides.HISTORICAL_WIN_RATE, 55);
});

test('estimate prefers the live ledger over the backtest when sample is adequate', () => {
  const ledgerTrades = [
    ...Array.from({ length: 24 }, () => ({ strategies: ['divergence', 'levels'], win: true, r: 1.2 })),
    ...Array.from({ length: 6 }, () => ({ strategies: ['divergence', 'levels'], win: false, r: -1 })),
  ];
  const backtestTrades = Array.from({ length: 100 }, () => ({ strategies: ['divergence', 'levels'], win: false, r: -1 })); // 0% — should be ignored
  const est = estimatePerformance({ active_strategies: ['divergence', 'levels'] }, { ledgerTrades, backtestTrades });
  assert.equal(est.source, 'ledger');
  assert.equal(est.sample, 30);
  assert.ok(est.winRate > 0.7 && est.winRate < 0.81);
});

test('falls back to the backtest when the ledger is thin; expectancy = mean fixed-R', () => {
  const backtestTrades = Array.from({ length: 30 }, () => ({ strategies: ['divergence', 'levels'], win: true, r: 0.82 }));
  const est = estimatePerformance({ active_strategies: ['divergence', 'levels', 'fibonacci'] }, { ledgerTrades: [], backtestTrades });
  assert.equal(est.source, 'backtest');
  assert.equal(est.sample, 30);
  assert.ok(Math.abs(est.expectancy - 0.82) < 1e-9);
  assert.equal(est.winRate, 1);
});

test('retain rule: trades needing a disabled strategy are dropped; ≥2-active confluences survive', () => {
  const backtestTrades = [
    ...Array.from({ length: 30 }, () => ({ strategies: ['divergence', 'levels'], win: true, r: 1 })),        // both active → kept
    ...Array.from({ length: 25 }, () => ({ strategies: ['divergence', 'levels', 'cvd_divergence'], win: true, r: 1 })), // 2 active → kept
    ...Array.from({ length: 10 }, () => ({ strategies: ['cvd_divergence', 'sfp'], win: false, r: -1 })),      // <2 active → dropped
  ];
  // disabling cvd_divergence and sfp from the active set
  const est = estimatePerformance({ active_strategies: ['divergence', 'levels', 'fibonacci', 'market_structure'] }, { ledgerTrades: [], backtestTrades });
  assert.equal(est.sample, 55);   // 30 + 25 retained, the 10 dropped
  assert.equal(est.winRate, 1);
});
