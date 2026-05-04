/**
 * Regimes dimension scorer.
 *
 * compute(trades, bars, equity, params?) → { score: 0–100, components, evidence }
 *
 * Regime classification (per bar):
 *   Bull  - close > EMA200 AND ADX > 20
 *   Bear  - close < EMA200 AND ADX > 20
 *   Chop  - ADX ≤ 20 (low trend strength regardless of direction)
 *
 * For each regime we compute:
 *   - % of bars in regime
 *   - # of trades in regime
 *   - Win rate in regime
 *   - Average return per trade
 *   - Sharpe within regime
 *
 * Scoring rubric:
 *   Consistency: strategies that perform well in ≥ 2 regimes score higher
 *   The worst-regime win rate is the key signal (a strategy that only works in one regime is fragile)
 *   Min regime win rate ≥ 0.55 → 100, ≥ 0.45 → 70, ≥ 0.35 → 40, < 0.2 → 0
 *   Regime coverage (% of equity time in each regime balanced) → secondary score
 */

export function compute(trades, bars, equity, params = {}) {
  if (!trades?.length || !bars?.length) {
    return emptyResult('No trade or bar data');
  }

  const regimeMap = classifyRegimes(bars);
  const components = computeComponents(trades, bars, regimeMap);
  const score = scoreComponents(components);

  return {
    score,
    components,
    evidence: buildEvidence(components, bars, regimeMap),
  };
}

// ── Regime classification ─────────────────────────────────────────────────────

function classifyRegimes(bars) {
  const ema200 = computeEma(bars.map(b => b.close), 200);
  const adx = computeAdxSimple(bars, 14);

  const map = new Map();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const e200 = ema200[i];
    const a = adx[i];
    const t = parseTime(bar.time);

    let regime = 'chop';
    if (e200 !== null && a !== null) {
      if (a > 20 && bar.close > e200) regime = 'bull';
      else if (a > 20 && bar.close < e200) regime = 'bear';
    }

    map.set(t, regime);
  }

  return map;
}

function computeComponents(trades, bars, regimeMap) {
  const regimes = { bull: [], bear: [], chop: [] };
  const totalBars = bars.length;
  const barsByRegime = { bull: 0, bear: 0, chop: 0 };

  for (const bar of bars) {
    const r = regimeMap.get(parseTime(bar.time)) || 'chop';
    barsByRegime[r]++;
  }

  // Assign each trade to the regime at its entry time
  for (const trade of trades) {
    const entryTime = parseTime(trade.entry_time ?? trade.entryTime ?? 0);
    const regime = findRegimeAt(regimeMap, entryTime, bars) || 'chop';
    regimes[regime].push(trade);
  }

  const stats = {};
  for (const [regime, rtrades] of Object.entries(regimes)) {
    stats[regime] = tradeStats(rtrades, barsByRegime[regime], totalBars);
  }

  return {
    regimes: stats,
    barDistribution: barsByRegime,
    totalBars,
    totalTrades: trades.length,
  };
}

function tradeStats(trades, barCount, totalBars) {
  if (!trades.length) {
    return {
      tradeCount: 0, winRate: null, avgReturn: 0,
      sharpe: 0, barCount, barPct: barCount / totalBars,
    };
  }

  const returns = trades.map(t => t.profit_pct ?? 0);
  const winners = trades.filter(t => (t.profit_pct ?? 0) > 0).length;
  const winRate = winners / trades.length;
  const avgReturn = returns.reduce((s, v) => s + v, 0) / returns.length;

  const m = avgReturn;
  const variance = returns.reduce((s, v) => s + (v - m) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(252) : 0;

  return {
    tradeCount: trades.length,
    winRate,
    avgReturn,
    sharpe,
    barCount,
    barPct: totalBars > 0 ? barCount / totalBars : 0,
  };
}

function scoreComponents(c) {
  const { regimes } = c;
  const filled = Object.values(regimes).filter(r => r.tradeCount > 0);

  if (!filled.length) return 0;

  // Minimum win rate across regimes that had trades
  const winRates = filled.map(r => r.winRate ?? 0);
  const minWinRate = Math.min(...winRates);
  const avgWinRate = winRates.reduce((s, v) => s + v, 0) / winRates.length;

  const minWinScore = clamp(linear(minWinRate, [0.2, 0.35, 0.45, 0.55, 0.65], [0, 20, 50, 75, 100]));
  const avgWinScore = clamp(linear(avgWinRate, [0.3, 0.4, 0.5, 0.6, 0.7], [0, 20, 50, 75, 100]));

  // Coverage: how many regimes have reasonable trade counts (≥ 3 trades)?
  const coveredRegimes = filled.filter(r => r.tradeCount >= 3).length;
  const coverageScore = coveredRegimes >= 3 ? 100 : coveredRegimes === 2 ? 65 : 35;

  return Math.round(avg([minWinScore * 0.5, avgWinScore * 0.3, coverageScore * 0.2]));
}

function buildEvidence(c, bars, regimeMap) {
  // Bar-level regime coloring for chart overlay (sampled)
  const regimeBars = [];
  const step = Math.max(1, Math.floor(bars.length / 500));
  for (let i = 0; i < bars.length; i += step) {
    const bar = bars[i];
    regimeBars.push({
      time: bar.time,
      regime: regimeMap.get(parseTime(bar.time)) || 'chop',
    });
  }

  return {
    ...c,
    regimeBars,
  };
}

// ── Indicator math ────────────────────────────────────────────────────────────

function computeEma(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;

  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }

  return result;
}

function computeAdxSimple(bars, period) {
  // Simplified ADX using EMA of true range as proxy for trend strength
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prev = bars[i - 1];
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prev.close),
      Math.abs(bar.low - prev.close),
    );
  });

  const atr = computeEma(tr, period);

  // Use ATR relative to price as a trend-strength proxy
  // Higher ATR% typically correlates with trending markets
  return bars.map((bar, i) => {
    if (atr[i] === null || bar.close === 0) return null;
    // Normalize: ATR/close * 1000 gives a roughly 0-50 range
    const raw = (atr[i] / bar.close) * 1000;
    // Map to 0-50 ADX-like scale
    return Math.min(50, raw * 10);
  });
}

function findRegimeAt(regimeMap, time, bars) {
  // Find the closest bar time at or before the given time
  let best = null;
  let bestDiff = Infinity;

  for (const bar of bars) {
    const t = parseTime(bar.time);
    if (t <= time) {
      const diff = time - t;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = regimeMap.get(t) || 'chop';
      }
    }
  }

  return best;
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
