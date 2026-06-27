import { z } from 'zod';
import { wrap } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, wrap(core.list));

  server.tool('tab_new', 'Open a new chart tab', {}, wrap(core.newTab));

  server.tool('tab_close', 'Close the current chart tab', {}, wrap(core.closeTab));

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().int().nonnegative().describe('Tab index (0-based, from tab_list)'),
  }, wrap(core.switchTab));
}
