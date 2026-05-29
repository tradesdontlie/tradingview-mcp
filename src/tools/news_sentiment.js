// News + sentiment tools — Group B (atilaahmettaner port).

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as news from '../core/news.js';
import * as sentiment from '../core/sentiment.js';

export function registerNewsSentimentTools(server) {
  server.tool(
    'market_sentiment',
    'Reddit sentiment analysis for any ticker via keyword scoring (bullish/bearish lexicon). Searches relevant subreddits (crypto: CryptoCurrency, Bitcoin, ethereum, CryptoMarkets, altcoin / stocks: stocks, investing, wallstreetbets, StockMarket, ValueInvesting / all: mixed). Returns sentiment_score (-1..+1), label, post breakdown, top 5 posts.',
    {
      symbol: z.string().describe('Asset ticker/name (e.g. AAPL, BTC, ETH, TSLA)'),
      category: z.enum(['crypto', 'stocks', 'all']).default('all'),
      limit: z.number().int().min(5).max(100).default(20),
    },
    async ({ symbol, category, limit }) => {
      try {
        return jsonResult(await sentiment.analyzeSentiment({ symbol, category, limit }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'financial_news',
    'Latest financial news from RSS feeds (CoinDesk, CoinTelegraph, Yahoo Finance, MarketWatch, CNBC). Optional symbol filter (case-insensitive substring match on title+summary). category: crypto | stocks | all. Limit 1-50.',
    {
      symbol: z.string().optional().describe('Optional ticker filter (case-insensitive)'),
      category: z.enum(['crypto', 'stocks', 'all']).default('stocks'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ symbol, category, limit }) => {
      try {
        return jsonResult(await news.fetchNewsSummary({ symbol, category, limit }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
