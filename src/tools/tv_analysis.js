// TradingView TA per-symbol analysis tools — Group C.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as tvTa from '../core/tv_ta.js';
import { extractExtendedIndicators } from '../core/indicators_calc.js';

export function registerTvAnalysisTools(server) {
  server.tool(
    'coin_analysis',
    'Full TA breakdown for a single symbol on a chosen exchange and timeframe. Returns RSI/MACD/Bollinger/SMA-EMA stack/Stoch/ADX/support-resistance/volume/OBV + TV recommendation ratings. Crypto: BINANCE, KUCOIN, BYBIT, MEXC, OKX. Stocks: NASDAQ, NYSE, NSE, BSE. Timeframes: 5m 15m 1h 4h 1D 1W.',
    {
      symbol: z.string().describe('e.g. BTCUSDT, AAPL, RELIANCE'),
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('15m'),
    },
    async ({ symbol, exchange, timeframe }) => {
      try {
        const result = await tvTa.getAnalysis({ symbol, exchange, timeframe });
        if (result.error) return jsonResult(result, true);
        const extended = extractExtendedIndicators(result.indicators);
        return jsonResult({
          symbol: `${exchange}:${symbol}`,
          exchange: result.exchange,
          screener: result.screener,
          timeframe,
          ...extended,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
