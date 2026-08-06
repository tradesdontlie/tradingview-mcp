import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
  }, async ({ entity_id, inputs }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
  }, async ({ entity_id, visible }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_search', 'Search TradingView\'s Indicators dialog for indicators, strategies, and community/public scripts by keyword. Returns matching titles grouped by section (Technicals, Community, My scripts, etc.).', {
    query: z.string().describe('Search keyword, e.g. "RSI", "supertrend", "order block"'),
    limit: z.coerce.number().optional().describe('Max results to return (default 25)'),
  }, async ({ query, limit }) => {
    try { return jsonResult(await core.searchStudies({ query, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_add', 'Search the Indicators dialog and add a result to the chart by name. Works for strategies and community scripts, not just built-ins. Returns the new study entity_id.', {
    query: z.string().describe('Search keyword to find the indicator/strategy'),
    match: z.string().optional().describe('Exact title to add (default: the query). Case-insensitive; falls back to first title containing it.'),
    section: z.string().optional().describe('Restrict to a section: "Technicals", "Community", "My scripts", etc.'),
  }, async ({ query, match, section }) => {
    try { return jsonResult(await core.addStudyFromSearch({ query, match, section })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
