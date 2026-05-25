/**
 * Quantitative alpha-research toolkit.
 *
 * This module is split into two sections:
 *
 *  ── Pure analytical functions (no chart connection) ──
 *      Operate on raw trade lists / Sharpe values. Fast, deterministic,
 *      no async, suitable for any quant who pipes TradingView trade data
 *      through MCP for deeper inspection than the built-in report offers.
 *      - screenMetrics      (Calmar, recovery factor, expectancy, R-multiple, streaks)
 *      - tradeDistribution  (moments + concentration / pareto check)
 *      - deflateSharpe      (Bailey/López de Prado deflated Sharpe ratio)
 *      - bootstrapSignificance (resampled p-value of mean return > 0)
 *      - kellyFraction      (closed-form Kelly from win rate + W/L ratio)
 *
 *  ── Chart-connected workflows ──
 *      Drive the live TradingView chart through CDP to run real backtests
 *      across symbols / time windows. Slower (each evaluation = real chart
 *      recompute) but the closest you can get to a deployable-alpha gate.
 *      - robustnessCheck   (run current strategy across N symbols, report dispersion)
 *      - walkForward       (in-sample grid_search → out-of-sample test, degradation %)
 */

import { evaluate, evaluateAsync, safeString } from '../connection.js';
import { setSymbol } from './chart.js';
import { waitForChartReady } from '../wait.js';
import { getStrategyResults, getStrategyInputs, setStrategyInputs, gridSearch } from './data.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// ─────────────────────────────────────────────────────────────────────────────
//  Pure analytical helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the numeric P&L (`tp.v` if present, else `cp.v`) from a trade record. */
function tradePnl(t) {
  if (!t || typeof t !== 'object') return NaN;
  if (t.pnl != null && typeof t.pnl === 'number') return t.pnl;
  if (t.tp && typeof t.tp.v === 'number') return t.tp.v;
  if (typeof t.profit === 'number') return t.profit;
  if (typeof t.p === 'number' && typeof t.q === 'number' && t.b !== undefined) {
    // Fallback: signed entry/exit notional; not always meaningful alone.
    return (t.b ? 1 : -1) * t.p * t.q;
  }
  return NaN;
}

function pctTradePnl(t) {
  if (t && t.tp && typeof t.tp.p === 'number') return t.tp.p;
  if (typeof t?.return_pct === 'number') return t.return_pct;
  return NaN;
}

/** Sample mean. */
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
/** Sample standard deviation (Bessel-corrected). */
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
/** Sample skewness (Fisher-Pearson). */
function skewness(xs) {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  const sum = xs.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}
/** Sample excess kurtosis (Fisher: normal = 0). */
function kurtosis(xs) {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  const sum4 = xs.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum4
       - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

/**
 * Extended trade-level metrics that TradingView's default report omits.
 * Pass `trades` as an array of {tp:{v, p}, ...} (the format from strategy
 * report's `trades` array) OR plain {pnl, return_pct} objects.
 *
 * Returns Calmar, recovery factor, expectancy, R-multiple, win/loss streaks,
 * profit concentration (% of profit from top 10 trades), and a quick verdict.
 */
export function screenMetrics({ trades, initial_capital = 100000, bars_per_year = 252 } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error('trades is required: pass strategy_get_report().trades or data_get_trades().trades.');
  }
  const pnls = trades.map(tradePnl).filter(Number.isFinite);
  if (pnls.length === 0) throw new Error('No usable P&L found in trades. Ensure trades contain tp.v or pnl.');
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netProfit = pnls.reduce((a, b) => a + b, 0);
  const winRate = wins.length / pnls.length;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const rMultiple = avgLoss > 0 ? avgWin / avgLoss : NaN;

  // Equity curve + max drawdown
  let equity = initial_capital;
  let peak = initial_capital;
  let maxDD = 0;
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = peak > 0 ? maxDD / peak : 0;

  // CAGR is approximate (assumes 1 trade per bar period — use with care).
  const totalReturn = (equity - initial_capital) / initial_capital;
  // Naively annualize: trades-per-year unknown without time context, so we
  // expose totalReturn and let the caller compute CAGR if they pass duration.
  const calmar = maxDDPct > 0 ? totalReturn / maxDDPct : NaN;
  const recoveryFactor = maxDD > 0 ? netProfit / maxDD : NaN;

  // Streaks
  let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
  for (const p of pnls) {
    if (p > 0) { curW++; curL = 0; if (curW > maxWinStreak) maxWinStreak = curW; }
    else if (p < 0) { curL++; curW = 0; if (curL > maxLossStreak) maxLossStreak = curL; }
    else { curW = 0; curL = 0; }
  }

  // Concentration: how much of profit comes from top 10% of trades?
  const sortedByPnl = [...pnls].sort((a, b) => b - a);
  const top10Count = Math.max(1, Math.floor(pnls.length * 0.1));
  const top10Sum = sortedByPnl.slice(0, top10Count).reduce((a, b) => a + b, 0);
  const concentrationTop10 = netProfit !== 0 ? top10Sum / netProfit : NaN;

  // Sharpe of trade-level P&L (NOT annualised — this is per-trade Sharpe).
  const m = mean(pnls);
  const s = stdev(pnls);
  const sharpePerTrade = s > 0 ? m / s : NaN;
  // Naive annualisation if user passes a meaningful bars_per_year (default 252).
  const sharpeAnnualised = Number.isFinite(sharpePerTrade)
    ? sharpePerTrade * Math.sqrt(pnls.length * bars_per_year / pnls.length)
    : NaN;

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : NaN;

  const verdict = [];
  if (pnls.length < 30) verdict.push('LOW_SAMPLE_SIZE (<30 trades — alpha cannot be distinguished from luck)');
  if (winRate < 0.4 && rMultiple < 1.5) verdict.push('UNFAVORABLE_EDGE (low win rate AND low R-multiple)');
  if (concentrationTop10 > 0.8) verdict.push('TOP_HEAVY (>80% of profit from top 10% trades — likely curve-fit / lottery)');
  if (maxDDPct > 0.30) verdict.push('LARGE_DRAWDOWN (>30% peak-to-trough)');
  if (profitFactor < 1.25) verdict.push('THIN_EDGE (profit factor < 1.25)');
  if (verdict.length === 0) verdict.push('PASSES_BASIC_SCREEN');

  return {
    success: true,
    sample_size: pnls.length,
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    r_multiple: rMultiple,
    expectancy_per_trade: expectancy,
    profit_factor: profitFactor,
    net_profit: netProfit,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    max_drawdown: maxDD,
    max_drawdown_pct: maxDDPct,
    calmar_ratio_naive: calmar,
    recovery_factor: recoveryFactor,
    max_consec_wins: maxWinStreak,
    max_consec_losses: maxLossStreak,
    profit_concentration_top10pct: concentrationTop10,
    sharpe_per_trade: sharpePerTrade,
    sharpe_annualised_naive: sharpeAnnualised,
    verdict,
  };
}

/** Statistical-moment characterisation of trade returns. */
export function tradeDistribution({ trades } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) throw new Error('trades is required');
  const pcts = trades.map(pctTradePnl).filter(Number.isFinite);
  const pnls = trades.map(tradePnl).filter(Number.isFinite);
  const source = pcts.length >= pnls.length ? pcts : pnls;
  const unit = pcts.length >= pnls.length ? 'pct_per_trade' : 'currency_per_trade';
  const n = source.length;
  if (n === 0) throw new Error('No usable returns in trades');
  const m = mean(source);
  const s = stdev(source);
  const sk = skewness(source);
  const kt = kurtosis(source);
  const sorted = [...source].sort((a, b) => a - b);
  const pctile = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const verdict = [];
  if (sk < -0.5) verdict.push('LEFT_TAIL_RISK (skew < -0.5 — large losers dominate distribution)');
  if (kt > 3) verdict.push('FAT_TAILS (excess kurtosis > 3 — outlier-heavy)');
  if (m / s < 0.05 && n > 30) verdict.push('LOW_SIGNAL_TO_NOISE');
  if (verdict.length === 0) verdict.push('DISTRIBUTION_LOOKS_REASONABLE');
  return {
    success: true,
    sample_size: n,
    unit,
    mean: m,
    stdev: s,
    skewness: sk,
    excess_kurtosis: kt,
    min: sorted[0],
    p05: pctile(0.05),
    p25: pctile(0.25),
    median: pctile(0.50),
    p75: pctile(0.75),
    p95: pctile(0.95),
    max: sorted[n - 1],
    verdict,
  };
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014).
 * Adjusts a reported Sharpe down for: (a) skew / kurtosis of returns,
 * (b) multiple-testing bias from how many strategies you tried.
 *
 * Returns the deflated Sharpe ratio + probability that the true Sharpe is > 0.
 *
 * Formula recap:
 *   SR* = sqrt((1-γ_E) * Φ⁻¹(1 - 1/N) + γ_E * Φ⁻¹(1 - 1/(N*e)))
 *   DSR = Φ( (SR - SR*) * sqrt(T-1) / sqrt(1 - skew*SR + ((kurt-1)/4)*SR²) )
 * where T = observations, N = number of independent trials, γ_E ≈ 0.5772 (Euler-Mascheroni)
 */
export function deflateSharpe({ sharpe, observations, n_trials = 1, skew = 0, kurtosis = 3 } = {}) {
  if (!Number.isFinite(sharpe)) throw new Error('sharpe (annualised) is required');
  if (!Number.isFinite(observations) || observations < 2) throw new Error('observations >= 2 is required');
  const T = observations;
  const N = Math.max(1, n_trials);
  const gE = 0.5772156649; // Euler-Mascheroni
  // Inverse normal CDF (Acklam's approximation).
  const erfInv = (x) => {
    const a = 0.147;
    const ln = Math.log(1 - x * x);
    const part1 = 2 / (Math.PI * a) + ln / 2;
    return Math.sign(x) * Math.sqrt(Math.sqrt(part1 * part1 - ln / a) - part1);
  };
  const probit = (p) => Math.SQRT2 * erfInv(2 * p - 1);
  const normCdf = (x) => 0.5 * (1 + (x >= 0 ? 1 : -1) * Math.sqrt(1 - Math.exp(-(2 * x * x) / Math.PI)));
  // Expected max-Sharpe across N IID trials with std-normal SR0
  const expectedMaxSR = N > 1
    ? Math.sqrt(2 * Math.log(N)) - (Math.log(Math.log(N)) + Math.log(4 * Math.PI)) / (2 * Math.sqrt(2 * Math.log(N)))
    : 0;
  // DSR statistic
  const denom = Math.sqrt(Math.max(1e-9, 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe));
  const z = (sharpe - expectedMaxSR) * Math.sqrt(T - 1) / denom;
  const dsr = normCdf(z);
  const verdict = dsr >= 0.95 ? 'HIGHLY_SIGNIFICANT'
                : dsr >= 0.90 ? 'SIGNIFICANT'
                : dsr >= 0.75 ? 'WEAK_EVIDENCE'
                : 'NOT_SIGNIFICANT';
  return {
    success: true,
    sharpe_input: sharpe,
    observations: T,
    n_trials: N,
    expected_max_sharpe_under_null: expectedMaxSR,
    deflated_sharpe_probability: dsr,
    verdict,
    note: dsr < 0.75 && N > 1
      ? `With ${N} trials, expect Sharpe up to ${expectedMaxSR.toFixed(2)} by chance — your ${sharpe.toFixed(2)} is not distinguishable from luck.`
      : undefined,
  };
}

/** Bootstrap p-value: probability the true mean return is > 0 given the trade sample. */
export function bootstrapSignificance({ trades, n_bootstraps = 5000 } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) throw new Error('trades is required');
  const xs = trades.map(t => Number.isFinite(pctTradePnl(t)) ? pctTradePnl(t) : tradePnl(t)).filter(Number.isFinite);
  if (xs.length < 5) throw new Error('Need at least 5 finite trade returns for bootstrap');
  const n = xs.length;
  const observed = mean(xs);
  // Center the sample at zero, then resample to get null distribution of means.
  const centered = xs.map(x => x - observed);
  let countMoreExtreme = 0;
  for (let b = 0; b < n_bootstraps; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += centered[Math.floor(Math.random() * n)];
    const sampleMean = s / n;
    if (Math.abs(sampleMean) >= Math.abs(observed)) countMoreExtreme++;
  }
  const pValue = countMoreExtreme / n_bootstraps;
  return {
    success: true,
    sample_size: n,
    observed_mean: observed,
    n_bootstraps,
    two_sided_p_value: pValue,
    significant_at_5pct: pValue < 0.05,
    significant_at_1pct: pValue < 0.01,
    interpretation: pValue < 0.01 ? 'STRONG_EVIDENCE_OF_EDGE'
                  : pValue < 0.05 ? 'MODEST_EVIDENCE_OF_EDGE'
                  : pValue < 0.10 ? 'MARGINAL'
                  : 'NO_EDGE_DETECTED',
  };
}

/**
 * Closed-form Kelly fraction from win probability + win/loss size ratio.
 * Kelly% = (p*(b+1) - 1) / b, where b = avgWin/avgLoss.
 *
 * Use HALF_KELLY in practice — full Kelly is right on the edge of ruin.
 */
export function kellyFraction({ win_rate, avg_win, avg_loss, cap = 0.5 } = {}) {
  if (!Number.isFinite(win_rate) || win_rate < 0 || win_rate > 1) throw new Error('win_rate must be in [0,1]');
  if (!Number.isFinite(avg_win) || avg_win <= 0) throw new Error('avg_win must be > 0');
  if (!Number.isFinite(avg_loss) || avg_loss <= 0) throw new Error('avg_loss must be > 0');
  const b = avg_win / avg_loss;
  const raw = (win_rate * (b + 1) - 1) / b;
  const safe = Math.max(0, Math.min(cap, raw));
  return {
    success: true,
    win_rate,
    win_loss_ratio: b,
    kelly_raw: raw,
    kelly_capped: safe,
    half_kelly: Math.max(0, raw / 2),
    quarter_kelly: Math.max(0, raw / 4),
    interpretation: raw <= 0 ? 'NO_BET_NEGATIVE_EDGE'
                  : raw < 0.05 ? 'TINY_EDGE_USE_QUARTER_KELLY'
                  : raw < 0.20 ? 'NORMAL_EDGE_USE_HALF_KELLY'
                  : 'STRONG_EDGE_BUT_CAP_AT_25_PCT_TO_LIMIT_VARIANCE',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Siyolah-canonical statistical / contract toolkit (added in v2.4.0).
//  Mirrors implementations in:
//    C:\Users\User\siyolah-v3\scripts\inference_upgrades.py
//    C:\Users\User\siyolah-v3\outputs\path_e\retail_execution_contract.json
//  Numerical parity is enforced via tests/parity/parity.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

const EULER_GAMMA = 0.5772156649015329;
const MIN_N_TRIALS_STRICT = 50;

// Yield k-combinations of arr lexicographically (mirrors itertools.combinations).
function* combinations(arr, k) {
  if (k <= 0 || k > arr.length) return;
  if (k === arr.length) { yield arr.slice(); return; }
  if (k === 1) { for (const x of arr) yield [x]; return; }
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i];
    for (const tail of combinations(arr.slice(i + 1), k - 1)) yield [head, ...tail];
  }
}

// Acklam (1995) inverse normal CDF, max relative error 1.15e-9.
function probitAcklam(p) {
  if (!Number.isFinite(p)) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5])
         / ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5]) * q
         / (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5])
         / ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  }
}

// Normal CDF via A&S 7.1.26 (max error ~7.5e-8). Sufficient for HAC p-values
// and DSR final-stage CDF; parity tests budget 1e-7 tolerance for tools that
// chain probit + cdf, and 1e-12 tolerance for arithmetic-only tools.
function normCdfFast(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const erfApprox = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax*ax);
  return 0.5 * (1 + sign * erfApprox);
}

/**
 * Probability of Backtest Overfitting via Combinatorial Symmetric Cross-Validation.
 * Bailey-Borwein-López de Prado-Zhu 2017. Mirrors siyolah-v3 pbo_cscv verbatim.
 *
 * Input `pnl_matrix` is a 2D array of shape [T observations][N strategies]
 * (note: same orientation as the Python numpy array, NOT transposed).
 * Splits the T observations into n_slices equal blocks, then for each
 * combinations(n_slices, n_slices/2) IS/OOS split: picks the in-sample
 * winner, computes its out-of-sample rank-fraction, applies logit. PBO is
 * the fraction of splits whose IS winner has logit(OOS rank-frac) ≤ 0.
 */
export function pboCscv({ pnl_matrix, n_slices = 8 } = {}) {
  if (!Array.isArray(pnl_matrix) || pnl_matrix.length === 0 || !Array.isArray(pnl_matrix[0])) {
    return { success: false, error: 'pnl_matrix must be a 2D array shaped [observations][strategies]' };
  }
  const T = pnl_matrix.length;
  const N = pnl_matrix[0].length;
  if (!pnl_matrix.every(row => Array.isArray(row) && row.length === N)) {
    return { success: false, error: 'pnl_matrix rows must all have the same length' };
  }
  if (N < 2 || T < Math.max(2 * n_slices, 20)) {
    return {
      success: true, pbo: NaN, n_trials: N, n_observations: T, n_slices,
      verdict: 'INSUFFICIENT_DATA',
      note: `Need N≥2 strategies and T≥max(2·n_slices, 20). Got N=${N}, T=${T}, n_slices=${n_slices}.`,
    };
  }
  if (n_slices % 2 === 1) n_slices -= 1;
  if (n_slices < 4) n_slices = 4;
  const block = Math.floor(T / n_slices);
  if (block < 2) {
    return {
      success: true, pbo: NaN, n_trials: N, n_observations: T, n_slices,
      verdict: 'INSUFFICIENT_DATA', note: `Block size T/n_slices = ${block} < 2.`,
    };
  }

  const blocks = [];
  for (let i = 0; i < n_slices; i++) blocks.push(pnl_matrix.slice(i * block, (i + 1) * block));

  // np.nanmean / np.nanstd(ddof=1) per column
  const nanmeanstd = (mat) => {
    const m = mat[0].length;
    const means = new Array(m).fill(0);
    const counts = new Array(m).fill(0);
    for (const row of mat) for (let c = 0; c < m; c++) {
      const v = row[c]; if (Number.isFinite(v)) { means[c] += v; counts[c]++; }
    }
    for (let c = 0; c < m; c++) means[c] = counts[c] > 0 ? means[c] / counts[c] : NaN;
    const sumSq = new Array(m).fill(0);
    for (const row of mat) for (let c = 0; c < m; c++) {
      const v = row[c]; if (Number.isFinite(v)) sumSq[c] += (v - means[c]) ** 2;
    }
    const stds = sumSq.map((s, c) => counts[c] > 1 ? Math.sqrt(s / (counts[c] - 1)) : NaN);
    return { means, stds };
  };

  const half = n_slices / 2;
  const eps = 1e-12;
  let n_neg = 0, n_total = 0;
  const sliceIdx = Array.from({ length: n_slices }, (_, i) => i);

  for (const is_idx of combinations(sliceIdx, half)) {
    const isSet = new Set(is_idx);
    const oos_idx = sliceIdx.filter(j => !isSet.has(j));
    const isPnl = []; for (const i of is_idx) for (const row of blocks[i]) isPnl.push(row);
    const oosPnl = []; for (const j of oos_idx) for (const row of blocks[j]) oosPnl.push(row);

    const { means: isM, stds: isS } = nanmeanstd(isPnl);
    const { means: osM, stds: osS } = nanmeanstd(oosPnl);

    const is_sr = isM.map((m, c) => (Number.isFinite(m) && Number.isFinite(isS[c])) ? m / (isS[c] + eps) : -Infinity);
    const oos_sr = osM.map((m, c) => (Number.isFinite(m) && Number.isFinite(osS[c])) ? m / (osS[c] + eps) : -Infinity);
    for (let c = 0; c < N; c++) {
      if (!Number.isFinite(is_sr[c])) is_sr[c] = -Infinity;
      if (!Number.isFinite(oos_sr[c])) oos_sr[c] = -Infinity;
    }
    if (!is_sr.some(Number.isFinite)) continue;

    let n_star = 0;
    for (let c = 1; c < N; c++) if (is_sr[c] > is_sr[n_star]) n_star = c;

    const finiteOos = oos_sr.filter(Number.isFinite);
    if (finiteOos.length < 2) continue;

    let leCount = 0;
    for (const v of finiteOos) if (v <= oos_sr[n_star]) leCount++;
    let rankFrac = leCount / finiteOos.length;
    rankFrac = Math.min(Math.max(rankFrac, 1 / (N + 1)), 1 - 1 / (N + 1));
    const logit = Math.log(rankFrac / (1 - rankFrac));
    if (logit <= 0) n_neg++;
    n_total++;
  }

  const pbo = n_total > 0 ? n_neg / n_total : NaN;
  const verdict = !Number.isFinite(pbo) ? 'INSUFFICIENT_DATA'
                : pbo >= 0.5 ? 'OVERFIT (PBO ≥ 0.5 — leaderboard is noise)'
                : pbo >= 0.3 ? 'BORDERLINE (0.3 ≤ PBO < 0.5)'
                : 'ROBUST (PBO < 0.3 — selection looks defensible)';

  return {
    success: true,
    pbo,
    n_trials: N,
    n_observations: T,
    n_slices,
    block_size: block,
    splits_evaluated: n_total,
    neg_splits: n_neg,
    verdict,
    note: 'Mirrors siyolah-v3 scripts/inference_upgrades.py::pbo_cscv (Bailey-Borwein-LdP-Zhu 2017).',
  };
}

// Andrews 1991 / Newey-West 1994 bandwidth rule for HAC lag length.
function hacLagRule(n, floor = 11) {
  return Math.max(floor, Math.ceil(4 * Math.pow(n / 100, 2 / 9)));
}

/**
 * Intercept-only Newey-West HAC inference on a returns series. Wraps the
 * X=column-of-ones case of siyolah-v3 newey_west_se. With X=1_n, the OLS
 * coefficient reduces to the sample mean, residuals are demeaned returns,
 * and the sandwich variance simplifies to (S_0 + 2·Σ w_L·Σ e[t]e[t-L]) / n²
 * with Bartlett weights w_L = 1 − L/(L+1).
 */
export function hacInference({ returns, breakeven = 0.0045, maxlags } = {}) {
  if (!Array.isArray(returns)) throw new Error('returns must be an array');
  const r = returns.filter(Number.isFinite);
  const n = r.length;
  if (n < 10) throw new Error(`Need at least 10 finite returns; got ${n}`);
  const lag = (maxlags == null || !Number.isFinite(maxlags) || maxlags < 0) ? hacLagRule(n) : Math.floor(maxlags);

  const beta = r.reduce((a, b) => a + b, 0) / n;
  const resid = r.map(x => x - beta);

  let S = 0;
  for (let t = 0; t < n; t++) S += resid[t] * resid[t];
  for (let L = 1; L <= lag; L++) {
    const w = 1 - L / (lag + 1);
    let Om = 0;
    for (let t = L; t < n; t++) Om += resid[t] * resid[t - L];
    S += w * 2 * Om;
  }

  const var_b = S / (n * n);
  const se = var_b > 0 ? Math.sqrt(var_b) : NaN;
  const t_zero = se > 0 ? beta / se : NaN;
  const t_be = se > 0 ? (beta - breakeven) / se : NaN;
  const oneSidedP = (t) => Number.isFinite(t) ? 1 - normCdfFast(t) : NaN;

  return {
    success: true,
    n,
    mean: beta,
    hac_se: se,
    t_zero,
    t_breakeven: t_be,
    p_one_sided_zero: oneSidedP(t_zero),
    p_one_sided_breakeven: oneSidedP(t_be),
    breakeven_used: breakeven,
    lag_used: lag,
    note: 'Intercept-only Newey-West HAC SE, Bartlett kernel. Mirrors siyolah-v3 newey_west_se on a (n,1) design matrix of ones.',
  };
}

/**
 * Canonical Bailey/López de Prado Deflated Sharpe Ratio, aligned to
 * siyolah-v3 deflated_sharpe_ratio. Requires sr_variance (variance of trial
 * Sharpes across n_trials). Refuses to compute when n_trials < 50 unless
 * `allow_preregistered_under_floor: true` is passed alongside a committed
 * pre-registration manifest in siyolah-v3 research/preregistered_batches/.
 *
 * Differs from the existing alpha_deflate_sharpe (which uses an asymptotic
 * approximation for the expected max Sharpe under null): this version uses
 * Bailey's exact form sr0 = sqrt(v)·((1−γ_E)·Φ⁻¹(1−1/N) + γ_E·Φ⁻¹(1−1/(N·e))).
 */
export function deflateSharpeSiyolah({
  returns, n_trials, sr_variance, skew, kurt, allow_preregistered_under_floor = false,
} = {}) {
  if (!Array.isArray(returns)) throw new Error('returns must be an array');
  if (!Number.isFinite(n_trials)) throw new Error('n_trials is required (integer ≥ 1)');
  if (!Number.isFinite(sr_variance)) throw new Error('sr_variance is required (number ≥ 0; pass 0 to trigger the single-trial fallback)');

  const nt = Math.floor(n_trials);
  if (nt < MIN_N_TRIALS_STRICT && !allow_preregistered_under_floor) {
    throw new Error(
      `DSR n_trials must reflect full search universe; got ${nt}. ` +
      `Pre-registered batches with n_trials < ${MIN_N_TRIALS_STRICT} require a committed manifest in ` +
      `siyolah-v3 research/preregistered_batches/<name>.json with commit hash predating the hunt. ` +
      `Pass allow_preregistered_under_floor: true to bypass (only if you have such a manifest).`
    );
  }

  const r = returns.filter(Number.isFinite);
  const T = r.length;
  if (T < 30) {
    return {
      success: true, dsr: 0, sharpe: NaN, expected_max_sharpe_under_null: NaN,
      n_trials: nt, sr_variance_used: sr_variance, skew_used: 0, kurt_used: 3, T,
      verdict: 'INSUFFICIENT_SAMPLE (T<30)',
    };
  }

  const meanR = r.reduce((a, b) => a + b, 0) / T;
  let varR = 0; for (const x of r) varR += (x - meanR) ** 2;
  varR = varR / (T - 1);
  const sd = Math.sqrt(varR);
  if (!Number.isFinite(sd) || sd <= 0) {
    return {
      success: true, dsr: 0, sharpe: NaN, expected_max_sharpe_under_null: NaN,
      n_trials: nt, sr_variance_used: sr_variance, skew_used: 0, kurt_used: 3, T,
      verdict: 'ZERO_VARIANCE',
    };
  }

  const sr = meanR / sd;

  // Bias-corrected Fisher-Pearson skewness (matches scipy.stats.skew bias=False).
  let s = skew;
  if (s == null || !Number.isFinite(s)) {
    let sum3 = 0; for (const x of r) sum3 += ((x - meanR) / sd) ** 3;
    s = (T >= 3) ? (T / ((T - 1) * (T - 2))) * sum3 : 0;
  }
  if (!Number.isFinite(s)) s = 0;

  // Pearson kurtosis (not excess) with bias correction; matches
  // scipy.stats.kurtosis(fisher=False, bias=False). Formula: bias-corrected
  // excess kurtosis + 3.
  let k = kurt;
  if (k == null || !Number.isFinite(k)) {
    let sum4 = 0; for (const x of r) sum4 += ((x - meanR) / sd) ** 4;
    if (T >= 4) {
      const excess = (T * (T + 1)) / ((T - 1) * (T - 2) * (T - 3)) * sum4
                   - (3 * (T - 1) ** 2) / ((T - 2) * (T - 3));
      k = excess + 3;
    } else {
      k = 3;
    }
  }
  if (!Number.isFinite(k) || k <= 0) k = 3;

  const N = Math.max(nt, 2);
  let v = sr_variance;
  if (!Number.isFinite(v) || v <= 0) {
    // PSR-like single-trial fallback (matches Python).
    v = Math.max((1 - s * sr + ((k - 1) / 4) * sr * sr) / Math.max(T - 1, 1), 1e-12);
  }

  const sr0 = Math.sqrt(v) * (
    (1 - EULER_GAMMA) * probitAcklam(1 - 1 / N)
    + EULER_GAMMA * probitAcklam(1 - 1 / (N * Math.E))
  );
  const denom = Math.sqrt(Math.max(1 - s * sr + ((k - 1) / 4) * sr * sr, 1e-12));
  const z = ((sr - sr0) * Math.sqrt(Math.max(T - 1, 1))) / denom;
  let dsr = normCdfFast(z);
  if (!Number.isFinite(dsr)) dsr = 0;
  dsr = Math.max(0, Math.min(1, dsr));

  const verdict = dsr >= 0.95 ? 'HIGHLY_SIGNIFICANT'
                : dsr >= 0.90 ? 'SIGNIFICANT'
                : dsr >= 0.75 ? 'WEAK_EVIDENCE'
                : 'NOT_SIGNIFICANT';

  return {
    success: true,
    sharpe: sr,
    expected_max_sharpe_under_null: sr0,
    dsr,
    n_trials: nt,
    sr_variance_used: v,
    skew_used: s,
    kurt_used: k,
    T,
    verdict,
    note: 'Mirrors siyolah-v3 scripts/inference_upgrades.py::deflated_sharpe_ratio. Probit via Acklam (≤1.15e-9), normCdf via A&S 7.1.26 (~7.5e-8). Parity tests use 1e-7 tolerance.',
  };
}

// Frozen retail contract — values pulled verbatim from
// C:\Users\User\siyolah-v3\outputs\path_e\retail_execution_contract.json
// (committed_at_git_sha 6c476b7f6fdd3c41c65cacb3e03f79ca8c81a887, 2026-05-18).
const RETAIL_CONTRACT = Object.freeze({
  contract_version: '1.0.0',
  committed_at_git_sha: '6c476b7f6fdd3c41c65cacb3e03f79ca8c81a887',
  committed_at_utc: '2026-05-18T21:05:22+00:00',
  account_type: 'derayah_retail',
  market: 'tasi_cash_equities',
  cost_profile_name: 'PERSONAL_DERAYAH_TASI',
  shorting_allowed: false,
  short_exposure_allowed: false,
  naked_short_allowed: false,
  synthetic_short_allowed: false,
  pair_spread_pnl_allowed: false,
  margin_allowed: false,
  position_mechanics: 'long_or_cash',
  min_basket_constituents: 2,
  max_basket_constituents: 10,
  max_weight_per_position: 0.4,
  cash_weight_minimum: 0.05,
  position_notional_sar_min: 10_000,
  position_notional_sar_default: 50_000,
  position_notional_sar_max: 50_000,
  liquidity_floor_adtv_sar: 3_000_000,
  max_round_trips_per_day: 4,
  min_holding_period_days: 1,
  trading_days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
  broker_commission_bps: 0,
  regulatory_exchange_bps_per_side: 5,
  impact_k_bps: 0.5,
  drawdown_limit_pct: 0.2,
});

/**
 * Hard pass/fail gate against retail_execution_contract.json v1.0.0.
 * Returns per-check results; `pass` is true only if every check passes.
 * Use BEFORE promoting any candidate from backtest to forward-paper.
 */
export function retailLongOnlyGate({ trades, symbol_adtv_sar = {}, overrides = {} } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error('trades must be a non-empty array of trade objects');
  }
  const C = { ...RETAIL_CONTRACT, ...overrides };
  const failed = [], passed = [];
  const record = (name, ok, message, extra = {}) =>
    (ok ? passed : failed).push({ name, pass: ok, message, ...extra });

  // 1. No shorts.
  const shortTrades = trades.filter(t => {
    const side = String(t.side || '').toLowerCase();
    return side === 'short' || side === 'sell_short' || (typeof t.qty === 'number' && t.qty < 0);
  });
  record('checkNoShorts', shortTrades.length === 0,
    shortTrades.length === 0 ? 'No short positions detected'
      : `${shortTrades.length} short trade(s) violate long-only contract`,
    { violating_count: shortTrades.length, violating_examples: shortTrades.slice(0, 3) });

  // 2. Position notional bounds (SAR).
  const sizingViolations = trades.filter(t => {
    const notional = Math.abs(
      Number(t.notional) ||
      (Number(t.qty || 0) * Number(t.entry_price || t.price || 0))
    );
    return notional > 0 && (notional < C.position_notional_sar_min || notional > C.position_notional_sar_max);
  });
  record('checkPositionNotional', sizingViolations.length === 0,
    sizingViolations.length === 0
      ? `All position notionals within [${C.position_notional_sar_min}, ${C.position_notional_sar_max}] SAR`
      : `${sizingViolations.length} trade(s) outside [${C.position_notional_sar_min}, ${C.position_notional_sar_max}] SAR`,
    { violating_count: sizingViolations.length, violating_examples: sizingViolations.slice(0, 3) });

  // 3. ADTV floor.
  const adtvViolations = [];
  const missingADTV = new Set();
  for (const t of trades) {
    const sym = t.symbol;
    if (!sym) continue;
    if (sym in symbol_adtv_sar) {
      if (symbol_adtv_sar[sym] < C.liquidity_floor_adtv_sar) {
        adtvViolations.push({ symbol: sym, adtv_sar: symbol_adtv_sar[sym] });
      }
    } else {
      missingADTV.add(sym);
    }
  }
  const adtvOk = adtvViolations.length === 0 && missingADTV.size === 0;
  record('checkADTVFloor', adtvOk,
    adtvOk
      ? `All symbols meet ADTV ≥ ${C.liquidity_floor_adtv_sar.toLocaleString()} SAR`
      : `${adtvViolations.length} symbol(s) below ADTV floor; ${missingADTV.size} symbol(s) missing ADTV data`,
    { violating_symbols: adtvViolations, missing_adtv_symbols: [...missingADTV].slice(0, 10) });

  // 4. Round-trips per day.
  const tradesByDate = {};
  for (const t of trades) {
    const d = String(t.entry_date || t.date || '').slice(0, 10);
    if (!d) continue;
    tradesByDate[d] = (tradesByDate[d] || 0) + 1;
  }
  const overTripDays = Object.entries(tradesByDate).filter(([, n]) => n > C.max_round_trips_per_day);
  record('checkRoundTripsPerDay', overTripDays.length === 0,
    overTripDays.length === 0
      ? `All days within ${C.max_round_trips_per_day} round-trips`
      : `${overTripDays.length} day(s) exceeded ${C.max_round_trips_per_day} round-trips`,
    { violating_days: overTripDays.slice(0, 5).map(([d, n]) => ({ date: d, trade_count: n })) });

  // 5. Basket bounds.
  const uniqueSymbols = new Set(trades.map(t => t.symbol).filter(Boolean));
  const basketOk = uniqueSymbols.size >= C.min_basket_constituents
                && uniqueSymbols.size <= C.max_basket_constituents;
  record('checkBasketBounds', basketOk,
    basketOk
      ? `Basket has ${uniqueSymbols.size} constituents (within [${C.min_basket_constituents}, ${C.max_basket_constituents}])`
      : `Basket has ${uniqueSymbols.size} constituents — outside [${C.min_basket_constituents}, ${C.max_basket_constituents}]`,
    { unique_symbol_count: uniqueSymbols.size });

  // 6. Cost floor (round-trip).
  const minRoundTripBps = 2 * C.regulatory_exchange_bps_per_side + C.impact_k_bps;
  const costViolations = trades.filter(t => {
    const cb = Number(t.cost_bps);
    return Number.isFinite(cb) && cb < minRoundTripBps;
  });
  const noCostInfo = trades.filter(t => !Number.isFinite(Number(t.cost_bps))).length;
  record('checkCostFloor', costViolations.length === 0,
    costViolations.length === 0
      ? `All trades with cost info meet ≥${minRoundTripBps} bps round-trip floor`
        + (noCostInfo ? ` (${noCostInfo} trades lack cost_bps and are not gated)` : '')
      : `${costViolations.length} trade(s) below ${minRoundTripBps} bps round-trip cost floor`,
    { violating_count: costViolations.length, min_required_bps: minRoundTripBps,
      violating_examples: costViolations.slice(0, 3) });

  return {
    success: true,
    pass: failed.length === 0,
    failed_checks: failed,
    passed_checks: passed,
    contract_version: C.contract_version,
    contract_git_sha: C.committed_at_git_sha,
    overrides_applied: Object.keys(overrides),
    note: 'Encodes siyolah-v3 outputs/path_e/retail_execution_contract.json v1.0.0. Use overrides ONLY for testing.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chart-connected workflows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-run the active strategy across multiple symbols (keeping the same
 * Pine source / inputs / timeframe) and report metric dispersion. A real
 * alpha generalises; a curve-fit overfit collapses on new symbols.
 *
 * Returns per-symbol metrics + summary stats (median, % positive Sharpe,
 * dispersion). Slow: ~5s per symbol (chart load + backtest recompute).
 */
export async function robustnessCheck({ symbols, settle_ms = 4000 } = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols is required: ["AMEX:SPY","NASDAQ:QQQ","BINANCE:BTCUSDT", ...]');
  }
  // Snapshot original symbol for restoration.
  const origState = await evaluate(`(function(){var c=${CHART_API};return {symbol:c.symbol(),resolution:c.resolution()};})()`);
  const rows = [];
  for (const sym of symbols) {
    try {
      await setSymbol({ symbol: sym });
      await waitForChartReady(sym);
      await new Promise(r => setTimeout(r, settle_ms));
      const summary = await getStrategyResults({ summary: true });
      const m = summary?.metrics || {};
      rows.push({
        symbol: sym,
        sharpe_ratio: m.sharpe_ratio,
        sortino_ratio: m.sortino_ratio,
        net_profit_pct: m.net_profit_pct,
        profit_factor: m.profit_factor,
        total_trades: m.total_trades,
        win_rate: m.percent_profitable,
        max_drawdown_pct: m.max_drawdown_pct,
      });
    } catch (e) {
      rows.push({ symbol: sym, error: e.message });
    }
  }
  // Restore.
  try { if (origState?.symbol) await setSymbol({ symbol: origState.symbol }); } catch {}

  const sharpes = rows.map(r => r.sharpe_ratio).filter(Number.isFinite);
  const profits = rows.map(r => r.net_profit_pct).filter(Number.isFinite);
  const positiveSharpe = sharpes.filter(s => s > 0).length;
  const sorted = [...sharpes].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const dispersion = stdev(sharpes);

  const verdict = sharpes.length === 0 ? 'NO_DATA'
    : positiveSharpe / sharpes.length >= 0.7 && median > 0.5 ? 'ROBUST_ALPHA (generalises across symbols)'
    : positiveSharpe / sharpes.length >= 0.5 ? 'BORDERLINE (works on ~half — investigate which regimes fail)'
    : 'LIKELY_OVERFIT (collapses on out-of-sample symbols)';

  return {
    success: true,
    symbols_tested: symbols.length,
    successful: rows.filter(r => !r.error).length,
    median_sharpe: median,
    sharpe_dispersion: dispersion,
    pct_positive_sharpe: sharpes.length ? positiveSharpe / sharpes.length : 0,
    mean_net_profit_pct: mean(profits),
    verdict,
    per_symbol: rows,
  };
}

/**
 * Walk-forward analysis: optimise strategy inputs on an in-sample window via
 * grid_search, lock in the best params, then test on the out-of-sample window.
 *
 * Reports IS Sharpe, OOS Sharpe, and degradation ratio (OOS/IS). A true alpha
 * survives the OOS test; an overfit one degrades by >50%.
 *
 * NOTE: This relies on chart_set_visible_range to constrain the backtest window,
 * which TradingView strategies respect if `process_orders_on_close=true`. For
 * strategies that ignore the visible-range constraint, use a date filter inside
 * the Pine code (see `daterange_window` template).
 */
export async function walkForward({ axes, train_from, train_to, test_from, test_to, metric = 'sharpe_ratio', settle_ms = 1800 } = {}) {
  if (!Array.isArray(axes) || axes.length === 0) throw new Error('axes is required (see pine_grid_search)');
  for (const f of ['train_from', 'train_to', 'test_from', 'test_to']) {
    const v = { train_from, train_to, test_from, test_to }[f];
    if (!Number.isFinite(Number(v))) throw new Error(`${f} must be a unix timestamp (seconds)`);
  }

  // 1. Restrict to in-sample window, run grid_search, capture best inputs.
  await evaluate(`
    (function(){
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex(), endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${Number(train_from)} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${Number(train_to)}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, settle_ms));
  const gs = await gridSearch({ axes, metric, settle_ms });
  const best = gs.leaderboard?.[0];
  if (!best) {
    return { success: false, error: 'Grid search returned no successful combinations.' };
  }
  const isMetricVal = best[metric];

  // 2. Lock in best inputs, switch to OOS window, read metric.
  await setStrategyInputs({ inputs: best.inputs });
  await evaluate(`
    (function(){
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex(), endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${Number(test_from)} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${Number(test_to)}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, settle_ms));
  const oos = await getStrategyResults({ summary: true });
  const oosMetricVal = oos?.metrics?.[metric];

  const ratio = (Number.isFinite(isMetricVal) && isMetricVal !== 0 && Number.isFinite(oosMetricVal))
    ? oosMetricVal / isMetricVal : NaN;

  let verdict;
  if (!Number.isFinite(oosMetricVal)) verdict = 'OOS_METRIC_UNAVAILABLE';
  else if (oosMetricVal <= 0) verdict = 'FAILED_OUT_OF_SAMPLE (no edge in test window)';
  else if (ratio >= 0.7) verdict = 'ROBUST (OOS within 30% of IS — likely real alpha)';
  else if (ratio >= 0.3) verdict = 'DEGRADED (OOS lost 30-70% of edge — partial overfit)';
  else verdict = 'OVERFIT (OOS lost >70% of edge — backtest was curve-fit)';

  return {
    success: true,
    metric,
    train_window: { from: train_from, to: train_to },
    test_window:  { from: test_from,  to: test_to },
    best_inputs: best.inputs,
    in_sample_metric: isMetricVal,
    out_of_sample_metric: oosMetricVal,
    degradation_ratio: ratio,
    verdict,
    in_sample_full: best,
    out_of_sample_full: oos?.metrics || null,
    note: 'In-sample uses the chart\'s visible-range zoom. Strategies that ignore the range (no date-filter in Pine) will not honour the split — use the `daterange_window` template instead.',
  };
}
