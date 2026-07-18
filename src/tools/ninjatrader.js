import { z } from 'zod';
import { createTradingBridgeClient } from '../core/ninjatrader.js';
import { jsonResult } from './_format.js';

export function registerNinjaTraderTools(server, { client = createTradingBridgeClient() } = {}) {
  function registerReadOnly(name, description, schema, operation) {
    server.tool(name, `Read-only: ${description}`, schema, async (args) => {
      try { return jsonResult(await operation(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });
  }

  registerReadOnly('nt_status', 'check the local NinjaTrader TradingBridge status', {}, () => client.status());
  registerReadOnly('nt_connections', 'list NinjaTrader connection and data-feed state', {}, () => client.connections());
  registerReadOnly('nt_accounts', 'get account snapshots from NinjaTrader', {}, () => client.accounts());
  registerReadOnly('nt_positions', 'get open position snapshots from NinjaTrader', {}, () => client.positions());
  registerReadOnly('nt_orders', 'get order snapshots from NinjaTrader', {}, () => client.orders());
  registerReadOnly(
    'nt_bars',
    'get historical bars for an exact NinjaTrader contract',
    {
      instrument: z.string().min(1).describe('Exact NinjaTrader contract, for example MNQ 09-26'),
      period: z.string().min(1).describe('NinjaTrader BarsPeriod type, for example Minute or Day'),
      value: z.coerce.number().int().positive().describe('BarsPeriod value, for example 5 for five-minute bars'),
    },
    (args) => client.bars(args),
  );
}
