import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart-analysis.js';

export function registerChartAnalysisTools(server) {
  // Complete Chart Analysis
  server.tool('chart_complete_analysis', 'Comprehensive chart analysis: all indicators + signals', {
    symbol: z.string().describe('Stock symbol'),
    timeframe: z.string().describe('Timeframe (1H, 4H, D, W)'),
    price: z.number().describe('Current price'),
    volume: z.number().optional().describe('Current volume'),
  }, async ({ symbol, timeframe, price, volume = 1000000 }) => {
    try {
      return jsonResult(await core.completeChartAnalysis({
        symbol,
        timeframe,
        price,
        volume,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Fixed Range Indicators
  server.tool('analysis_fixed_range', 'Fixed range indicators (RSI, Stochastic, CCI)', {
    symbol: z.string().describe('Stock symbol'),
    price: z.number().describe('Current price'),
    high_14: z.number().describe('14-period high'),
    low_14: z.number().describe('14-period low'),
  }, async ({ symbol, price, high_14, low_14 }) => {
    try {
      return jsonResult(await core.fixedRangeAnalysis({
        symbol,
        price,
        high_14,
        low_14,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Volume Analysis
  server.tool('analysis_volume', 'Volume analysis: trend, breakout, accumulation/distribution', {
    symbol: z.string(),
    current_volume: z.number().describe('Current bar volume'),
    avg_volume_20: z.number().describe('20-period average volume'),
    price_action: z.enum(['up', 'down', 'neutral']).describe('Price direction'),
  }, async ({ symbol, current_volume, avg_volume_20, price_action }) => {
    try {
      return jsonResult(await core.volumeAnalysis({
        symbol,
        current_volume,
        avg_volume_20,
        price_action,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Fibonacci Analysis
  server.tool('analysis_fibonacci', 'Fibonacci retracements and extensions', {
    symbol: z.string(),
    swing_high: z.number().describe('Swing high price'),
    swing_low: z.number().describe('Swing low price'),
    current_price: z.number().describe('Current price'),
  }, async ({ symbol, swing_high, swing_low, current_price }) => {
    try {
      return jsonResult(await core.fibonacciAnalysis({
        symbol,
        swing_high,
        swing_low,
        current_price,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Liquidity Flow Analysis
  server.tool('analysis_liquidity_flow', 'Liquidity flow: order book analysis, smart money moves', {
    symbol: z.string(),
    bid_volume: z.number().optional().describe('Bid side volume'),
    ask_volume: z.number().optional().describe('Ask side volume'),
    large_trades: z.array(z.number()).optional().describe('Large trade sizes'),
  }, async ({ symbol, bid_volume = 500000, ask_volume = 450000, large_trades = [] }) => {
    try {
      return jsonResult(await core.liquidityFlowAnalysis({
        symbol,
        bid_volume,
        ask_volume,
        large_trades,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Trend + Momentum
  server.tool('analysis_trend_momentum', 'Trend analysis + momentum indicators (MACD, ADX, ROC)', {
    symbol: z.string(),
    sma_20: z.number().describe('SMA 20'),
    sma_50: z.number().describe('SMA 50'),
    sma_200: z.number().describe('SMA 200'),
    current_price: z.number(),
  }, async ({ symbol, sma_20, sma_50, sma_200, current_price }) => {
    try {
      return jsonResult(await core.trendMomentumAnalysis({
        symbol,
        sma_20,
        sma_50,
        sma_200,
        current_price,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Support/Resistance Levels
  server.tool('analysis_support_resistance', 'Identify key support and resistance levels', {
    symbol: z.string(),
    current_price: z.number(),
    day_high: z.number(),
    day_low: z.number(),
    week_high: z.number(),
    week_low: z.number(),
  }, async ({ symbol, current_price, day_high, day_low, week_high, week_low }) => {
    try {
      return jsonResult(await core.supportResistanceAnalysis({
        symbol,
        current_price,
        day_high,
        day_low,
        week_high,
        week_low,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Multi-Indicator Signal Confirmation
  server.tool('analysis_signal_confirmation', 'Cross-verify signals across multiple indicators', {
    symbol: z.string(),
    rsi_signal: z.enum(['overbought', 'oversold', 'neutral']),
    macd_signal: z.enum(['bullish', 'bearish', 'neutral']),
    volume_signal: z.enum(['strong_up', 'strong_down', 'neutral']),
    price_position: z.enum(['above_sma', 'below_sma', 'at_sma']),
  }, async ({ symbol, rsi_signal, macd_signal, volume_signal, price_position }) => {
    try {
      return jsonResult(await core.signalConfirmation({
        symbol,
        rsi_signal,
        macd_signal,
        volume_signal,
        price_position,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Complete Chart Analysis Dashboard
  server.tool('widget_chart_analysis', 'Render complete chart analysis with all indicators', {
    symbol: z.string(),
    analysis: z.object({
      trend: z.string(),
      momentum: z.string(),
      volume_signal: z.string(),
      support: z.number(),
      resistance: z.number(),
      fibonacci_levels: z.array(z.number()).optional(),
      liquidity: z.string().optional(),
      overall_signal: z.string(),
    }).describe('Analysis results'),
  }, async ({ symbol, analysis }) => {
    try {
      return jsonResult(await core.createChartAnalysisDashboard(symbol, analysis));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
