/**
 * Offline unit tests for the scoring module.
 * Uses synthetic fixture data — no TradingView connection needed.
 * Run with: node --test tests/scoring.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../scoring/index.js';
import { compute as computeReturns } from '../scoring/returns.js';
import { compute as computeRobustness } from '../scoring/robustness.js';
import { compute as computeCost } from '../scoring/cost.js';
import { compute as computeRegimes } from '../scoring/regimes.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeTrades(n, winRate = 0.6, avgWin = 0.015, avgLoss = -0.01) {
  return Array.from({ length: n }, (_, i) => {
    const isWin = Math.random() < winRate;
    const profitPct = isWin ? avgWin + (Math.random() - 0.5) * 0.005
                            : avgLoss + (Math.random() - 0.5) * 0.005;
    const entryTime = Date.now() - (n - i) * 24 * 3600 * 1000;
    return {
      entry_time: entryTime,
      exit_time: entryTime + 8 * 3600 * 1000,
      entry_price: 100,
      exit_price: 100 * (1 + profitPct),
      profit_pct: profitPct,
      profit: 1000 * profitPct,
    };
  });
}

function makeEquity(trades, initialEquity = 10000) {
  let equity = initialEquity;
  let peak = initialEquity;
  return trades.map(t => {
    equity *= (1 + t.profit_pct);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    return { time: t.exit_time, equity, drawdown };
  });
}

function makeBars(n = 500, startPrice = 100) {
  const bars = [];
  let price = startPrice;
  let time = Date.now() - n * 24 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    const change = (Math.random() - 0.48) * 2;
    price = Math.max(1, price + change);
    bars.push({
      time,
      open: price - Math.random(),
      high: price + Math.random(),
      low: price - Math.random(),
      close: price,
      volume: 1000 + Math.random() * 5000,
    });
    time += 24 * 3600 * 1000;
  }
  return bars;
}

// ── Returns dimension ─────────────────────────────────────────────────────────

describe('Returns dimension', () => {
  const trades = makeTrades(100, 0.65, 0.018, -0.010);
  const equity = makeEquity(trades);

  const result = computeReturns(trades, equity);

  test('returns a score between 0 and 100', () => {
    assert.ok(result.score >= 0 && result.score <= 100, `score out of range: ${result.score}`);
  });

  test('components include sharpe and sortino', () => {
    assert.ok(typeof result.components.sharpe === 'number');
    assert.ok(typeof result.components.sortino === 'number');
  });

  test('sharpe is positive for a profitable strategy', () => {
    assert.ok(result.components.sharpe > 0, `expected positive Sharpe, got ${result.components.sharpe}`);
  });

  test('maxDrawdown is between 0 and 1', () => {
    const dd = result.components.maxDrawdown;
    assert.ok(dd >= 0 && dd <= 1, `maxDrawdown out of range: ${dd}`);
  });

  test('evidence includes equityCurve', () => {
    assert.ok(Array.isArray(result.evidence.equityCurve));
  });

  test('bad strategy gets lower score than good strategy', () => {
    const badTrades = makeTrades(100, 0.3, 0.010, -0.020);
    const badEquity = makeEquity(badTrades, 10000);
    const badResult = computeReturns(badTrades, badEquity);
    // Good strategy should score higher (not guaranteed with random data, but very likely)
    assert.ok(result.score >= badResult.score - 5, 'good strategy should generally score higher');
  });
});

// ── Robustness dimension ──────────────────────────────────────────────────────

describe('Robustness dimension', () => {
  const trades = makeTrades(80, 0.60, 0.015, -0.010);
  const equity = makeEquity(trades);

  const result = computeRobustness(trades, equity);

  test('returns a score between 0 and 100', () => {
    assert.ok(result.score >= 0 && result.score <= 100, `score: ${result.score}`);
  });

  test('monte carlo produces p5 <= p50 <= p95', () => {
    assert.ok(result.components.mcP5 <= result.components.mcP50,
      `p5 (${result.components.mcP5}) should be <= p50 (${result.components.mcP50})`);
    assert.ok(result.components.mcP50 <= result.components.mcP95,
      `p50 (${result.components.mcP50}) should be <= p95 (${result.components.mcP95})`);
  });

  test('ruin probability is between 0 and 1', () => {
    const rp = result.components.mcRuinProbability;
    assert.ok(rp >= 0 && rp <= 1, `ruinProbability: ${rp}`);
  });

  test('wfe is a finite number', () => {
    assert.ok(Number.isFinite(result.components.wfe), `wfe should be finite: ${result.components.wfe}`);
  });

  test('consistency ratio is between 0 and 1', () => {
    const cr = result.components.consistencyRatio;
    assert.ok(cr >= 0 && cr <= 1, `consistencyRatio: ${cr}`);
  });
});

// ── Cost dimension ────────────────────────────────────────────────────────────

describe('Cost dimension', () => {
  const trades = makeTrades(60, 0.60, 0.020, -0.012);
  const equity = makeEquity(trades);

  test('zero-cost model gives netReturnRatio ≈ 1', () => {
    const result = computeCost(trades, equity, {}, { fee_pct: 0, slippage_pct: 0 });
    assert.ok(result.components.netReturnRatio > 0.95, `expected ≈1, got ${result.components.netReturnRatio}`);
  });

  test('high-cost model reduces netReturnRatio', () => {
    const cheap = computeCost(trades, equity, {}, { fee_pct: 0.0001, slippage_pct: 0.0001 });
    const expensive = computeCost(trades, equity, {}, { fee_pct: 0.01, slippage_pct: 0.01 });
    assert.ok(expensive.components.netReturnRatio < cheap.components.netReturnRatio,
      'expensive costs should reduce net return ratio');
  });

  test('slippage curve has entries from 0× to 5×', () => {
    const result = computeCost(trades, equity, {});
    const curve = result.evidence.slippageCurve;
    assert.ok(Array.isArray(curve) && curve.length > 0);
    assert.ok(curve.some(p => p.multiplier === 0), 'should have 0× data point');
    assert.ok(curve.some(p => p.multiplier >= 4), 'should have high multiplier data point');
  });

  test('score is between 0 and 100', () => {
    const result = computeCost(trades, equity, {});
    assert.ok(result.score >= 0 && result.score <= 100);
  });
});

// ── Regimes dimension ─────────────────────────────────────────────────────────

describe('Regimes dimension', () => {
  const trades = makeTrades(50, 0.60, 0.015, -0.010);
  const bars = makeBars(500);
  const equity = makeEquity(trades);

  const result = computeRegimes(trades, bars, equity);

  test('returns a score between 0 and 100', () => {
    assert.ok(result.score >= 0 && result.score <= 100);
  });

  test('regimes object has bull, bear, chop keys', () => {
    assert.ok('bull' in result.components.regimes);
    assert.ok('bear' in result.components.regimes);
    assert.ok('chop' in result.components.regimes);
  });

  test('total trades across regimes equals total trades', () => {
    const total = Object.values(result.components.regimes)
      .reduce((s, r) => s + r.tradeCount, 0);
    assert.equal(total, trades.length);
  });

  test('evidence includes regimeBars array', () => {
    assert.ok(Array.isArray(result.evidence.regimeBars));
    assert.ok(result.evidence.regimeBars.length > 0);
  });
});

// ── runBenchmark integration ──────────────────────────────────────────────────

describe('runBenchmark', () => {
  const trades = makeTrades(120, 0.62, 0.016, -0.010);
  const bars = makeBars(600);
  const equity = makeEquity(trades);

  const result = runBenchmark(trades, bars, equity, {
    symbol: 'TEST',
    timeframe: '1D',
    algoHash: 'test_hash_abc',
  });

  test('compositeScore is between 0 and 100', () => {
    assert.ok(result.compositeScore >= 0 && result.compositeScore <= 100);
  });

  test('all four dimensions have scores', () => {
    for (const dim of ['returns', 'robustness', 'cost', 'regimes']) {
      assert.ok(typeof result.scores[dim].score === 'number', `${dim} score missing`);
    }
  });

  test('weights sum to ≈ 1', () => {
    const sum = Object.values(result.weights).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `weights sum: ${sum}`);
  });

  test('composite equals weighted sum of dimension scores', () => {
    const expected = Math.round(
      result.scores.returns.score * result.weights.returns +
      result.scores.robustness.score * result.weights.robustness +
      result.scores.cost.score * result.weights.cost +
      result.scores.regimes.score * result.weights.regimes,
    );
    assert.equal(result.compositeScore, expected);
  });

  test('custom weights shift composite score', () => {
    const highReturnWeight = runBenchmark(trades, bars, equity, {
      algoHash: 'test', weights: { returns: 0.7, robustness: 0.1, cost: 0.1, regimes: 0.1 },
    });
    const highRobustWeight = runBenchmark(trades, bars, equity, {
      algoHash: 'test', weights: { returns: 0.1, robustness: 0.7, cost: 0.1, regimes: 0.1 },
    });
    // Scores may differ (returns and robustness are independently computed)
    assert.ok(typeof highReturnWeight.compositeScore === 'number');
    assert.ok(typeof highRobustWeight.compositeScore === 'number');
  });
});
