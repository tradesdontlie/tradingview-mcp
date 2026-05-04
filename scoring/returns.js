/**
 * Returns dimension scorer.
 *
 * compute(trades, equity, params?) → { score: 0–100, components, evidence }
 *
 * Components:
 *   sharpe, sortino, cagr, maxDrawdown, calmar,
 *   totalReturn, winRate, profitFactor, avgWinPct, avgLossPct, tradeCount
 *
 * Scoring rubric (all equally weighted within this dimension):
 *   Sharpe ≥ 2.0 → 100,  ≥ 1.0 → 70,  ≥ 0.5 → 40,  < 0 → 0
 *   Sortino ≥ 3.0 → 100, ≥ 1.5 → 70,  ≥ 0.75 → 40, < 0 → 0
 *   CAGR ≥ 30% → 100,    ≥ 15% → 75,  ≥ 5% → 50,   < 0 → 0
 *   MaxDD ≤ 5% → 100,    ≤ 15% → 70,  ≤ 30% → 40,  > 50% → 0
 *   Calmar ≥ 3.0 → 100,  ≥ 1.5 → 70,  ≥ 0.5 → 40,  < 0 → 0
 */

const TRADING_DAYS = 252;
const RISK_FREE = 0.05; // annual

/**
 * @param {Trade[]} trades
 * @param {EquityPoint[]} equity  - [{time, equity, drawdown}]
 * @param {object} [params]
 * @returns {{ score: number, components: object, evidence: object }}
 */
export function compute(trades, equity, params = {}) {
  if (!trades?.length || !equity?.length) {
    return emptyResult('No trade or equity data');
  }

  const components = computeComponents(trades, equity);
  const score = scoreComponents(components);

  return {
    score,
    components,
    evidence: buildEvidence(components, trades, equity),
  };
}

function computeComponents(trades, equity) {
  const returns = dailyReturns(equity);
  const sharpe = calcSharpe(returns);
  const sortino = calcSortino(returns);
  const cagr = calcCagr(equity);
  const { maxDrawdown, maxDrawdownDuration } = calcDrawdown(equity);
  const calmar = cagr && maxDrawdown ? cagr / Math.abs(maxDrawdown) : 0;

  const winners = trades.filter(t => (t.profit ?? t.profit_pct ?? 0) > 0);
  const losers = trades.filter(t => (t.profit ?? t.profit_pct ?? 0) <= 0);
  const winRate = trades.length ? winners.length / trades.length : 0;

  const grossProfit = winners.reduce((s, t) => s + Math.abs(t.profit ?? t.profit_pct ?? 0), 0);
  const grossLoss = losers.reduce((s, t) => s + Math.abs(t.profit ?? t.profit_pct ?? 0), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgWinPct = winners.length ? avg(winners.map(t => t.profit_pct ?? 0)) : 0;
  const avgLossPct = losers.length ? avg(losers.map(t => t.profit_pct ?? 0)) : 0;

  const first = equity[0].equity;
  const last = equity[equity.length - 1].equity;
  const totalReturn = first ? (last - first) / first : 0;

  return {
    sharpe,
    sortino,
    cagr,
    maxDrawdown,
    maxDrawdownDuration,
    calmar,
    totalReturn,
    winRate,
    profitFactor,
    avgWinPct,
    avgLossPct,
    tradeCount: trades.length,
    grossProfit,
    grossLoss,
  };
}

function scoreComponents(c) {
  const subScores = [
    clamp(linear(c.sharpe,   [0, 0.5, 1.0, 2.0],   [0, 30, 60, 100])),
    clamp(linear(c.sortino,  [0, 0.75, 1.5, 3.0],   [0, 30, 60, 100])),
    clamp(linear(c.cagr,     [0, 0.05, 0.15, 0.30], [0, 30, 60, 100])),
    clamp(linear(-c.maxDrawdown, [0, 0.05, 0.15, 0.30], [0, 30, 60, 100])), // invert: lower dd = better
    clamp(linear(c.calmar,   [0, 0.5, 1.5, 3.0],    [0, 30, 60, 100])),
  ];
  return Math.round(avg(subScores));
}

function buildEvidence(c, trades, equity) {
  return {
    ...c,
    equityCurve: sampleEquity(equity, 200), // cap for UI
    tradeList: trades.slice(0, 500),         // cap for UI
  };
}

// ── Statistical helpers ───────────────────────────────────────────────────────

function dailyReturns(equity) {
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity;
    const curr = equity[i].equity;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

function calcSharpe(returns) {
  if (!returns.length) return 0;
  const mean = avg(returns);
  const std = stdDev(returns);
  if (std === 0) return 0;
  const dailyRf = RISK_FREE / TRADING_DAYS;
  return ((mean - dailyRf) / std) * Math.sqrt(TRADING_DAYS);
}

function calcSortino(returns) {
  if (!returns.length) return 0;
  const mean = avg(returns);
  const dailyMar = RISK_FREE / TRADING_DAYS;
  const downside = returns.filter(r => r < dailyMar);
  if (!downside.length) return mean > 0 ? 10 : 0;
  const downsideDev = Math.sqrt(avg(downside.map(r => (r - dailyMar) ** 2)));
  if (downsideDev === 0) return 0;
  return ((mean - dailyMar) / downsideDev) * Math.sqrt(TRADING_DAYS);
}

function calcCagr(equity) {
  if (equity.length < 2) return 0;
  const first = equity[0];
  const last = equity[equity.length - 1];
  if (!first.equity || !last.equity) return 0;

  const t0 = parseTime(first.time);
  const t1 = parseTime(last.time);
  const years = (t1 - t0) / (365.25 * 24 * 3600 * 1000);
  if (years <= 0) return 0;

  return (last.equity / first.equity) ** (1 / years) - 1;
}

function calcDrawdown(equity) {
  let peak = -Infinity;
  let maxDD = 0;
  let ddStart = null;
  let maxDuration = 0;

  for (const pt of equity) {
    if (pt.equity > peak) {
      peak = pt.equity;
      ddStart = pt.time;
    }
    const dd = peak > 0 ? (peak - pt.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return { maxDrawdown: maxDD, maxDrawdownDuration: maxDuration };
}

// ── Math primitives ───────────────────────────────────────────────────────────

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(v => (v - m) ** 2)));
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Piecewise linear interpolation.
 * xPoints and yPoints must be the same length and sorted ascending by x.
 */
function linear(x, xPoints, yPoints) {
  if (x <= xPoints[0]) return yPoints[0];
  if (x >= xPoints[xPoints.length - 1]) return yPoints[yPoints.length - 1];
  for (let i = 0; i < xPoints.length - 1; i++) {
    if (x >= xPoints[i] && x < xPoints[i + 1]) {
      const t = (x - xPoints[i]) / (xPoints[i + 1] - xPoints[i]);
      return yPoints[i] + t * (yPoints[i + 1] - yPoints[i]);
    }
  }
  return yPoints[yPoints.length - 1];
}

function parseTime(t) {
  return typeof t === 'number' ? t : new Date(t).getTime();
}

function sampleEquity(equity, maxPts) {
  if (equity.length <= maxPts) return equity;
  const step = Math.ceil(equity.length / maxPts);
  return equity.filter((_, i) => i % step === 0 || i === equity.length - 1);
}

function emptyResult(reason) {
  return {
    score: 0,
    components: {},
    evidence: { error: reason },
  };
}
