import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/hotlist.js';

export function registerHotlistTools(server) {
  server.tool(
    'hotlist_get',
    'Fetch a TradingView US hotlist (dynamic scanner preset) by slug. No auth required. Returns up to 20 symbols sorted by the hotlist field. Useful for refreshing watchlists with market-moving tickers. Slugs: volume_gainers, percent_change_gainers/losers, percent_range_gainers/losers, gap_gainers/losers, percent_gap_gainers/losers.',
    {
      slug: z.string().describe('Hotlist slug (without "US_" prefix). E.g. "volume_gainers", "percent_change_losers", "gap_gainers".'),
      limit: z.coerce.number().optional().describe('Cap returned symbols (default 20, max 20 — TV page size).'),
    },
    async ({ slug, limit }) => {
      try { return jsonResult(await core.getHotlist({ slug, limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
