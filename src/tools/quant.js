import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/quant.js';

const READ_ONLY  = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const COMPUTE    = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const CHART_MOD  = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// Reusable schema for a trade record. Accepts the format returned by
// strategy_get_report (`{tp:{v,p}, ...}`) OR plain `{pnl, return_pct}`.
// Zod 4: .passthrough() removed; z.looseObject() is the replacement.
const TradeSchema = z.looseObject({});

export function registerQuantTools(server) {
  server.tool('alpha_screen_metrics',
    'Extended trade-level metrics that TradingView\'s default report omits: Calmar ratio, recovery factor, R-multiple, expectancy, max consecutive losses, profit concentration (% of profit from top 10% of trades), and a verdict (PASSES_BASIC_SCREEN, TOP_HEAVY, UNFAVORABLE_EDGE, etc.). Pass the trades array from strategy_get_report() or data_get_trades(). Pure compute — no chart needed.',
    {
      trades: z.array(TradeSchema).min(1).describe('Trade list: pass `trades` from strategy_get_report() or data_get_trades()'),
      initial_capital: z.coerce.number().optional().describe('Starting capital used for drawdown maths (default 100000)'),
      bars_per_year: z.coerce.number().optional().describe('Bars per year for naive Sharpe annualisation (default 252)'),
    },
    async ({ trades, initial_capital, bars_per_year }) => {
      try { return jsonResult(core.screenMetrics({ trades, initial_capital, bars_per_year })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_trade_distribution',
    'Statistical-moment characterisation of trade returns: mean, std, skew, excess kurtosis, percentile spread (p05/p25/p50/p75/p95). Flags LEFT_TAIL_RISK, FAT_TAILS, LOW_SIGNAL_TO_NOISE. Use to detect strategies whose backtest looks great because of one giant winner.',
    {
      trades: z.array(TradeSchema).min(1).describe('Trade list (per-trade return objects)'),
    },
    async ({ trades }) => {
      try { return jsonResult(core.tradeDistribution({ trades })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_deflate_sharpe',
    'Bailey & López de Prado Deflated Sharpe Ratio: adjusts a reported Sharpe down for (a) non-normal returns (skew/kurtosis) and (b) multiple-testing bias from how many variants you tried. Returns the probability that the true Sharpe is > 0. THE single most important test to avoid deploying a backtested fluke.',
    {
      sharpe: z.number().describe('Annualised Sharpe ratio from your backtest'),
      observations: z.number().int().min(2).describe('Number of return observations (bars or trades)'),
      n_trials: z.number().int().min(1).optional().describe('How many variants of this strategy you have tried (default 1). Be honest — multi-grid runs count.'),
      skew: z.number().optional().describe('Skewness of returns (default 0 = normal)'),
      kurtosis: z.number().optional().describe('Kurtosis of returns (default 3 = normal). From alpha_trade_distribution.excess_kurtosis + 3.'),
    },
    async ({ sharpe, observations, n_trials, skew, kurtosis }) => {
      try { return jsonResult(core.deflateSharpe({ sharpe, observations, n_trials, skew, kurtosis })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_bootstrap_significance',
    'Bootstrap p-value: probability the strategy\'s mean trade return is > 0 by chance. Resamples the trade list `n_bootstraps` times under the null (mean = 0) and counts how often the resampled mean is as extreme as observed. Use as a quick "is this a real edge?" check.',
    {
      trades: z.array(TradeSchema).min(5).describe('Trade list (min 5 trades)'),
      n_bootstraps: z.coerce.number().int().min(100).max(50000).optional().describe('Bootstrap iterations (default 5000)'),
    },
    async ({ trades, n_bootstraps }) => {
      try { return jsonResult(core.bootstrapSignificance({ trades, n_bootstraps })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_kelly_fraction',
    'Closed-form Kelly criterion: optimal capital fraction to bet given win rate and avg win/loss ratio. Returns full, half, quarter Kelly + interpretation. Use HALF or QUARTER Kelly in practice — full Kelly is on the edge of ruin.',
    {
      win_rate: z.number().min(0).max(1).describe('Win rate as fraction (0.55 = 55%)'),
      avg_win: z.number().positive().describe('Average winning trade size (absolute value)'),
      avg_loss: z.number().positive().describe('Average losing trade size (absolute value, positive number)'),
      cap: z.number().min(0).max(1).optional().describe('Cap on Kelly fraction (default 0.5 = max 50%)'),
    },
    async ({ win_rate, avg_win, avg_loss, cap }) => {
      try { return jsonResult(core.kellyFraction({ win_rate, avg_win, avg_loss, cap })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_robustness_check',
    'Run the currently-loaded strategy across multiple symbols and report dispersion of Sharpe / profit / drawdown. A real alpha generalises; an overfit strategy collapses. Returns median Sharpe, % positive Sharpe, per-symbol metrics, and a verdict (ROBUST_ALPHA / BORDERLINE / LIKELY_OVERFIT). SLOW: ~5 sec per symbol (chart reload + backtest recompute). Restores original symbol on completion.',
    {
      symbols: z.array(z.string()).min(2).max(20).describe('Symbols to test, e.g. ["AMEX:SPY","NASDAQ:QQQ","BINANCE:BTCUSDT","BINANCE:ETHUSDT","TADAWUL:1180"]'),
      settle_ms: z.coerce.number().int().min(2000).max(15000).optional().describe('Wait between symbol switch and reading metrics (default 4000)'),
    },
    async ({ symbols, settle_ms }) => {
      try { return jsonResult(await core.robustnessCheck({ symbols, settle_ms })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    CHART_MOD);

  server.tool('alpha_walk_forward',
    'Walk-forward analysis: grid-search inputs on an in-sample date window, lock in best params, test on an out-of-sample window, report degradation. The single best alpha-discovery gate before any deployment. WORKS BEST with strategies built from the `daterange_window` template (Pine respects the time filter). Otherwise relies on chart visible-range zoom, which not all strategies honour.',
    {
      axes: z.array(z.object({
        id: z.string(),
        values: z.array(z.union([z.number(), z.string(), z.boolean()])).min(1),
      })).min(1).max(3).describe('Input axes to optimise on (same as pine_grid_search)'),
      train_from: z.coerce.number().describe('Train-window start (unix seconds)'),
      train_to: z.coerce.number().describe('Train-window end (unix seconds)'),
      test_from: z.coerce.number().describe('Test-window start (unix seconds) — should be AFTER train_to'),
      test_to: z.coerce.number().describe('Test-window end (unix seconds)'),
      metric: z.enum(['sharpe_ratio', 'sortino_ratio', 'net_profit', 'net_profit_pct', 'profit_factor', 'percent_profitable']).optional().describe('Metric to optimise (default sharpe_ratio)'),
      settle_ms: z.coerce.number().int().min(500).max(10000).optional().describe('Per-step settle time, ms (default 1800)'),
    },
    async ({ axes, train_from, train_to, test_from, test_to, metric, settle_ms }) => {
      try { return jsonResult(await core.walkForward({ axes, train_from, train_to, test_from, test_to, metric, settle_ms })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    CHART_MOD);

  // ── Siyolah-canonical statistical / contract toolkit (v2.4.0) ──

  server.tool('alpha_pbo_cscv',
    'Bailey/López de Prado Probability of Backtest Overfitting via Combinatorial Symmetric Cross-Validation. Takes a 2D PnL matrix shaped [T observations][N strategy variants] (one column per variant tried, e.g. from pine_grid_search per-bar PnL). Returns PBO = fraction of CSCV splits where the in-sample winner under-performs out-of-sample (logit-rank ≤ 0). PBO ≥ 0.5 = the leaderboard is noise. Mirrors siyolah-v3 scripts/inference_upgrades.py::pbo_cscv.',
    {
      pnl_matrix: z.array(z.array(z.number())).min(2).describe('2D array shaped [T observations][N strategies]. Same orientation as numpy: rows = time, columns = variants.'),
      n_slices: z.coerce.number().int().min(2).max(16).optional().describe('Symmetric CSCV slices (default 8). Auto-rounded down to even and floored at 4.'),
    },
    async ({ pnl_matrix, n_slices }) => {
      try { return jsonResult(core.pboCscv({ pnl_matrix, n_slices })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_hac_inference',
    'Newey-West HAC (heteroskedasticity + autocorrelation consistent) inference on a returns series. Wraps the intercept-only case of siyolah-v3 newey_west_se with a Bartlett kernel. Returns mean return, HAC standard error, t-stat vs zero, t-stat vs breakeven, and one-sided p-values. Use after strategy_get_report to test whether mean trade return is statistically distinguishable from zero (or from a per-trade cost breakeven) with autocorrelation-robust SE.',
    {
      returns: z.array(z.number()).min(10).describe('Per-trade or per-bar return series (decimal, NOT bps — 0.0045 means 45 bps).'),
      breakeven: z.coerce.number().optional().describe('Breakeven threshold to test mean > breakeven (default 0.0045 = 45 bps).'),
      maxlags: z.coerce.number().int().min(0).optional().describe('HAC lag length. Default: Andrews rule max(11, ceil(4·(n/100)^(2/9))).'),
    },
    async ({ returns, breakeven, maxlags }) => {
      try { return jsonResult(core.hacInference({ returns, breakeven, maxlags })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_deflate_sharpe_siyolah',
    'CANONICAL Bailey/López de Prado Deflated Sharpe Ratio (exact formula, mirrors siyolah-v3 scripts/inference_upgrades.py::deflated_sharpe_ratio). Differs from alpha_deflate_sharpe (which uses an asymptotic approximation): this version requires sr_variance — the empirical variance of trial Sharpe ratios across n_trials — and uses Euler-Mascheroni γ_E = 0.5772156649015329 with explicit probit calls. REFUSES n_trials < 50 unless allow_preregistered_under_floor is true (then requires a committed pre-registration manifest). Use when validating a candidate against Siyolah Phase-4 gate.',
    {
      returns: z.array(z.number()).min(10).describe('Per-period return series (NOT pre-computed Sharpe — function computes Sharpe internally).'),
      n_trials: z.coerce.number().int().min(1).describe('Number of independent strategy variants tried — be honest, read from hypothesis_log.md. Refuses if < 50 unless allow_preregistered_under_floor.'),
      sr_variance: z.coerce.number().min(0).describe('Empirical variance of trial Sharpe ratios across the n_trials tested. Pass 0 to trigger the single-trial PSR-like fallback.'),
      skew: z.coerce.number().optional().describe('Skewness of returns (Fisher-Pearson, bias-corrected). Computed from returns if omitted.'),
      kurt: z.coerce.number().optional().describe('Pearson kurtosis (NOT excess; bias-corrected). Computed from returns if omitted (kurt = excess_kurt + 3).'),
      allow_preregistered_under_floor: z.coerce.boolean().optional().describe('Set true only when n_trials < 50 AND a committed pre-registration manifest exists in siyolah-v3 research/preregistered_batches/.'),
    },
    async ({ returns, n_trials, sr_variance, skew, kurt, allow_preregistered_under_floor }) => {
      try { return jsonResult(core.deflateSharpeSiyolah({ returns, n_trials, sr_variance, skew, kurt, allow_preregistered_under_floor })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);

  server.tool('alpha_retail_long_only_gate',
    'Encodes the Siyolah retail_execution_contract.json v1.0.0 as a hard pass/fail gate. Refuses any trade list that violates Derayah retail constraints: no shorts, no margin, no pair-trade PnL, basket 2-10 names, position notional 10k-50k SAR, ADTV ≥ 3M SAR, ≤4 round-trips/day, round-trip cost ≥10.5 bps (2·regulatory + impact_k). Returns per-check pass/fail with violating rows surfaced. Use BEFORE promoting a candidate from backtest to forward-paper.',
    {
      trades: z.array(z.looseObject({})).min(1).describe('Trade list. Each trade should have at minimum: side, qty, notional (or qty+price), symbol, entry_date, optional cost_bps.'),
      symbol_adtv_sar: z.record(z.string(), z.number()).optional().describe('Map of symbol → average daily turnover (SAR). Required for ADTV gate; missing symbols fail the check.'),
      overrides: z.looseObject({}).optional().describe('Field overrides for testing only. Production callers leave empty so the frozen contract is enforced.'),
    },
    async ({ trades, symbol_adtv_sar, overrides }) => {
      try { return jsonResult(core.retailLongOnlyGate({ trades, symbol_adtv_sar, overrides })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    COMPUTE);
}
