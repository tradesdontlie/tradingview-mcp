import { getBridgeContext } from '../core/bridge.js';
import { jsonResult } from './_format.js';

export function registerBridgeTools(server, { getContext = getBridgeContext } = {}) {
  server.tool(
    'bridge_get_context',
    'Read-only: summarize current TradingView chart and NinjaTrader bridge context with futures-root compatibility',
    {},
    async () => {
      try { return jsonResult(await getContext()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
