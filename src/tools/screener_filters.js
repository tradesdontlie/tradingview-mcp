import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener_filters.js';

/**
 * MVP actions: list, remove, clear.
 * Stretch (add, modify) return not_implemented_yet.
 */
export function registerScreenerFiltersTools(server) {
  server.tool(
    'screener_filters',
    'Manage filter pills in the open Stock Screener. Actions: list (returns visible filter pills with labels), remove (removes a pill by label — idempotent), clear (removes all pills). Stretch actions (add, modify) return not_implemented_yet — use the TradingView UI to add/configure filters. Call screener_open first.',
    {
      action: z.enum(['list', 'remove', 'clear', 'add', 'modify']).describe('The filter action to perform.'),
      filter: z.string().optional().describe('Filter pill label (e.g., "Market cap", "Price"). Required for remove/modify; used by add.'),
      operator: z.string().optional().describe('Comparison operator — reserved for add/modify (stretch).'),
      value: z.union([z.string(), z.number()]).optional().describe('Filter value — reserved for add/modify (stretch).'),
    },
    async ({ action, filter, operator, value }) => {
      try {
        let result;
        switch (action) {
          case 'list':    result = await core.list(); break;
          case 'remove':  result = await core.remove({ filter }); break;
          case 'clear':   result = await core.clear(); break;
          case 'add':     result = await core.add({ filter, operator, value }); break;
          case 'modify':  result = await core.modify({ filter, operator, value }); break;
          default:        throw new Error('unknown action: ' + action);
        }
        return jsonResult(result);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
