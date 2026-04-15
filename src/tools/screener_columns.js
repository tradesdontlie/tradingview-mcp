import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener_columns.js';

/**
 * MVP action: list. Stretch (reset, remove, add, reorder) return not_implemented_yet.
 */
export function registerScreenerColumnsTools(server) {
  server.tool(
    'screener_columns',
    'Manage visible columns in the open Stock Screener. Actions: list (returns current column headers). Stretch actions (reset, remove, add, reorder) return not_implemented_yet — use the "Column setup" button in TradingView for now. Call screener_open first.',
    {
      action: z.enum(['list', 'reset', 'remove', 'add', 'reorder']).describe('The column action to perform.'),
      column: z.string().optional().describe('Column name — for remove/add.'),
      columns: z.array(z.string()).optional().describe('Full desired column order — for reorder (stretch).'),
    },
    async ({ action, column, columns }) => {
      try {
        let result;
        switch (action) {
          case 'list':    result = await core.list(); break;
          case 'reset':   result = await core.reset(); break;
          case 'remove':  result = await core.remove({ column }); break;
          case 'add':     result = await core.add({ column }); break;
          case 'reorder': result = await core.reorder({ columns }); break;
          default:        throw new Error('unknown action: ' + action);
        }
        return jsonResult(result);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
