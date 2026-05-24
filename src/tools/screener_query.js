/**
 * MCP tool wrappers for the direct REST screener (scanner.tradingview.com).
 *
 * Three tools:
 *   - screener_query   : run a filter against the public scanner endpoint
 *   - screener_fields  : list known column / filter field names
 *   - screener_ops     : list filter operators
 *
 * These are independent of the UI-dialog screener tools (screener_open /
 * screener_get / etc.). Use this family when you want to ask the LLM /
 * scripts to mine the market without depending on the floating dialog.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener_query.js';

const filterClauseSchema = z.object({
  left: z.string().describe('Field name (e.g., "market_cap_basic", "RSI", "close")'),
  operation: z.string().describe('One of: greater, egreater, less, eless, equal, nequal, in_range, not_in_range, match, nmatch, empty, nempty'),
  right: z.any().describe('Right-hand value. Number, string, or [min,max] for in_range.'),
});

const sortSchema = z.object({
  sortBy: z.string().describe('Field name to sort by'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Default: desc'),
});

export function registerScreenerQueryTools(server) {
  server.tool(
    'screener_query',
    'Run a screener query directly against TradingView\'s public scanner REST endpoint. Bypasses the UI dialog — works even when screener_open fails. Auto-detects market from current chart symbol if not specified. Returns up to 500 rows. Example: filter=[{left:"RSI",operation:"less",right:30},{left:"market_cap_basic",operation:"greater",right:1e10}], sort={sortBy:"volume",sortOrder:"desc"}.',
    {
      market: z.string().optional().describe('Market slug: america, india, crypto, forex, uk, germany, japan, ... Defaults to the exchange of the current chart symbol.'),
      columns: z.array(z.string()).optional().describe('Field names to return. Default: name, close, change, volume, market_cap_basic, sector. Use screener_fields to discover available fields.'),
      filter: z.array(filterClauseSchema).optional().describe('Filter clauses, AND\'d together. Each clause: {left: fieldName, operation: opName, right: value}.'),
      sort: sortSchema.optional().describe('Sort spec: {sortBy: field, sortOrder: "asc"|"desc"}.'),
      range: z.array(z.number()).length(2).optional().describe('[start, end] row indices. Window capped at 500 rows. Default: [0, 100].'),
    },
    async (args) => {
      try { return jsonResult(await core.query(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_fields',
    'List known column / filter field names for screener_query, with one-line descriptions. Curated — TradingView\'s scanner has thousands of fields, this is the subset most queries use. Pass any field name to screener_query.columns or screener_query.filter[].left even if it\'s not in this list; unknown fields just return null.',
    {},
    async () => {
      try {
        return jsonResult({
          success: true,
          count: Object.keys(core.FIELDS_CATALOG).length,
          fields: core.FIELDS_CATALOG,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'screener_ops',
    'List filter operators (operation field) accepted by screener_query, with descriptions. Use these for the filter[].operation parameter.',
    {},
    async () => {
      try {
        return jsonResult({
          success: true,
          operations: core.FILTER_OPERATIONS,
          markets_known: core.KNOWN_MARKETS,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
