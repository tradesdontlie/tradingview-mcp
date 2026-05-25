// EGX (Egyptian Exchange) tools — Group F (7 tools).
// Thin layer over the generic TV screener + TA clients with EGX-specific
// resolution helpers (indices, sector mapping). Egypt-only relevance; not
// required for India workflows but kept for upstream parity.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { screenerQuery, baseColumns, changeKey } from '../core/tv_screener.js';
import * as tvTa from '../core/tv_ta.js';
import { extractExtendedIndicators } from '../core/indicators_calc.js';
import {
  EGX_INDICES, EGX_SECTORS, EGX_SECTOR_SAMPLES, constituentsForIndex,
} from '../core/egx_data.js';

const SCREENER = 'egypt';
const EXCHANGE = 'EGX';

function rankRows(rows, timeframe) {
  return rows.map(r => ({
    symbol: r.symbol.replace(/^EGX:/, ''),
    name: r.values.name,
    price: r.values.close,
    change_pct: r.values.change,
    volume: r.values.volume,
    rsi: r.values.RSI,
  }));
}

function fibLevels(swingHigh, swingLow) {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  return {
    '0.0': swingHigh,
    '0.236': swingHigh - range * 0.236,
    '0.382': swingHigh - range * 0.382,
    '0.5':   swingHigh - range * 0.5,
    '0.618': swingHigh - range * 0.618,
    '0.786': swingHigh - range * 0.786,
    '1.0': swingLow,
  };
}

export function registerEgxTools(server) {
  // ── egx_market_overview ───────────────────────────────────────
  server.tool(
    'egx_market_overview',
    'Snapshot of EGX market: top gainers + losers by change% on the chosen timeframe.',
    {
      timeframe: z.string().default('1D'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ timeframe, limit }) => {
      try {
        const cols = baseColumns(timeframe);
        const [g, l] = await Promise.all([
          screenerQuery({ screener: SCREENER, exchange: EXCHANGE, columns: cols,
            sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' }, range: [0, limit] }),
          screenerQuery({ screener: SCREENER, exchange: EXCHANGE, columns: cols,
            sort: { sortBy: changeKey(timeframe), sortOrder: 'asc' }, range: [0, limit] }),
        ]);
        return jsonResult({
          exchange: 'EGX',
          timeframe,
          top_gainers: rankRows(g.rows, timeframe),
          top_losers: rankRows(l.rows, timeframe),
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_sector_scan ──────────────────────────────────────────
  server.tool(
    'egx_sector_scan',
    'Scan all stocks in an EGX sector (banks, real_estate, basic_resources, ...). Returns ranked by change%.',
    {
      sector: z.string().describe('Sector slug (see EGX_SECTORS)'),
      timeframe: z.string().default('1D'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ sector, timeframe, limit }) => {
      try {
        const sym = EGX_SECTOR_SAMPLES[sector] || [];
        if (!sym.length) {
          return jsonResult({ error: `unknown sector ${sector}`, valid: EGX_SECTORS });
        }
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener: SCREENER, exchange: EXCHANGE, columns: cols,
          filter: [{ left: 'name', operation: 'in_range', right: sym }],
          sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' }, range: [0, limit],
        });
        return jsonResult({ sector, timeframe, count: rows.length, rows: rankRows(rows, timeframe) });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_sector_scanner ───────────────────────────────────────
  server.tool(
    'egx_sector_scanner',
    'Rank EGX sectors by aggregate momentum (avg change% across sector constituents). Top sectors first.',
    {
      timeframe: z.string().default('1D'),
      top_n_sectors: z.number().int().min(1).max(15).default(5),
      top_n_stocks: z.number().int().min(1).max(20).default(3),
    },
    async ({ timeframe, top_n_sectors, top_n_stocks }) => {
      try {
        const cols = baseColumns(timeframe);
        const sectorRankings = [];
        for (const [sector, symbols] of Object.entries(EGX_SECTOR_SAMPLES)) {
          if (!symbols.length) continue;
          const { rows } = await screenerQuery({
            screener: SCREENER, exchange: EXCHANGE, columns: cols,
            filter: [{ left: 'name', operation: 'in_range', right: symbols }],
            sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' }, range: [0, 50],
          });
          if (!rows.length) continue;
          const changes = rows.map(r => r.values.change).filter(v => v != null);
          if (!changes.length) continue;
          const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
          sectorRankings.push({
            sector,
            avg_change_pct: Number(avgChange.toFixed(2)),
            stock_count: changes.length,
            top_stocks: rankRows(rows.slice(0, top_n_stocks), timeframe),
          });
        }
        sectorRankings.sort((a, b) => b.avg_change_pct - a.avg_change_pct);
        return jsonResult({ timeframe, sectors: sectorRankings.slice(0, top_n_sectors) });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_index_analysis ───────────────────────────────────────
  server.tool(
    'egx_index_analysis',
    'Analyze constituents of an EGX index (EGX30, EGX70, EGX100, SHARIAH33, EGX35LV, TAMAYUZ). EGX30 uses inline constituent list; others use TV screener filter.',
    {
      index: z.enum(EGX_INDICES).default('EGX30'),
      timeframe: z.string().default('1D'),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async ({ index, timeframe, limit }) => {
      try {
        const cols = baseColumns(timeframe);
        const constituents = constituentsForIndex(index);
        const filter = constituents
          ? [{ left: 'name', operation: 'in_range', right: constituents }]
          : [];
        const { rows } = await screenerQuery({
          screener: SCREENER, exchange: EXCHANGE, columns: cols, filter,
          sort: { sortBy: changeKey(timeframe), sortOrder: 'desc' }, range: [0, limit],
        });
        return jsonResult({ index, timeframe, count: rows.length, rows: rankRows(rows, timeframe) });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_stock_screener ───────────────────────────────────────
  server.tool(
    'egx_stock_screener',
    'Production EGX screener with composite score (change% + RSI band + volume). Used to surface tradable setups across EGX.',
    {
      timeframe: z.string().default('1D'),
      min_score: z.number().default(5),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ timeframe, min_score, limit }) => {
      try {
        const cols = baseColumns(timeframe);
        const { rows } = await screenerQuery({
          screener: SCREENER, exchange: EXCHANGE, columns: cols,
          sort: { sortBy: 'volume', sortOrder: 'desc' }, range: [0, 200],
        });
        const ranked = rows
          .map(r => {
            const v = r.values;
            let score = 0;
            if (v.change != null && v.change > 1) score += 3;
            else if (v.change != null && v.change > 0) score += 1;
            if (v.RSI != null && v.RSI > 50 && v.RSI < 70) score += 3;
            if (v.volume != null && v.average_volume_10d_calc &&
                v.volume > v.average_volume_10d_calc * 1.5) score += 4;
            return {
              symbol: r.symbol.replace(/^EGX:/, ''),
              name: v.name,
              price: v.close,
              change_pct: v.change,
              rsi: v.RSI,
              score,
            };
          })
          .filter(x => x.score >= min_score)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        return jsonResult({ timeframe, min_score, count: ranked.length, rows: ranked });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_trade_plan ───────────────────────────────────────────
  server.tool(
    'egx_trade_plan',
    'Full trade plan for one EGX stock: TA + pivot S/R + entry/stop/target levels derived from BB and pivots.',
    {
      symbol: z.string().describe('Bare EGX ticker e.g. COMI'),
      timeframe: z.string().default('1D'),
    },
    async ({ symbol, timeframe }) => {
      try {
        const taRaw = await tvTa.getAnalysis({ symbol, exchange: 'EGX', timeframe });
        if (taRaw.error) return jsonResult(taRaw, true);
        const ta = extractExtendedIndicators(taRaw.indicators);
        const price = ta.price_data.current_price;
        const sr = ta.support_resistance;
        const bbLower = ta.bollinger_bands.lower;
        const bbUpper = ta.bollinger_bands.upper;
        const plan = {
          entry_zone: sr.support_1 != null && bbLower != null
            ? [Math.min(sr.support_1, bbLower), Math.max(sr.support_1, bbLower)]
            : null,
          stop_loss: sr.support_2,
          target_1: sr.resistance_1,
          target_2: sr.resistance_2,
          target_3: bbUpper,
          risk_reward:
            price != null && sr.support_1 != null && sr.resistance_1 != null
              ? Number(((sr.resistance_1 - price) / Math.max(0.001, price - sr.support_1)).toFixed(2))
              : null,
        };
        return jsonResult({
          symbol: `EGX:${symbol}`,
          timeframe,
          price,
          trend: ta.market_structure.trend,
          rsi: ta.rsi.value,
          macd_crossover: ta.macd.crossover,
          plan,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── egx_fibonacci_retracement ────────────────────────────────
  server.tool(
    'egx_fibonacci_retracement',
    'Fibonacci retracement levels for one EGX stock using BB.upper / BB.lower as swing-high / swing-low approximation. Returns 0/0.236/0.382/0.5/0.618/0.786/1.0 price levels.',
    {
      symbol: z.string(),
      timeframe: z.string().default('1D'),
    },
    async ({ symbol, timeframe }) => {
      try {
        const taRaw = await tvTa.getAnalysis({ symbol, exchange: 'EGX', timeframe });
        if (taRaw.error) return jsonResult(taRaw, true);
        const ta = extractExtendedIndicators(taRaw.indicators);
        const fib = fibLevels(ta.bollinger_bands.upper, ta.bollinger_bands.lower);
        return jsonResult({
          symbol: `EGX:${symbol}`,
          timeframe,
          price: ta.price_data.current_price,
          swing_high_approx: ta.bollinger_bands.upper,
          swing_low_approx: ta.bollinger_bands.lower,
          fibonacci_levels: fib,
          note: 'Swing high/low approximated via Bollinger Band upper/lower; for true swing pivots use TV chart visually.',
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
