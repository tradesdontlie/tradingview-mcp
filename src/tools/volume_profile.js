import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/volume_profile.js';

const barSchema = z.object({
  open_time: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number(),
}).passthrough();

/**
 * Volume Profile bias tools — pure functions over OHLC+volume bar arrays
 * (e.g. from binance_get_klines), no live chart/exchange calls of their own.
 * Encodes the two mechanical "hard rules" from the curriculum's Volume
 * Profile series that are explicitly confluence/bias tools rather than
 * standalone entry triggers: session VWAP (Ch.17) and VPVR Value Area
 * (Ch.14). Each returns a `bias` ("long"|"short"|null) — the side the rule
 * still permits, or null if the rule gives no directional read.
 */
export function registerVolumeProfileTools(server) {
  server.tool('volume_profile_calculate_vwap', 'Calculate session VWAP (Volume-Weighted Average Price), resetting at each UTC day boundary (Ch.17) — typicalPrice = (high+low+close)/3, weighted by volume', {
    bars: z.array(barSchema).describe('OHLC+volume candle array, oldest first, with open_time (e.g. from binance klines)'),
  }, async ({ bars }) => {
    try { return jsonResult({ success: true, vwap: core.calculateSessionVWAP(bars) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'volume_profile_vwap_bias',
    'Apply Ch.17\'s hard VWAP rule to the latest bar: "If price is above VWAP, don\'t short. If below VWAP, don\'t long." ' +
    'Returns the only side the rule still permits as `bias` ("long"|"short"), or null if VWAP is not yet computable.',
    {
      bars: z.array(barSchema).describe('OHLC+volume candle array, oldest first, with open_time — same timeframe as the trade trigger (curriculum: rule does not apply on 4H swing trades)'),
    },
    async ({ bars }) => {
      try { return jsonResult({ success: true, ...core.classifyVWAPBias(bars) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'volume_profile_calculate_value_area',
    'Calculate a volume-by-price profile (Ch.14 VPVR) over a bar series: bins each bar\'s volume by its close price, finds the ' +
    'Point of Control (POC, the highest-volume bin) and expands outward to build the Value Area covering `value_area_percent` of total volume',
    {
      bars: z.array(barSchema).describe('OHLC+volume candle array, oldest first'),
      bins: z.coerce.number().int().positive().optional().describe('Number of price bins to divide the close-price range into (default 24)'),
      value_area_percent: z.coerce.number().positive().max(100).optional().describe('Percent of total volume the Value Area should cover (default 70)'),
    },
    async ({ bars, bins, value_area_percent }) => {
      try { return jsonResult({ success: true, ...core.calculateValueArea(bars, { bins, valueAreaPercent: value_area_percent }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'volume_profile_value_area_bias',
    'Apply Ch.14\'s hard VPVR rule to the latest bar: "Above VaH -> trading above Fair Value, look for shorts. Below VaL -> ' +
    'trading below Fair Value, look for longs." Returns the favored side as `bias` ("long"|"short"), or null if price is inside the Value Area.',
    {
      bars: z.array(barSchema).describe('OHLC+volume candle array, oldest first'),
      bins: z.coerce.number().int().positive().optional().describe('Number of price bins to divide the close-price range into (default 24)'),
      value_area_percent: z.coerce.number().positive().max(100).optional().describe('Percent of total volume the Value Area should cover (default 70)'),
    },
    async ({ bars, bins, value_area_percent }) => {
      try { return jsonResult({ success: true, ...core.classifyValueAreaBias(bars, { bins, valueAreaPercent: value_area_percent }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
