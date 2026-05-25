// TradingView TA per-symbol analysis tools — Group C.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as tvTa from '../core/tv_ta.js';
import { extractExtendedIndicators } from '../core/indicators_calc.js';

export function registerTvAnalysisTools(server) {
  server.tool(
    'volume_confirmation_analysis',
    'Volume-price action confirmation for a single symbol. Returns whether the current move is volume-confirmed: classifies as bullish_strong / bullish_weak / bearish_strong / bearish_weak / neutral based on price-direction + volume-vs-average. Pairs with TA indicators (RSI, MACD) for confluence.',
    {
      symbol: z.string(),
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('15m'),
    },
    async ({ symbol, exchange, timeframe }) => {
      try {
        const r = await tvTa.getAnalysis({ symbol, exchange, timeframe });
        if (r.error) return jsonResult(r, true);
        const ind = r.indicators;
        const close = ind.close;
        const open = ind.open;
        const volume = ind.volume;
        const avgVol = ind['volume.SMA20'] ?? null;
        const ext = extractExtendedIndicators(ind);

        const priceUp = close != null && open != null && close > open;
        const priceDown = close != null && open != null && close < open;
        const volRatio = (volume != null && avgVol && avgVol > 0) ? volume / avgVol : null;
        const heavyVol = volRatio != null && volRatio >= 1.5;
        const lightVol = volRatio != null && volRatio < 0.8;

        let confirmation = 'neutral';
        if (priceUp && heavyVol) confirmation = 'bullish_strong';
        else if (priceUp && lightVol) confirmation = 'bullish_weak';
        else if (priceDown && heavyVol) confirmation = 'bearish_strong';
        else if (priceDown && lightVol) confirmation = 'bearish_weak';

        return jsonResult({
          symbol: `${exchange}:${symbol}`,
          timeframe,
          price: ext.price_data.current_price,
          change_percent: ext.price_data.change_percent,
          volume,
          average_volume_20: avgVol,
          volume_ratio: volRatio != null ? Number(volRatio.toFixed(2)) : null,
          confirmation,
          rsi: ext.rsi.value,
          macd_crossover: ext.macd.crossover,
          interpretation:
            confirmation === 'bullish_strong' ? 'Real demand. Price up on rising volume.'
            : confirmation === 'bullish_weak' ? 'Move lacks conviction. Up on light volume.'
            : confirmation === 'bearish_strong' ? 'Real supply. Down on heavy volume.'
            : confirmation === 'bearish_weak' ? 'Drift. Down on light volume.'
            : 'Insufficient or balanced volume signal.',
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'multi_timeframe_analysis',
    'Multi-timeframe alignment (Weekly -> Daily -> 4h -> 1h -> 15m). Returns bias + key reasons per timeframe, plus an aggregate alignment label (BULLISH_ALIGNED / BEARISH_ALIGNED / MIXED) and net_score across TFs. Use to spot confluence.',
    {
      symbol: z.string(),
      exchange: z.string().default('BINANCE'),
    },
    async ({ symbol, exchange }) => {
      try {
        const tfs = ['1W', '1D', '4h', '1h', '15m'];
        const out = {};
        const scores = {};
        for (const tf of tfs) {
          const r = await tvTa.getAnalysis({ symbol, exchange, timeframe: tf });
          if (r.error) {
            out[tf] = { error: r.error };
            continue;
          }
          const ext = extractExtendedIndicators(r.indicators);
          out[tf] = {
            bias: ext.market_structure.trend,
            reasons: ext.market_structure.trend_signals,
            rsi: ext.rsi.value,
            macd_crossover: ext.macd.crossover,
            trend_strength: ext.adx.trend_strength,
            price: ext.price_data.current_price,
          };
          scores[tf] = ext.market_structure.trend_score;
        }
        const net = Object.values(scores).reduce((a, b) => a + b, 0);
        const status =
          net >= 6 ? 'BULLISH_ALIGNED'
          : net <= -6 ? 'BEARISH_ALIGNED'
          : Math.abs(net) >= 3 ? (net > 0 ? 'LEAN_BULLISH' : 'LEAN_BEARISH')
          : 'MIXED';
        return jsonResult({
          symbol: `${exchange}:${symbol}`,
          analysis_type: 'Multi-Timeframe Alignment',
          timeframes: out,
          alignment: { status, net_score: net, scores_by_tf: scores },
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

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
