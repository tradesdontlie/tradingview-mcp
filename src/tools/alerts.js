import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_create_indicator', 'Create an indicator alert that fires on a Pine alertcondition() signal (e.g. strategy BUY/SELL). Posts directly to pricealerts.tradingview.com/create_alert with an alert_cond condition. Companion to alert_create (which targets the price-alert dialog). Returns alert_id on success.', {
    pine_id: z.string().describe('Saved Pine script id (e.g. "USER;abc123...") from pine_list_scripts.'),
    alert_cond_id: z.string().describe('Pine plot index of the target alertcondition (e.g. "plot_12"). TV counts plot/plotshape/bgcolor/alertcondition in source order; hline does NOT count. To discover: create one alert manually in the TV UI, then call alert_list and read the alert_cond_id.'),
    inputs: z.record(z.any()).describe('Pine input map matching the script\'s input.X declarations in order. Must include `__profile: false` and `pineFeatures` bitset. Example: { pineFeatures: \'{"indicator":1,"plot":1,"ta":1,"alertcondition":1}\', in_0: 14, in_1: 75, __profile: false }'),
    offsets_by_plot: z.record(z.number()).describe('Plot offsets map: { plot_0: 0, plot_1: 0, ..., plot_N-1: 0 } where N = the alert_cond_id index. Each plot before the alertcondition needs an entry, all zero is fine.'),
    pine_version: z.string().optional().describe('Saved script version from pine_list_scripts (default "1.0")'),
    symbol: z.string().optional().describe('TV symbol (e.g. "OANDA:USDJPY"). Defaults to active chart.'),
    currency: z.string().optional().describe('currency-id for the symbol marker (e.g. "JPY", "USD"). Defaults to active chart.'),
    resolution: z.string().optional().describe('Timeframe (e.g. "60", "240", "D"). Defaults to active chart.'),
    message: z.string().optional().describe('Alert payload. Supports {{ticker}}, {{close}}, and other TV placeholders. Sent verbatim to web_hook.'),
    web_hook: z.string().optional().describe('Webhook URL TV will POST the message to on fire. Omit for no webhook.'),
    frequency: z.string().optional().describe('"on_bar_close" (default), "once_per_bar", or "all".'),
    expiration_days: z.coerce.number().int().min(1).max(60).optional().describe('Days until auto-expiration (default 30, capped at 60).'),
    active: z.coerce.boolean().optional().describe('Whether the alert starts active (default true).'),
  }, async (args) => {
    try { return jsonResult(await core.createIndicator(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
