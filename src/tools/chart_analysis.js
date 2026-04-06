/**
 * Chart analysis tools — ASCII visualizations for AI pattern recognition.
 *
 * REQUIREMENT: All tools require a candlestick-based chart type.
 * Supported: Candles, Bars, Hollow Candles, Heikin Ashi, Baseline.
 * Unsupported: Renko, Kagi, Point & Figure, Line Break — these chart types
 * do not expose standard OHLCV bar data via the CDP bar API.
 *
 * PARAMETER NOTE: MCP transports may deliver numeric arguments as JSON strings.
 * All numeric params use z.union([z.number(), z.string().transform(Number)]) so
 * coercion happens at the Zod layer regardless of how the transport serializes them.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart_analysis.js';

// Reusable numeric schema that accepts both number and string inputs from MCP.
const zNum = z.union([z.number(), z.string().transform(Number)]).optional();

// Appended to all error responses so Claude knows the likely fix.
const CHART_TYPE_HINT =
  'Switch to a candlestick-based chart type: Candles, Bars, Hollow Candles, or ' +
  'Heikin Ashi. Renko, Kagi, Point & Figure, and Line Break charts do not expose ' +
  'OHLCV bar data and cannot be used with these analysis tools.';

export function registerChartAnalysisTools(server) {

  server.tool(
    'chart_price_action',

    'Render an ASCII candlestick (or Heikin-Ashi) chart of the current TradingView ' +
    'chart and return per-bar structure labels. Each bar shows: bullish (█) or bearish (▓) ' +
    'body, wicks (│), HH/HL/LH/LL label vs the prior bar, candlestick pattern ' +
    '(Hammer, Shooting Star, Doji, Marubozu Bull/Bear, Bullish/Bearish Engulf, ' +
    'Spinning Top), and volume character (AboveAvg / Avg / BelowAvg). ' +
    'Use style=heikin_ashi for a noise-filtered trend view. ' +
    'Requires a candlestick-based chart type (not Renko / Kagi / P&F).',

    {
      count: zNum.describe('Bars to chart — default 50, max 200'),
      style: z.enum(['candlestick', 'heikin_ashi']).optional()
        .describe('Chart style: candlestick (default) or heikin_ashi'),
    },

    async ({ count, style }) => {
      try {
        return jsonResult(await core.getPriceActionChart({ count, style }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message, hint: CHART_TYPE_HINT }, true);
      }
    }
  );

  server.tool(
    'chart_individual_bar',

    'Deep-dive anatomy of a single bar with ASCII diagram. Returns: body size and ' +
    'percentage of total range, upper/lower wick sizes and percentages, candlestick ' +
    'pattern classification (Marubozu, Hammer, Shooting Star, Doji, Spinning Top, ' +
    'Bullish/Bearish Engulf), HH/LH/HL/LL structure vs the prior bar, volume character, ' +
    'and a battle narrative (where bulls pushed, where bears rejected). ' +
    'bar_index 0 = oldest bar in window; omit for the most recent bar. ' +
    'Requires a candlestick-based chart type.',

    {
      bar_index: zNum.describe('Index of bar to examine — 0=oldest, default=most recent'),
      count: zNum.describe('Window size to load for context — default 50'),
    },

    async ({ bar_index, count }) => {
      try {
        return jsonResult(await core.getIndividualBarChart({ bar_index, count }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message, hint: CHART_TYPE_HINT }, true);
      }
    }
  );

  server.tool(
    'chart_volume_profile',

    'Volume profile (market profile) with ASCII horizontal histogram. Each price bucket ' +
    'shows total volume, buying volume (█) vs selling volume (░), and bar count. ' +
    'Marks Point of Control (highest-volume price level), Value Area High and Value Area ' +
    'Low (the price range containing 70% of total volume). Use to identify high-volume ' +
    'nodes where price accepted value, thin areas where price will move through quickly, ' +
    'and the dominant side (buyers vs sellers) at each level. ' +
    'Requires a candlestick-based chart type.',

    {
      count: zNum.describe('Bars to include in the profile — default 100, max 500'),
      price_levels: zNum.describe('Number of price buckets — default 20, max 40'),
    },

    async ({ count, price_levels }) => {
      try {
        return jsonResult(await core.getVolumeProfileChart({ count, price_levels }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message, hint: CHART_TYPE_HINT }, true);
      }
    }
  );

  server.tool(
    'chart_structure',

    'Market structure analysis with ASCII chart overlay. Detects swing highs and lows ' +
    'using a ±lookback bar window (port of ownership.py:label_structure), labels each ' +
    'confirmed swing as HH / LH / HL / LL relative to the prior swing of the same type, ' +
    'and marks them on the ASCII chart (H above swing highs, L below swing lows). ' +
    'Derives two trend lines: resistance line through the last two swing highs, support ' +
    'line through the last two swing lows — each with slope (pts/bar) and current ' +
    'projected price. Extracts the last three resistance and support levels. ' +
    'Computes Al Brooks consecutive H/L signal bar counts (H1/H2/H3/H4 = consecutive ' +
    'bullish signal bars; L1/L2/L3/L4 = consecutive bearish signal bars) shown below ' +
    'the chart. Higher lookback = fewer, more significant swings detected. ' +
    'Requires a candlestick-based chart type.',

    {
      count: zNum.describe('Bars to analyze — default 60, max 200'),
      lookback: zNum.describe(
        'Swing lookback window each side in bars — default 3, max 5. ' +
        'Higher values detect only major swings and ignore minor ones.'
      ),
    },

    async ({ count, lookback }) => {
      try {
        return jsonResult(await core.getStructureChart({ count, lookback }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message, hint: CHART_TYPE_HINT }, true);
      }
    }
  );
}
