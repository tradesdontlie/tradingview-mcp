import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/widgets.js';

export function registerWidgetTools(server) {
  // Symbol/Timeframe Picker Form
  server.tool('widget_picker_form', 'Render interactive symbol and timeframe picker form in chat', {
    current_symbol: z.string().optional().describe('Currently selected symbol (default: EURUSD)'),
    current_timeframe: z.string().optional().describe('Currently selected timeframe (default: 1H)'),
    symbols: z.array(z.string()).optional().describe('List of symbols to choose from'),
  }, async ({ current_symbol = 'EURUSD', current_timeframe = '1H', symbols = ['EURUSD', 'BTCUSD', 'AAPL', 'SPY', 'GC', 'CL'] }) => {
    try {
      return jsonResult(await core.createPickerForm({ current_symbol, current_timeframe, symbols }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Strategy Parameters Form
  server.tool('widget_strategy_params', 'Render interactive strategy parameter form', {
    strategy_name: z.string().describe('Name of the strategy'),
    params: z.record(z.any()).describe('Parameter definitions: { paramName: { type, min, max, default, step } }'),
  }, async ({ strategy_name, params }) => {
    try {
      return jsonResult(await core.createStrategyParamsForm(strategy_name, params));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Real-time Dashboard
  server.tool('widget_dashboard', 'Render real-time trading dashboard with stats and equity curve', {
    title: z.string().optional().describe('Dashboard title'),
    metrics: z.record(z.any()).describe('Metrics to display: { label: value, ... }'),
    equity_data: z.array(z.array(z.number())).optional().describe('Time series data [[timestamp, value], ...]'),
  }, async ({ title = 'Trading Dashboard', metrics, equity_data }) => {
    try {
      return jsonResult(await core.createDashboard({ title, metrics, equity_data }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Confirmation Dialog
  server.tool('widget_confirmation', 'Render confirmation dialog for trade execution or risky actions', {
    title: z.string().describe('Dialog title'),
    message: z.string().describe('Confirmation message'),
    action_label: z.string().optional().describe('Action button label (default: Confirm)'),
    cancel_label: z.string().optional().describe('Cancel button label (default: Cancel)'),
    details: z.array(z.record(z.string())).optional().describe('Additional details: { label: value }'),
  }, async ({ title, message, action_label = 'Confirm', cancel_label = 'Cancel', details = [] }) => {
    try {
      return jsonResult(await core.createConfirmationDialog({
        title,
        message,
        action_label,
        cancel_label,
        details,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Data Table
  server.tool('widget_table', 'Render interactive data table (watchlist, scan results, etc.)', {
    title: z.string().describe('Table title'),
    columns: z.array(z.object({
      key: z.string().describe('Column key'),
      label: z.string().describe('Column display label'),
      align: z.enum(['left', 'center', 'right']).optional().describe('Text alignment'),
    })).describe('Column definitions'),
    rows: z.array(z.record(z.any())).describe('Row data'),
    sortable: z.boolean().optional().describe('Enable sorting (default: true)'),
    filterable: z.boolean().optional().describe('Enable filtering (default: true)'),
  }, async ({ title, columns, rows, sortable = true, filterable = true }) => {
    try {
      return jsonResult(await core.createTable({ title, columns, rows, sortable, filterable }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Alert/Notification Banner
  server.tool('widget_alert', 'Render alert/notification banner', {
    type: z.enum(['info', 'success', 'warning', 'error']).describe('Alert type'),
    title: z.string().describe('Alert title'),
    message: z.string().describe('Alert message'),
    dismissible: z.boolean().optional().describe('Show dismiss button (default: true)'),
  }, async ({ type, title, message, dismissible = true }) => {
    try {
      return jsonResult(await core.createAlert({ type, title, message, dismissible }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
