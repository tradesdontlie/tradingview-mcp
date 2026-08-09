import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/auto-analysis.js';

export function registerAutoAnalysisTools(server) {
  // Universal Auto-Analysis (Any Input)
  server.tool('auto_analyze', 'Automated analysis for ANY user input - detects type and analyzes', {
    user_input: z.string().describe('User input: symbol, phrase, question, anything'),
    analysis_depth: z.enum(['quick', 'detailed', 'comprehensive']).optional().describe('Analysis depth'),
  }, async ({ user_input, analysis_depth = 'comprehensive' }) => {
    try {
      return jsonResult(await core.autoAnalyzeInput(user_input, analysis_depth));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Volume Profile Analysis (Fixed Range)
  server.tool('analysis_volume_profile', 'Volume profile analysis - fixed range levels', {
    symbol: z.string(),
    price_high: z.number().describe('High price in range'),
    price_low: z.number().describe('Low price in range'),
    volume_data: z.array(z.object({
      price: z.number(),
      volume: z.number(),
    })).optional().describe('Price-volume pairs'),
  }, async ({ symbol, price_high, price_low, volume_data = [] }) => {
    try {
      return jsonResult(await core.volumeProfileAnalysis({
        symbol,
        price_high,
        price_low,
        volume_data,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Point of Control (POC) Detection
  server.tool('analysis_poc', 'Point of Control - highest volume price level', {
    symbol: z.string(),
    volume_profile: z.record(z.number()).describe('Volume at price levels'),
  }, async ({ symbol, volume_profile }) => {
    try {
      return jsonResult(await core.pointOfControlAnalysis(symbol, volume_profile));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Value Area Analysis
  server.tool('analysis_value_area', 'Value area - 70% of trading volume range', {
    symbol: z.string(),
    volume_profile: z.record(z.number()).describe('Volume at each price level'),
  }, async ({ symbol, volume_profile }) => {
    try {
      return jsonResult(await core.valueAreaAnalysis(symbol, volume_profile));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Volume Imbalance Detection
  server.tool('analysis_volume_imbalance', 'Detect volume imbalances - buy/sell pressure', {
    symbol: z.string(),
    bid_volume_levels: z.record(z.number()),
    ask_volume_levels: z.record(z.number()),
  }, async ({ symbol, bid_volume_levels, ask_volume_levels }) => {
    try {
      return jsonResult(await core.volumeImbalanceAnalysis({
        symbol,
        bid_volume_levels,
        ask_volume_levels,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Automated Multi-Indicator Signal
  server.tool('auto_signal_all_indicators', 'Automated signal checking ALL indicators at once', {
    symbol: z.string(),
    current_price: z.number(),
    volume: z.number().optional(),
  }, async ({ symbol, current_price, volume = 1500000 }) => {
    try {
      return jsonResult(await core.autoSignalAllIndicators(symbol, current_price, volume));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Natural Language Analysis Request
  server.tool('natural_analysis', 'Understand user request in natural language and analyze', {
    request: z.string().describe('User request in plain English'),
  }, async ({ request }) => {
    try {
      return jsonResult(await core.naturalLanguageAnalysis(request));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Auto Analysis Dashboard
  server.tool('widget_auto_analysis', 'Render complete auto-analysis dashboard', {
    symbol: z.string(),
    analysis_results: z.object({
      volume_profile: z.any().optional(),
      poc: z.number().optional(),
      value_area_high: z.number().optional(),
      value_area_low: z.number().optional(),
      signal: z.string().optional(),
      confidence: z.number().optional(),
    }).describe('Analysis results'),
  }, async ({ symbol, analysis_results }) => {
    try {
      return jsonResult(await core.createAutoAnalysisDashboard(symbol, analysis_results));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
