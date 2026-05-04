/**
 * Cost realism dimension scorer.
 *
 * compute(trades, equity, params, costModel) → { score: 0–100, components, evidence }
 *
 * CostModel defaults: { fee_pct: 0.001, slippage_pct: 0.001, fill_model: 'worst' }
 *
 * Components:
 *   feeImpact       - % return lost to fees
 *   slippageImpact  - % return lost to slippage
 *   netReturnRatio  - net_return / gross_return (higher = more cost-robust)
 *   breakEvenFee    - the fee level at which the strategy breaks even
 *   avgCostPerTrade - average total cost per trade as % of trade value
 *
 * Scoring rubric:
 *   netReturnRatio ≥ 0.90 → 100 (strategy barely affected by realistic costs)
 *   netReturnRatio ≥ 0.75 → 70
 *   netReturnRatio ≥ 0.60 → 40
 *   netReturnRatio < 0.40 → 0
 *
 *   breakEvenFee ≥ 3× realistic_fee → 100 (lots of headroom)
 *   breakEvenFee ≥ 1.5× → 60
 *   breakEvenFee < 0.5× → 0 (already borderline at realistic fees)
 */

const DEFAULT_COST_MODEL = {
  fee_pct: 0.001,      // 0.1% per side
  slippage_pct: 0.001, // 0.1% per side
  fill_model: 'worst', // 'best' | 'avg' | 'worst'
};

export function compute(trades, equity, params = {}, costModel = {}) {
  const model = { ...DEFAULT_COST_MODEL, ...costModel };

  if (!trades?.length) {
    return emptyResult('No trade data');
  }

  const components = computeComponents(trades, equity, model);
  const score = scoreComponents(components, model);

  return {
    score,
    components,
    evidence: buildEvidence(components, trades, model),
  };
}

function computeComponents(trades, equity, model) {
  const grossReturn = equity.length >= 2
    ? (equity[equity.length - 1].equity - equity[0].equity) / equity[0].equity
    : trades.reduce((s, t) => s + (t.profit_pct ?? 0), 0);

  // Total cost per trade = fee_pct * 2 (entry + exit) + slippage_pct * 2
  const costPerTrade = (model.fee_pct + model.slippage_pct) * 2;
  const totalCost = costPerTrade * trades.length;

  // Net return assuming costs are uniformly applied
  const grossTotal = trades.reduce((s, t) => s + (t.profit_pct ?? 0), 0);
  const netTotal = grossTotal - totalCost;

  const netReturnRatio = grossTotal !== 0 ? netTotal / Math.abs(grossTotal) : 0;

  // Fee impact alone
  const feeCost = model.fee_pct * 2 * trades.length;
  const feeImpact = grossTotal !== 0 ? feeCost / Math.abs(grossTotal) : 1;

  // Slippage impact alone
  const slipCost = model.slippage_pct * 2 * trades.length;
  const slippageImpact = grossTotal !== 0 ? slipCost / Math.abs(grossTotal) : 1;

  // Break-even fee: the fee level at which net return = 0
  const breakEvenFee = trades.length > 0
    ? Math.abs(grossTotal) / (trades.length * 2) // per-side fee that zeroes the strategy
    : 0;

  // Stress-test at 3× fees
  const stressCost = costPerTrade * 3 * trades.length;
  const stressNetTotal = grossTotal - stressCost;
  const stressNetReturnRatio = grossTotal !== 0 ? stressNetTotal / Math.abs(grossTotal) : 0;

  return {
    grossReturn,
    netReturn: grossReturn * netReturnRatio,
    netReturnRatio: Math.max(-1, Math.min(1, netReturnRatio)),
    feeImpact,
    slippageImpact,
    totalCostPct: totalCost,
    avgCostPerTrade: costPerTrade,
    breakEvenFee,
    stressNetReturnRatio: Math.max(-1, Math.min(1, stressNetReturnRatio)),
    modelUsed: model,
  };
}

function scoreComponents(c, model) {
  const ratioScore = clamp(linear(c.netReturnRatio, [0, 0.4, 0.6, 0.75, 0.90], [0, 10, 30, 60, 100]));

  // Headroom: how many multiples of the realistic fee is the break-even fee?
  const headroom = model.fee_pct > 0 ? c.breakEvenFee / model.fee_pct : 0;
  const headroomScore = clamp(linear(headroom, [0, 0.5, 1, 1.5, 3], [0, 5, 30, 60, 100]));

  const stressScore = clamp(linear(c.stressNetReturnRatio, [-0.5, 0, 0.3, 0.6, 0.9], [0, 5, 30, 60, 100]));

  return Math.round(avg([ratioScore, headroomScore, stressScore]));
}

function buildEvidence(c, trades, model) {
  // Slippage curve: net return at 0× to 5× baseline fee
  const slippageCurve = [];
  const grossTotal = trades.reduce((s, t) => s + (t.profit_pct ?? 0), 0);
  for (let mult = 0; mult <= 5; mult += 0.5) {
    const cost = model.fee_pct * 2 * mult * trades.length;
    slippageCurve.push({
      multiplier: mult,
      netReturn: grossTotal - cost,
    });
  }

  return {
    ...c,
    slippageCurve,
    tradeCount: trades.length,
  };
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

function emptyResult(reason) {
  return { score: 0, components: {}, evidence: { error: reason } };
}
