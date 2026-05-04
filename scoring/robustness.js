/**
 * Robustness dimension scorer.
 *
 * compute(trades, equity, params?) → { score: 0–100, components, evidence }
 *
 * Components:
 *   wfe              - Walk-forward efficiency (out-of-sample return / in-sample return)
 *   mcP5             - Monte Carlo 5th percentile final equity (relative to initial)
 *   mcP50            - Monte Carlo 50th percentile
 *   mcP95            - Monte Carlo 95th percentile
 *   mcRuinProbability - % of MC paths that lose > 50% of capital
 *   consistencyRatio - ratio of winning months
 *
 * Scoring rubric:
 *   WFE ≥ 0.8 → 100, ≥ 0.5 → 70, ≥ 0.2 → 40, < 0 → 0
 *   mcP5/mcP50 ≥ 0.9 → 100, ≥ 0.7 → 70, ≥ 0.5 → 40, < 0.3 → 0
 *   Ruin probability ≤ 2% → 100, ≤ 10% → 70, ≤ 25% → 40, > 50% → 0
 *   Consistency ≥ 0.7 → 100, ≥ 0.55 → 70, ≥ 0.45 → 40, < 0.3 → 0
 */

const MC_RUNS = 1000;
const MC_RUIN_THRESHOLD = 0.5; // 50% loss = ruin

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
  const wfe = walkForwardEfficiency(trades);
  const mc = monteCarlo(trades, equity);
  const consistency = monthlyConsistency(equity);

  return {
    wfe,
    mcP5: mc.p5,
    mcP50: mc.p50,
    mcP95: mc.p95,
    mcRuinProbability: mc.ruinPct,
    mcPaths: mc.paths,
    consistencyRatio: consistency,
  };
}

function scoreComponents(c) {
  const wfeScore = clamp(linear(c.wfe, [-0.5, 0, 0.2, 0.5, 0.8], [0, 5, 30, 70, 100]));

  // mcP5/mcP50 ratio: how tight is the downside distribution?
  const mcRatio = c.mcP50 > 0 ? c.mcP5 / c.mcP50 : 0;
  const mcScore = clamp(linear(mcRatio, [0, 0.3, 0.5, 0.7, 0.9], [0, 10, 30, 70, 100]));

  const ruinScore = clamp(linear(c.mcRuinProbability, [0, 0.02, 0.1, 0.25, 0.5], [100, 90, 60, 30, 0]));

  const consistScore = clamp(linear(c.consistencyRatio, [0.3, 0.45, 0.55, 0.7], [0, 30, 60, 100]));

  return Math.round(avg([wfeScore, mcScore, ruinScore, consistScore]));
}

function buildEvidence(c, trades) {
  return {
    ...c,
    mcPaths: c.mcPaths?.slice(0, 50), // 50 sample paths for the chart
  };
}

// ── Walk-forward efficiency ───────────────────────────────────────────────────
// Splits the equity series into IS (first 70%) and OOS (last 30%) by trade index.
// WFE = OOS_return / IS_return

function walkForwardEfficiency(trades) {
  if (trades.length < 10) return 0;
  const split = Math.floor(trades.length * 0.7);
  const is = trades.slice(0, split);
  const oos = trades.slice(split);

  const isReturn = totalReturn(is);
  const oosReturn = totalReturn(oos);

  if (Math.abs(isReturn) < 0.001) return oosReturn > 0 ? 1 : 0;
  return oosReturn / isReturn;
}

function totalReturn(trades) {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + (t.profit_pct ?? 0), 0);
}

// ── Monte Carlo (resample with replacement) ───────────────────────────────────

function monteCarlo(trades, equity) {
  if (trades.length < 5) return { p5: 1, p50: 1, p95: 1, ruinPct: 0, paths: [] };

  const tradeReturns = trades.map(t => t.profit_pct ?? (t.profit ?? 0));
  const initialEquity = equity[0]?.equity || 10000;
  const n = trades.length;

  const finalEquities = [];
  const samplePaths = []; // store a few for the chart

  for (let run = 0; run < MC_RUNS; run++) {
    let eq = initialEquity;
    const path = run < 50 ? [1] : null; // only store first 50 paths

    for (let i = 0; i < n; i++) {
      const r = tradeReturns[Math.floor(Math.random() * n)];
      eq *= (1 + r);
      if (path) path.push(eq / initialEquity);
    }

    if (path) samplePaths.push(path);
    finalEquities.push(eq / initialEquity);
  }

  finalEquities.sort((a, b) => a - b);

  const p5 = percentile(finalEquities, 5);
  const p50 = percentile(finalEquities, 50);
  const p95 = percentile(finalEquities, 95);
  const ruinCount = finalEquities.filter(e => e < (1 - MC_RUIN_THRESHOLD)).length;

  return { p5, p50, p95, ruinPct: ruinCount / MC_RUNS, paths: samplePaths };
}

function percentile(sorted, pct) {
  const idx = Math.floor((pct / 100) * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Monthly consistency ───────────────────────────────────────────────────────

function monthlyConsistency(equity) {
  if (equity.length < 2) return 0;

  const byMonth = {};
  for (const pt of equity) {
    const d = new Date(parseTime(pt.time));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { first: pt.equity, last: pt.equity };
    byMonth[key].last = pt.equity;
  }

  const months = Object.values(byMonth);
  if (!months.length) return 0;
  const profitable = months.filter(m => m.last > m.first).length;
  return profitable / months.length;
}

// ── Math primitives ───────────────────────────────────────────────────────────

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

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

function emptyResult(reason) {
  return { score: 0, components: {}, evidence: { error: reason } };
}
