import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trade-analytics.js';

export function registerTradeAnalyticsTools(server) {
  // Win/loss analysis
  server.tool('analytics_win_loss', 'Analyze win/loss distribution and statistics', {
    trades: z.array(z.object({
      entry: z.number(),
      exit: z.number(),
      pips: z.number(),
      type: z.enum(['win', 'loss']).optional(),
    })).describe('Trade list with entry/exit prices and pips'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeWinLoss(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Drawdown analysis
  server.tool('analytics_drawdown', 'Calculate max drawdown, underwater plot, recovery time', {
    equity_data: z.array(z.array(z.number())).describe('Equity timeseries [[timestamp, value], ...]'),
  }, async ({ equity_data }) => {
    try {
      return jsonResult(await core.analyzeDrawdown(equity_data));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Trade duration analysis
  server.tool('analytics_duration', 'Analyze trade holding times, avg duration, distribution', {
    trades: z.array(z.object({
      entry_time: z.number(),
      exit_time: z.number(),
      duration_minutes: z.number().optional(),
    })).describe('Trades with entry/exit timestamps'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeDuration(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Risk/reward analysis
  server.tool('analytics_risk_reward', 'Calculate risk/reward ratios, expectancy, profit factor', {
    trades: z.array(z.object({
      entry: z.number(),
      exit: z.number(),
      stop_loss: z.number().optional(),
      take_profit: z.number().optional(),
      pips: z.number(),
      win: z.boolean(),
    })).describe('Trades with entry/exit and risk levels'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeRiskReward(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Trade sequence analysis (consecutive wins/losses)
  server.tool('analytics_sequences', 'Analyze consecutive wins/losses, streaks, clustering', {
    trades: z.array(z.object({
      win: z.boolean(),
      pips: z.number(),
    })).describe('Trades with win/loss status'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeSequences(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Time of day analysis
  server.tool('analytics_time_of_day', 'Analyze performance by hour of day (session analysis)', {
    trades: z.array(z.object({
      entry_time: z.number(),
      pips: z.number(),
      win: z.boolean(),
    })).describe('Trades with timestamps and results'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeTimeOfDay(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Slippage analysis
  server.tool('analytics_slippage', 'Analyze entry/exit slippage from expected prices', {
    trades: z.array(z.object({
      expected_entry: z.number(),
      actual_entry: z.number(),
      expected_exit: z.number(),
      actual_exit: z.number(),
    })).describe('Trades with expected vs actual prices'),
  }, async ({ trades }) => {
    try {
      return jsonResult(await core.analyzeSlippage(trades));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Monthly/weekly performance breakdown
  server.tool('analytics_periods', 'Break down performance by month, week, day', {
    trades: z.array(z.object({
      entry_time: z.number(),
      pips: z.number(),
      win: z.boolean(),
    })).describe('Trades with timestamps'),
    period: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Grouping period (default: monthly)'),
  }, async ({ trades, period = 'monthly' }) => {
    try {
      return jsonResult(await core.analyzeByPeriod(trades, period));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Trade heatmap
  server.tool('widget_trade_heatmap', 'Render heatmap of performance by hour/day of week', {
    data: z.record(z.record(z.number())).describe('Performance data { day: { hour: pips } }'),
    title: z.string().optional().describe('Heatmap title'),
  }, async ({ data, title = 'Trade Performance Heatmap' }) => {
    try {
      return jsonResult(await core.createHeatmap({ data, title }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Trade distribution histogram
  server.tool('widget_trade_histogram', 'Render histogram of trade P&L distribution', {
    trades: z.array(z.number()).describe('List of trade P&L values (pips)'),
    title: z.string().optional().describe('Histogram title'),
    bins: z.number().optional().describe('Number of bins (default: 20)'),
  }, async ({ trades, title = 'Trade P&L Distribution', bins = 20 }) => {
    try {
      return jsonResult(await core.createHistogram({ trades, title, bins }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Drawdown chart
  server.tool('widget_drawdown_chart', 'Render underwater plot (drawdown over time)', {
    equity_data: z.array(z.array(z.number())).describe('Equity timeseries [[timestamp, value], ...]'),
    title: z.string().optional().describe('Chart title'),
  }, async ({ equity_data, title = 'Drawdown Over Time' }) => {
    try {
      return jsonResult(await core.createDrawdownChart({ equity_data, title }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Trade summary report
  server.tool('widget_trade_report', 'Render comprehensive trade analysis report card', {
    stats: z.object({
      total_trades: z.number(),
      wins: z.number(),
      losses: z.number(),
      win_rate: z.string(),
      profit_factor: z.string(),
      avg_win: z.string(),
      avg_loss: z.string(),
      largest_win: z.string(),
      largest_loss: z.string(),
      max_drawdown: z.string(),
      recovery_trades: z.number().optional(),
    }).describe('Trade statistics summary'),
    title: z.string().optional().describe('Report title'),
  }, async ({ stats, title = 'Trade Analysis Report' }) => {
    try {
      return jsonResult(await core.createTradeReport({ stats, title }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
