import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool(
    'news_get',
    'Get latest news headlines from TradingView for a symbol (or the current chart symbol). Returns article titles, timestamps, source, and links.',
    {
      symbol: z.string().optional().describe('Symbol to fetch news for (e.g. "AAPL", "NASDAQ:AAPL", "BTC"). Defaults to the current chart symbol.'),
      count: z.coerce.number().optional().describe('Number of articles to return (default 10, max 50)'),
      lang: z.string().optional().describe('Language code (default "en")'),
    },
    async ({ symbol, count, lang }) => {
      try { return jsonResult(await core.getNews({ symbol, count, lang })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_get_content',
    'Fetch the full body text of a TradingView news article by its ID (IDs come from news_get results).',
    {
      id: z.string().describe('Article ID from news_get'),
      lang: z.string().optional().describe('Language code (default "en")'),
    },
    async ({ id, lang }) => {
      try { return jsonResult(await core.getNewsContent({ id, lang })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
