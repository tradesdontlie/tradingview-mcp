/**
 * Scoring module entry point.
 *
 * runBenchmark(trades, bars, equity, options) → BenchmarkResult
 *
 * BenchmarkResult shape:
 * {
 *   id: string,
 *   algoHash: string,
 *   symbol: string,
 *   timeframe: string,
 *   dateRange: { start: string, end: string },
 *   costModel: CostModel,
 *   compositeScore: number,      // 0–100 weighted mean
 *   weights: Weights,
 *   scores: {
 *     returns:    { score, components, evidence },
 *     robustness: { score, components, evidence },
 *     cost:       { score, components, evidence },
 *     regimes:    { score, components, evidence },
 *   },
 *   createdAt: string,
 * }
 */

import { compute as computeReturns } from './returns.js';
import { compute as computeRobustness } from './robustness.js';
import { compute as computeCost } from './cost.js';
import { compute as computeRegimes } from './regimes.js';
import { hashSource } from './store.js';

const DEFAULT_WEIGHTS = {
  returns: 0.25,
  robustness: 0.25,
  cost: 0.25,
  regimes: 0.25,
};

/**
 * @param {Trade[]} trades          - array of trade objects from data_get_trades
 * @param {Bar[]} bars              - OHLCV bars from data_get_ohlcv (full, not summary)
 * @param {EquityPoint[]} equity    - equity curve from data_get_equity
 * @param {object} options
 * @param {string} options.symbol
 * @param {string} options.timeframe
 * @param {string} [options.pineSource]   - used to compute algoHash
 * @param {string} [options.algoHash]     - explicit hash, used if pineSource absent
 * @param {object} [options.costModel]
 * @param {object} [options.weights]
 * @returns {BenchmarkResult}
 */
export function runBenchmark(trades, bars, equity, options = {}) {
  const {
    symbol = 'UNKNOWN',
    timeframe = 'UNKNOWN',
    pineSource,
    algoHash: explicitHash,
    costModel = {},
    weights: weightOverrides = {},
  } = options;

  const algoHash = explicitHash ?? (pineSource ? hashSource(pineSource) : 'manual');
  const weights = { ...DEFAULT_WEIGHTS, ...weightOverrides };
  normalizeWeights(weights);

  const dateRange = inferDateRange(equity, bars);

  const scores = {
    returns: computeReturns(trades, equity),
    robustness: computeRobustness(trades, equity),
    cost: computeCost(trades, equity, {}, costModel),
    regimes: computeRegimes(trades, bars, equity),
  };

  const compositeScore = Math.round(
    scores.returns.score * weights.returns +
    scores.robustness.score * weights.robustness +
    scores.cost.score * weights.cost +
    scores.regimes.score * weights.regimes,
  );

  return {
    algoHash,
    symbol,
    timeframe,
    dateRange,
    costModel,
    compositeScore,
    weights,
    scores,
    createdAt: new Date().toISOString(),
  };
}

function normalizeWeights(w) {
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total === 0) return;
  for (const k of Object.keys(w)) w[k] /= total;
}

function inferDateRange(equity, bars) {
  const source = equity?.length ? equity : bars;
  if (!source?.length) return { start: 'unknown', end: 'unknown' };

  const times = source.map(p => parseTime(p.time ?? p.t));
  const start = new Date(Math.min(...times)).toISOString().slice(0, 10);
  const end = new Date(Math.max(...times)).toISOString().slice(0, 10);
  return { start, end };
}

function parseTime(t) {
  return typeof t === 'number' ? t : new Date(t).getTime();
}

export { hashSource };
