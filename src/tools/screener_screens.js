import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener_screens.js';

/**
 * Action-dispatched tool — matches the pattern of chart_manage_indicator.
 * MVP actions: active, menu_actions, save.
 * Stretch actions (list, switch, save_as, delete, rename, create_new) return
 * `not_implemented_yet` at the core layer until the modal DOM flows are wired.
 */
export function registerScreenerScreensTools(server) {
  server.tool(
    'screener_screens',
    'Manage Stock Screener saved screens (presets). Actions: active (returns current screen name), menu_actions (lists which screen actions are currently enabled/disabled in the UI), save (saves current screen changes to the cloud if enabled). Stretch actions (list, switch, save_as, delete, rename, create_new) return not_implemented_yet — use the TradingView UI directly for those.',
    {
      action: z.enum([
        'active', 'menu_actions', 'save',
        'list', 'switch', 'save_as', 'delete', 'rename', 'create_new',
      ]).describe('The screen management action to perform.'),
      name: z.string().optional().describe('Screen name — required for switch/delete/rename (source).'),
      new_name: z.string().optional().describe('Target name — used by save_as/rename/create_new.'),
    },
    async ({ action, name, new_name }) => {
      try {
        let result;
        switch (action) {
          case 'active':       result = await core.active(); break;
          case 'menu_actions': result = await core.menu_actions(); break;
          case 'save':         result = await core.save(); break;
          case 'list':         result = await core.list(); break;
          case 'switch':       result = await core.switchTo({ name }); break;
          case 'save_as':      result = await core.save_as({ name: new_name || name }); break;
          case 'delete':       result = await core.remove({ name }); break;
          case 'rename':       result = await core.rename({ name, new_name }); break;
          case 'create_new':   result = await core.createNew({ name: new_name || name }); break;
          default:             throw new Error('unknown action: ' + action);
        }
        return jsonResult(result);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
