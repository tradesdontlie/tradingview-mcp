// Backtest tools — Group G (3 tools).

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as bt from '../core/backtest.js';

const STRATEGIES = z.enum(['rsi', 'bollinger', 'macd', 'ema_cross', 'supertrend', 'donchian']);
const PERIODS = z.enum(['1mo', '3mo', '6mo', '1y', '2y']);
const INTERVALS = z.enum(['1d', '1h']);

export function registerBacktestTools(server) {
  server.tool(
    'backtest_strategy',
    'Backtest a trading strategy on Yahoo Finance historical data. 6 strategies available: rsi (oversold/overbought crossovers), bollinger (band reversion), macd (signal crossovers), ema_cross (12/26), supertrend (ATR-based), donchian (N-bar breakout). Returns total_return, win_rate, profit_factor, sharpe, max_drawdown, total_trades.',
    {
      symbol: z.string().describe('Yahoo symbol (AAPL, BTC-USD, RELIANCE.NS)'),
      strategy: STRATEGIES,
      period: PERIODS.default('1y'),
      interval: INTERVALS.default('1d'),
      initial_capital: z.number().default(10_000),
      commission_pct: z.number().default(0.1),
      slippage_pct: z.number().default(0.05),
      include_trade_log: z.boolean().default(false),
      include_equity_curve: z.boolean().default(false),
    },
    async (args) => {
      try {
        return jsonResult(await bt.runBacktest(args));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'compare_strategies',
    'Run all 6 strategies on one symbol and rank by total_return_pct descending. Reveals which approach fits the symbol best.',
    {
      symbol: z.string(),
      period: PERIODS.default('1y'),
      interval: INTERVALS.default('1d'),
      initial_capital: z.number().default(10_000),
    },
    async (args) => {
      try {
        return jsonResult(await bt.compareStrategiesRun(args));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'walk_forward_backtest_strategy',
    'Walk-forward validation: split data into N folds, simulate train+test independently per fold, average results. Flags overfit_warning when test return is <30% of train return. Use period=2y for meaningful folds.',
    {
      symbol: z.string(),
      strategy: STRATEGIES,
      period: PERIODS.default('2y'),
      interval: INTERVALS.default('1d'),
      n_splits: z.number().int().min(2).max(10).default(3),
      train_ratio: z.number().min(0.3).max(0.9).default(0.7),
      initial_capital: z.number().default(10_000),
      commission_pct: z.number().default(0.1),
      slippage_pct: z.number().default(0.05),
    },
    async (args) => {
      try {
        return jsonResult(await bt.walkForwardRun(args));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
