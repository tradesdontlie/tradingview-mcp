// Bar-by-bar backtest engine — ported from atilaahmettaner/backtest_service.py.
// 6 strategies: RSI, Bollinger, MACD, EMA crossover, Supertrend, Donchian.
// Yahoo Finance historical OHLCV via yahoo-finance2.

import * as YF from 'yahoo-finance2';
import ti from 'technicalindicators';

const SUPPRESS = ['ripHistorical', 'yahooSurvey'];
const yahooFinance = (() => {
  if (YF.YahooFinance) return new YF.YahooFinance({ suppressNotices: SUPPRESS });
  if (YF.default && typeof YF.default === 'function') return new YF.default({ suppressNotices: SUPPRESS });
  return YF.default || YF;
})();

// ── Historical OHLCV fetch ────────────────────────────────────────────────────
export async function fetchOhlcv({ symbol, period = '1y', interval = '1d' }) {
  const days = ({ '1mo': 30, '3mo': 92, '6mo': 184, '1y': 365, '2y': 730 })[period] || 365;
  const since = new Date(Date.now() - days * 86_400_000);
  const opts = { period1: since, interval };
  const bars = await yahooFinance.chart(symbol, opts);
  return (bars.quotes || []).map(b => ({
    date: b.date instanceof Date ? b.date : new Date(b.date),
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  })).filter(b => b.open != null && b.close != null);
}

// ── Strategies → signals[] (+1 buy / -1 sell / 0 hold) ────────────────────────

function rsiStrategy(bars) {
  const closes = bars.map(b => b.close);
  const rsi = ti.RSI.calculate({ values: closes, period: 14 });
  const offset = closes.length - rsi.length;
  const signals = new Array(closes.length).fill(0);
  for (let i = 1; i < rsi.length; i++) {
    if (rsi[i - 1] < 30 && rsi[i] >= 30) signals[i + offset] = 1;
    else if (rsi[i - 1] > 70 && rsi[i] <= 70) signals[i + offset] = -1;
  }
  return signals;
}

function bollingerStrategy(bars) {
  const closes = bars.map(b => b.close);
  const bb = ti.BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const offset = closes.length - bb.length;
  const signals = new Array(closes.length).fill(0);
  for (let i = 1; i < bb.length; i++) {
    if (closes[i + offset - 1] <= bb[i - 1].lower && closes[i + offset] > bb[i].lower) signals[i + offset] = 1;
    else if (closes[i + offset - 1] >= bb[i - 1].upper && closes[i + offset] < bb[i].upper) signals[i + offset] = -1;
  }
  return signals;
}

function macdStrategy(bars) {
  const closes = bars.map(b => b.close);
  const m = ti.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const offset = closes.length - m.length;
  const signals = new Array(closes.length).fill(0);
  for (let i = 1; i < m.length; i++) {
    if (m[i - 1].MACD < m[i - 1].signal && m[i].MACD > m[i].signal) signals[i + offset] = 1;
    else if (m[i - 1].MACD > m[i - 1].signal && m[i].MACD < m[i].signal) signals[i + offset] = -1;
  }
  return signals;
}

function emaCrossStrategy(bars) {
  const closes = bars.map(b => b.close);
  const fast = ti.EMA.calculate({ values: closes, period: 12 });
  const slow = ti.EMA.calculate({ values: closes, period: 26 });
  const offset = closes.length - slow.length;
  const fastTail = fast.slice(fast.length - slow.length);
  const signals = new Array(closes.length).fill(0);
  for (let i = 1; i < slow.length; i++) {
    if (fastTail[i - 1] < slow[i - 1] && fastTail[i] > slow[i]) signals[i + offset] = 1;
    else if (fastTail[i - 1] > slow[i - 1] && fastTail[i] < slow[i]) signals[i + offset] = -1;
  }
  return signals;
}

// Supertrend (simplified): ATR + factor
function supertrendStrategy(bars) {
  const period = 10;
  const factor = 3;
  const atr = ti.ATR.calculate({ high: bars.map(b => b.high), low: bars.map(b => b.low), close: bars.map(b => b.close), period });
  const offset = bars.length - atr.length;
  const signals = new Array(bars.length).fill(0);
  let inLong = false;
  let band = null;
  for (let i = 0; i < atr.length; i++) {
    const j = i + offset;
    const mid = (bars[j].high + bars[j].low) / 2;
    const upperBand = mid + factor * atr[i];
    const lowerBand = mid - factor * atr[i];
    if (band == null) { band = lowerBand; inLong = true; continue; }
    if (inLong) {
      band = Math.max(band, lowerBand);
      if (bars[j].close < band) { inLong = false; band = upperBand; signals[j] = -1; }
    } else {
      band = Math.min(band, upperBand);
      if (bars[j].close > band) { inLong = true; band = lowerBand; signals[j] = 1; }
    }
  }
  return signals;
}

// Donchian breakout: enter when close breaks N-bar high, exit at N-bar low
function donchianStrategy(bars) {
  const period = 20;
  const signals = new Array(bars.length).fill(0);
  let inLong = false;
  for (let i = period; i < bars.length; i++) {
    const lookback = bars.slice(i - period, i);
    const highMax = Math.max(...lookback.map(b => b.high));
    const lowMin = Math.min(...lookback.map(b => b.low));
    if (!inLong && bars[i].close > highMax) { signals[i] = 1; inLong = true; }
    else if (inLong && bars[i].close < lowMin) { signals[i] = -1; inLong = false; }
  }
  return signals;
}

const STRATEGIES = {
  rsi: rsiStrategy,
  bollinger: bollingerStrategy,
  macd: macdStrategy,
  ema_cross: emaCrossStrategy,
  supertrend: supertrendStrategy,
  donchian: donchianStrategy,
};

export const STRATEGY_NAMES = Object.keys(STRATEGIES);

// ── Simulator ─────────────────────────────────────────────────────────────────

function simulate({ bars, signals, initial_capital = 10_000, commission_pct = 0.1, slippage_pct = 0.05 }) {
  let cash = initial_capital;
  let position = 0;
  let entryPrice = null;
  let entryDate = null;
  const trades = [];
  const equityCurve = [];

  const c = commission_pct / 100;
  const s = slippage_pct / 100;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const sig = signals[i];
    if (sig === 1 && position === 0) {
      const fillPrice = bar.close * (1 + s);
      position = Math.floor(cash / fillPrice / (1 + c));
      if (position > 0) {
        cash -= position * fillPrice * (1 + c);
        entryPrice = fillPrice;
        entryDate = bar.date.toISOString().slice(0, 10);
      }
    } else if (sig === -1 && position > 0) {
      const fillPrice = bar.close * (1 - s);
      const proceeds = position * fillPrice * (1 - c);
      cash += proceeds;
      trades.push({
        entry_date: entryDate,
        entry_price: entryPrice,
        exit_date: bar.date.toISOString().slice(0, 10),
        exit_price: fillPrice,
        pnl: proceeds - (entryPrice * position * (1 + c)),
        pnl_pct: ((fillPrice - entryPrice) / entryPrice) * 100,
      });
      position = 0;
      entryPrice = null;
      entryDate = null;
    }
    const equity = cash + position * bar.close;
    equityCurve.push({ date: bar.date.toISOString().slice(0, 10), equity });
  }

  // Close open position at last close
  if (position > 0) {
    const last = bars[bars.length - 1];
    const fillPrice = last.close * (1 - s);
    const proceeds = position * fillPrice * (1 - c);
    cash += proceeds;
    trades.push({
      entry_date: entryDate,
      entry_price: entryPrice,
      exit_date: last.date.toISOString().slice(0, 10),
      exit_price: fillPrice,
      pnl: proceeds - (entryPrice * position * (1 + c)),
      pnl_pct: ((fillPrice - entryPrice) / entryPrice) * 100,
      forced_close: true,
    });
    position = 0;
    entryDate = null;
  }

  const totalReturnPct = ((cash - initial_capital) / initial_capital) * 100;
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Max drawdown
  let peak = initial_capital;
  let maxDd = 0;
  for (const e of equityCurve) {
    if (e.equity > peak) peak = e.equity;
    const dd = (peak - e.equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe (daily) — assume bars are daily
  const dailyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
  }
  const meanR = dailyReturns.reduce((a, b) => a + b, 0) / Math.max(1, dailyReturns.length);
  const varR = dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, dailyReturns.length);
  const stdR = Math.sqrt(varR);
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

  return {
    initial_capital,
    final_equity: Number(cash.toFixed(2)),
    total_return_pct: Number(totalReturnPct.toFixed(2)),
    total_trades: trades.length,
    wins,
    losses,
    win_rate_pct: Number(winRate.toFixed(2)),
    profit_factor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(2)) : 'inf',
    max_drawdown_pct: Number((maxDd * 100).toFixed(2)),
    sharpe_ratio: Number(sharpe.toFixed(2)),
    trades,
    equity_curve: equityCurve,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runBacktest({
  symbol, strategy, period = '1y', interval = '1d',
  initial_capital = 10_000, commission_pct = 0.1, slippage_pct = 0.05,
  include_trade_log = false, include_equity_curve = false,
}) {
  const fn = STRATEGIES[strategy];
  if (!fn) return { symbol, strategy, error: `unknown strategy ${strategy}. Use: ${STRATEGY_NAMES.join(',')}` };

  const bars = await fetchOhlcv({ symbol, period, interval });
  if (bars.length < 50) {
    return { symbol, strategy, error: `insufficient bars (${bars.length}); need >=50` };
  }
  const signals = fn(bars);
  const result = simulate({ bars, signals, initial_capital, commission_pct, slippage_pct });

  const out = {
    symbol, strategy, period, interval,
    bars: bars.length,
    initial_capital: result.initial_capital,
    final_equity: result.final_equity,
    total_return_pct: result.total_return_pct,
    total_trades: result.total_trades,
    wins: result.wins,
    losses: result.losses,
    win_rate_pct: result.win_rate_pct,
    profit_factor: result.profit_factor,
    max_drawdown_pct: result.max_drawdown_pct,
    sharpe_ratio: result.sharpe_ratio,
  };
  if (include_trade_log) out.trades = result.trades;
  if (include_equity_curve) out.equity_curve = result.equity_curve;
  return out;
}

export async function compareStrategiesRun({
  symbol, period = '1y', interval = '1d', initial_capital = 10_000,
}) {
  const results = [];
  for (const s of STRATEGY_NAMES) {
    const r = await runBacktest({ symbol, strategy: s, period, interval, initial_capital });
    if (!r.error) results.push(r);
  }
  results.sort((a, b) => b.total_return_pct - a.total_return_pct);
  return { symbol, period, interval, ranked_by_total_return_pct: results };
}

export async function walkForwardRun({
  symbol, strategy, period = '2y', interval = '1d', n_splits = 3, train_ratio = 0.7,
  initial_capital = 10_000, commission_pct = 0.1, slippage_pct = 0.05,
}) {
  const fn = STRATEGIES[strategy];
  if (!fn) return { symbol, strategy, error: `unknown strategy ${strategy}` };

  const bars = await fetchOhlcv({ symbol, period, interval });
  if (bars.length < 100) {
    return { symbol, strategy, error: `insufficient bars (${bars.length}); need >=100` };
  }

  const foldSize = Math.floor(bars.length / n_splits);
  const folds = [];
  for (let f = 0; f < n_splits; f++) {
    const start = f * foldSize;
    const end = (f === n_splits - 1) ? bars.length : start + foldSize;
    const foldBars = bars.slice(start, end);
    if (foldBars.length < 30) continue;
    const trainEnd = Math.floor(foldBars.length * train_ratio);
    const trainBars = foldBars.slice(0, trainEnd);
    const testBars = foldBars.slice(trainEnd);
    // Strategies here have no tunable params (fixed lookbacks). We still
    // separately backtest train + test as a proxy for overfitting check.
    const trainSig = fn(trainBars);
    const testSig = fn(testBars);
    const trainResult = simulate({ bars: trainBars, signals: trainSig, initial_capital, commission_pct, slippage_pct });
    const testResult = simulate({ bars: testBars, signals: testSig, initial_capital, commission_pct, slippage_pct });
    folds.push({
      fold: f + 1,
      train_return_pct: trainResult.total_return_pct,
      test_return_pct: testResult.total_return_pct,
      train_trades: trainResult.total_trades,
      test_trades: testResult.total_trades,
      train_sharpe: trainResult.sharpe_ratio,
      test_sharpe: testResult.sharpe_ratio,
    });
  }

  const avgTrain = folds.length ? folds.reduce((a, f) => a + f.train_return_pct, 0) / folds.length : 0;
  const avgTest = folds.length ? folds.reduce((a, f) => a + f.test_return_pct, 0) / folds.length : 0;
  return {
    symbol, strategy, period, interval,
    n_splits, train_ratio,
    folds,
    avg_train_return_pct: Number(avgTrain.toFixed(2)),
    avg_test_return_pct: Number(avgTest.toFixed(2)),
    overfit_warning: avgTrain > 0 && avgTest < avgTrain * 0.3,
  };
}
