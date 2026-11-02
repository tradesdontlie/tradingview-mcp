import { z } from 'zod';
import { jsonResult } from './_format.js';
import { loadHistory } from '../core/history.js';
import { getIndicatorStyle, setIndicatorStyle } from '../core/indicator-styles.js';
import { getWatchlistSections, createWatchlistSection, moveToWatchlistSection } from '../core/watchlist-sections.js';

export function registerAnalysisExtensionTools(server) {
  const register = (name, description, schema, handler) => server.tool(name, description, schema, async args => {
    try { return jsonResult(await handler(args)); }
    catch (error) { return jsonResult({ success: false, error: error.message }, true); }
  });
  register('data_load_history', 'Load older data for the current chart without zoom, scroll, symbol or timeframe changes. count means minimum total loaded bars; before is Unix seconds. Stops on bounds, exhaustion or detected viewport changes and reports exact status.', {
    before: z.number().int().min(-62135596800).max(253402300799).optional().describe('Load until the oldest bar is at or before this Unix-second timestamp.'),
    count: z.number().int().min(1).max(100000).optional().describe('Minimum total loaded bars. Defaults to 5000 if before is omitted.'),
    max_iterations: z.number().int().min(1).max(50).optional().describe('Maximum page requests (default 10).'),
    timeout_ms: z.number().int().min(100).max(120000).optional().describe('Overall loading budget in milliseconds (default 30000).'),
    page_size: z.number().int().min(1).max(10000).optional().describe('Bars requested per page (default 1000).'),
    settle_ms: z.number().int().min(1).max(2000).optional().describe('Polling interval per page in milliseconds (default 250).'),
  }, loadHistory);
  register('indicator_get_style', 'Read the actual style tree for one exact current indicator entity_id. The styles.* and graphics.* leaves identify available dotted override paths.', {
    entity_id: z.string().min(1).max(200).describe('Exact entity ID from chart_get_state.'),
  }, getIndicatorStyle);
  register('indicator_set_style', 'Apply bounded style-only dotted overrides to one exact indicator; read back every field. Unknown paths are rejected before mutation. Unconfirmed writes attempt a verified rollback. Colors accept hex; visible accepts booleans; widths and numeric styles are bounded.', {
    entity_id: z.string().min(1).max(200).describe('Exact entity ID from chart_get_state.'),
    overrides: z.string().min(2).max(20000).describe('JSON object of dotted style leaves, e.g. {"styles.vol.color":"#FFC107","styles.vol.linewidth":2}.'),
  }, setIndicatorStyle);
  const listId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('Custom watchlist ID. Omit only when its existing panel exposes the active list; this tool never opens the panel.');
  const section = z.string().min(1).max(100).describe('Exact section name without the native ### prefix. Duplicate names are rejected as ambiguous.');
  const revision = z.string().regex(/^[0-9a-f]{64}$/).optional().describe('Optional revision returned by watchlist_get_sections; reject this request if that observed state is stale. The server API does not offer a documented atomic compare-and-swap contract.');
  register('watchlist_get_sections', 'Read native ### sections and their symbols, including the initial ungrouped entries, from a custom watchlist.', { list_id: listId }, getWatchlistSections);
  register('watchlist_create_section', 'Append a named empty native ### watchlist section while preserving every existing entry. Repeating an already completed request is a no-op. Uses fresh-state preflight and exact server readback.', { list_id: listId, section, expected_revision: revision }, createWatchlistSection);
  register('watchlist_move_to_section', 'Move existing exact SOURCE:TICKER entries to a named section, preserving their original relative order and all unrelated entries. Does not add or delete symbols. Duplicate-safe retry; concurrent or unconfirmed server state is reported.', {
    list_id: listId, section, expected_revision: revision,
    symbols: z.array(z.string().regex(/^[^:\s]+:[^:\s]+$/)).min(1).max(100).describe('Existing unique SOURCE:TICKER entries to move.'),
  }, moveToWatchlistSection);
}
