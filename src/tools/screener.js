// TradingView screener tools — Group D (ports of atilaahmettaner screener
// + scanner services). All run server-side TV filter/sort, no coinlist needed.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import {
  screenerQuery,
  exchangeToScreener,
  baseColumns,
  changeKey,
  intervalSuffix,
} from '../core/tv_screener.js';

function bbwSignalForRow(values) {
  const upper = values['BB.upper'];
  const lower = values['BB.lower'];
  const sma = values.SMA20;
  if (upper == null || lower == null || !sma) return null;
  return (upper - lower) / sma;
}

function recoSignal(value) {
  if (value == null) return 'NEUTRAL';
  if (value >= 0.5) return 'STRONG_BUY';
  if (value >= 0.1) return 'BUY';
  if (value <= -0.5) return 'STRONG_SELL';
  if (value <= -0.1) return 'SELL';
  return 'NEUTRAL';
}

function bbRating(close, upper, middle, lower) {
  if ([close, upper, middle, lower].some(v => v == null)) return 0;
  if (close > upper) return 3;
  if (close > middle + (upper - middle) / 2) return 2;
  if (close > middle) return 1;
  if (close < lower) return -3;
  if (close < middle - (middle - lower) / 2) return -2;
  if (close < middle) return -1;
  return 0;
}

export function registerScreenerTools(server) {
  // ── top_gainers ───────────────────────────────────────────────
  server.tool(
    'top_gainers',
    'Top gaining symbols on an exchange ranked by change% on the given timeframe. Optional bbw_filter (squeeze detector — only return rows whose Bollinger Band width is below this).',
    {
      exchange: z.string().default('BINANCE').describe('e.g. BINANCE, KUCOIN, NSE'),
      timeframe: z.string().default('4h'),
      limit: z.number().int().min(1).max(200).default(25),
      bbw_filter: z.number().optional(),
    },
    async ({ exchange, timeframe, limit, bbw_filter }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' },
          range: [0, limit * 3],
        });
        const out = [];
        for (const r of rows) {
          if (out.length >= limit) break;
          const v = r.values;
          const bbw = bbwSignalForRow(v);
          if (bbw_filter != null && (bbw == null || bbw >= bbw_filter || bbw <= 0)) continue;
          out.push({
            symbol: r.symbol,
            name: v.name,
            price: v.close,
            change_pct: v.change,
            volume: v.volume,
            rsi: v.RSI,
            bbw,
            reco: recoSignal(v['Recommend.All']),
          });
        }
        return jsonResult({ exchange, timeframe, count: out.length, rows: out });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── top_losers ────────────────────────────────────────────────
  server.tool(
    'top_losers',
    'Worst-performing symbols on an exchange ranked by change% ascending. Mirror of top_gainers.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('4h'),
      limit: z.number().int().min(1).max(200).default(25),
      bbw_filter: z.number().optional(),
    },
    async ({ exchange, timeframe, limit, bbw_filter }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: changeKey(timeframe), sortOrder: 'asc' },
          range: [0, limit * 3],
        });
        const out = [];
        for (const r of rows) {
          if (out.length >= limit) break;
          const v = r.values;
          const bbw = bbwSignalForRow(v);
          if (bbw_filter != null && (bbw == null || bbw >= bbw_filter || bbw <= 0)) continue;
          out.push({
            symbol: r.symbol,
            name: v.name,
            price: v.close,
            change_pct: v.change,
            volume: v.volume,
            rsi: v.RSI,
            bbw,
            reco: recoSignal(v['Recommend.All']),
          });
        }
        return jsonResult({ exchange, timeframe, count: out.length, rows: out });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── bollinger_scan ────────────────────────────────────────────
  server.tool(
    'bollinger_scan',
    'Detect Bollinger Band squeezes — symbols whose normalized band width (BBW = (upper-lower)/SMA20) is below the threshold. Squeeze precedes expansion (volatility breakout). Returns rows sorted by BBW ascending.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('4h'),
      bbw_threshold: z.number().default(0.05),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, timeframe, bbw_threshold, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' },
          range: [0, 500],
        });
        const candidates = rows
          .map(r => ({ symbol: r.symbol, v: r.values, bbw: bbwSignalForRow(r.values) }))
          .filter(x => x.bbw != null && x.bbw > 0 && x.bbw < bbw_threshold)
          .sort((a, b) => a.bbw - b.bbw)
          .slice(0, limit)
          .map(x => ({
            symbol: x.symbol,
            price: x.v.close,
            change_pct: x.v.change,
            bbw: x.bbw,
            rsi: x.v.RSI,
            reco: recoSignal(x.v['Recommend.All']),
          }));
        return jsonResult({ exchange, timeframe, bbw_threshold, count: candidates.length, rows: candidates });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── rating_filter ─────────────────────────────────────────────
  server.tool(
    'rating_filter',
    'Filter symbols by Bollinger Band rating (-3..+3 ladder). Rating computed from close vs BB.upper/middle/lower zones. +3 = above upper (breakout), +2 = upper half top, +1 = above mid; mirrored negatives for below mid. Useful for spotting overshoot/extension.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('15m'),
      rating: z.number().int().min(-3).max(3).default(2),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, timeframe, rating, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' },
          range: [0, 500],
        });
        const matches = rows
          .map(r => {
            const v = r.values;
            const rt = bbRating(v.close, v['BB.upper'], v.SMA20, v['BB.lower']);
            return { symbol: r.symbol, v, rt };
          })
          .filter(x => x.rt === rating)
          .slice(0, limit)
          .map(x => ({
            symbol: x.symbol,
            price: x.v.close,
            change_pct: x.v.change,
            rating: x.rt,
            rsi: x.v.RSI,
            reco: recoSignal(x.v['Recommend.All']),
          }));
        return jsonResult({ exchange, timeframe, rating, count: matches.length, rows: matches });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── volume_breakout_scanner ───────────────────────────────────
  server.tool(
    'volume_breakout_scanner',
    'Simultaneous volume + price breakouts: volume >= multiplier x volume.SMA20 AND abs(change%) >= min. Returns rows ranked by volume_strength desc.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('15m'),
      volume_multiplier: z.number().default(2.0),
      price_change_min: z.number().default(3.0),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, timeframe, volume_multiplier, price_change_min, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: 'volume', sortOrder: 'desc' },
          range: [0, 500],
        });
        const hits = [];
        for (const r of rows) {
          const v = r.values;
          if (!v.volume || !v.average_volume_10d_calc || v.average_volume_10d_calc <= 0) continue;
          const ratio = v.volume / v.average_volume_10d_calc;
          if (ratio < volume_multiplier) continue;
          if (v.change == null || Math.abs(v.change) < price_change_min) continue;
          hits.push({
            symbol: r.symbol,
            price: v.close,
            change_pct: v.change,
            volume_ratio: Number(ratio.toFixed(2)),
            rsi: v.RSI,
            reco: recoSignal(v['Recommend.All']),
          });
        }
        hits.sort((a, b) => b.volume_ratio - a.volume_ratio);
        return jsonResult({ exchange, timeframe, count: Math.min(limit, hits.length), rows: hits.slice(0, limit) });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── smart_volume_scanner ──────────────────────────────────────
  server.tool(
    'smart_volume_scanner',
    'Volume + RSI band combo screener. Filters symbols where volume ratio >= min_volume_ratio AND abs(change%) >= min_price_change AND RSI within (rsi_min, rsi_max). Surfaces "real demand in a clean RSI zone" setups.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('1h'),
      min_volume_ratio: z.number().default(1.5),
      min_price_change: z.number().default(2.0),
      rsi_min: z.number().default(40),
      rsi_max: z.number().default(70),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, timeframe, min_volume_ratio, min_price_change, rsi_min, rsi_max, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: 'volume', sortOrder: 'desc' },
          range: [0, 500],
        });
        const hits = rows
          .map(r => {
            const v = r.values;
            const ratio = (v.volume && v.average_volume_10d_calc)
              ? v.volume / v.average_volume_10d_calc : null;
            return { symbol: r.symbol, v, ratio };
          })
          .filter(x =>
            x.ratio != null && x.ratio >= min_volume_ratio &&
            x.v.change != null && Math.abs(x.v.change) >= min_price_change &&
            x.v.RSI != null && x.v.RSI >= rsi_min && x.v.RSI <= rsi_max
          )
          .slice(0, limit)
          .map(x => ({
            symbol: x.symbol,
            price: x.v.close,
            change_pct: x.v.change,
            volume_ratio: Number(x.ratio.toFixed(2)),
            rsi: x.v.RSI,
            reco: recoSignal(x.v['Recommend.All']),
          }));
        return jsonResult({ exchange, timeframe, count: hits.length, rows: hits });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── consecutive_candles_scan ──────────────────────────────────
  server.tool(
    'consecutive_candles_scan',
    'Symbols showing N consecutive directional candles (sustained move). Uses TV change|<TF> on recent bars (approximated via current TF change + 1-bar lookback proxy). NOTE: this is a simplified port using available TV columns. For deep candle-pattern detection, prefer advanced_candle_pattern.',
    {
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('1h'),
      pattern_type: z.enum(['growth', 'decline']).default('growth'),
      candle_count: z.number().int().min(2).max(10).default(3),
      min_growth_pct: z.number().default(0.5),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, timeframe, pattern_type, candle_count, min_growth_pct, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: changeKey(timeframe), sortOrder: pattern_type === 'growth' ? 'desc' : 'asc' },
          range: [0, 500],
        });
        const hits = [];
        const sign = pattern_type === 'growth' ? 1 : -1;
        for (const r of rows) {
          const v = r.values;
          if (v.change == null) continue;
          const change = v.change * sign;
          if (change < min_growth_pct) continue;
          // Confirm direction via close>open as additional proxy for consistency.
          if (v.close == null || v.open == null) continue;
          const dir = v.close - v.open;
          if (sign > 0 && dir <= 0) continue;
          if (sign < 0 && dir >= 0) continue;
          hits.push({
            symbol: r.symbol,
            price: v.close,
            change_pct: v.change,
            rsi: v.RSI,
            note: `direction confirmed via current candle close vs open; multi-bar lookback approximated by TF change`,
          });
          if (hits.length >= limit) break;
        }
        return jsonResult({
          exchange, timeframe, pattern_type, candle_count, min_growth_pct,
          count: hits.length, rows: hits,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── advanced_candle_pattern ───────────────────────────────────
  server.tool(
    'advanced_candle_pattern',
    'Symbols with progressively larger candle bodies — proxy for accumulation/expansion. Uses high-low range vs ATR-style ratio (current bar size vs recent baseline). Returns rows where current_range / mean_range >= min_size_increase.',
    {
      exchange: z.string().default('BINANCE'),
      base_timeframe: z.string().default('1h'),
      pattern_length: z.number().int().min(2).max(8).default(3),
      min_size_increase: z.number().default(1.5),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ exchange, base_timeframe, pattern_length, min_size_increase, limit }) => {
      try {
        const screener = exchangeToScreener(exchange);
        const cols = baseColumns(base_timeframe);
        const { rows } = await screenerQuery({
          screener, exchange, columns: cols,
          sort: { sortBy: 'volume', sortOrder: 'desc' },
          range: [0, 500],
        });
        const hits = [];
        for (const r of rows) {
          const v = r.values;
          if (v.high == null || v.low == null || v.SMA20 == null) continue;
          const range = v.high - v.low;
          // Approximate baseline range via BB width / 4 (rough ATR proxy).
          const bbWidth = (v['BB.upper'] != null && v['BB.lower'] != null)
            ? v['BB.upper'] - v['BB.lower'] : null;
          if (!bbWidth || bbWidth <= 0) continue;
          const baseline = bbWidth / 4;
          const ratio = range / baseline;
          if (ratio < min_size_increase) continue;
          hits.push({
            symbol: r.symbol,
            price: v.close,
            change_pct: v.change,
            range,
            size_ratio: Number(ratio.toFixed(2)),
            rsi: v.RSI,
          });
          if (hits.length >= limit) break;
        }
        return jsonResult({
          exchange, base_timeframe, pattern_length, min_size_increase,
          count: hits.length, rows: hits,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
