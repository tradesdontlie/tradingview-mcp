import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';

export function registerBacktestTools(server) {
  // Run backtest with strategy parameters
  server.tool('backtest_run', 'Execute backtest on current chart with strategy parameters', {
    strategy_name: z.string().describe('Strategy name for reference'),
    parameters: z.record(z.any()).describe('Strategy parameters object'),
    symbol: z.string().optional().describe('Symbol to backtest (uses current if omitted)'),
    timeframe: z.string().optional().describe('Timeframe to backtest (uses current if omitted)'),
    from_date: z.string().optional().describe('Start date (YYYY-MM-DD format)'),
    to_date: z.string().optional().describe('End date (YYYY-MM-DD format)'),
  }, async ({ strategy_name, parameters, symbol, timeframe, from_date, to_date }) => {
    try {
      return jsonResult(await core.runBacktest({
        strategy_name,
        parameters,
        symbol,
        timeframe,
        from_date,
        to_date,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Get backtest results summary
  server.tool('backtest_results', 'Fetch backtest results: trades, equity curve, metrics', {
    include_trades: z.boolean().optional().describe('Include detailed trade list (default: true)'),
    include_equity: z.boolean().optional().describe('Include equity curve data (default: true)'),
    include_metrics: z.boolean().optional().describe('Include performance metrics (default: true)'),
  }, async ({ include_trades = true, include_equity = true, include_metrics = true }) => {
    try {
      return jsonResult(await core.getResults({
        include_trades,
        include_equity,
        include_metrics,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Get performance metrics (Sharpe, Sortino, max DD, etc)
  server.tool('backtest_metrics', 'Extract performance metrics from last backtest', {}, async () => {
    try {
      return jsonResult(await core.getMetrics());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Get equity curve data for charting
  server.tool('backtest_equity_curve', 'Get equity curve timeseries from backtest results', {
    resample: z.enum(['1D', '1W', '1M']).optional().describe('Resample to daily/weekly/monthly'),
  }, async ({ resample }) => {
    try {
      return jsonResult(await core.getEquityCurve({ resample }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Get trade list
  server.tool('backtest_trades', 'Get list of all trades executed during backtest', {
    filter: z.enum(['all', 'wins', 'losses']).optional().describe('Filter trades (default: all)'),
    limit: z.number().optional().describe('Max trades to return (default: 50)'),
  }, async ({ filter = 'all', limit = 50 }) => {
    try {
      return jsonResult(await core.getTrades({ filter, limit }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Export backtest report as HTML/JSON
  server.tool('backtest_export', 'Export backtest report in HTML or JSON format', {
    format: z.enum(['html', 'json']).describe('Export format'),
    include_chart: z.boolean().optional().describe('Include equity chart in HTML (default: true)'),
  }, async ({ format, include_chart = true }) => {
    try {
      return jsonResult(await core.exportReport({ format, include_chart }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Optimize strategy parameters (grid search)
  server.tool('backtest_optimize', 'Grid search optimize strategy parameters', {
    parameter_ranges: z.record(z.any()).describe('Parameter ranges: { param: { min, max, step } }'),
    metric: z.enum(['total_return', 'sharpe', 'sortino', 'max_drawdown', 'win_rate']).optional().describe('Metric to optimize for (default: sharpe)'),
    max_iterations: z.number().optional().describe('Max iterations (default: 100)'),
  }, async ({ parameter_ranges, metric = 'sharpe', max_iterations = 100 }) => {
    try {
      return jsonResult(await core.optimizeParameters({
        parameter_ranges,
        metric,
        max_iterations,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Clear backtest state
  server.tool('backtest_reset', 'Clear backtest results and state', {}, async () => {
    try {
      return jsonResult(await core.reset());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
