// Composed analysis tools — Group E. These compose tools from Groups B+C
// rather than introducing new data sources. multi_agent_analysis returns
// pre-formatted prompts/data for Claude to apply a 3-agent debate; the LLM
// work happens on the client side.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as tvTa from '../core/tv_ta.js';
import { extractExtendedIndicators } from '../core/indicators_calc.js';
import { analyzeSentiment } from '../core/sentiment.js';
import { fetchNewsSummary } from '../core/news.js';

export function registerComposedTools(server) {
  server.tool(
    'multi_agent_analysis',
    'Structured 3-agent debate input for any symbol: Technical agent (TA indicators), Sentiment agent (Reddit sentiment), Risk agent (volatility, MA structure, support/resistance). Returns each agent\'s evidence block. Claude applies the debate prompt client-side and renders the verdict.',
    {
      symbol: z.string(),
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('4h'),
      sentiment_category: z.enum(['crypto', 'stocks', 'all']).default('all'),
    },
    async ({ symbol, exchange, timeframe, sentiment_category }) => {
      try {
        const taRaw = await tvTa.getAnalysis({ symbol, exchange, timeframe });
        if (taRaw.error) return jsonResult({ symbol, error: taRaw.error }, true);
        const ta = extractExtendedIndicators(taRaw.indicators);
        const sentiment = await analyzeSentiment({ symbol, category: sentiment_category, limit: 20 });

        const technical_agent = {
          role: 'Technical Analyst',
          evidence: {
            price: ta.price_data.current_price,
            change_pct: ta.price_data.change_percent,
            rsi: ta.rsi,
            macd: ta.macd,
            bollinger: ta.bollinger_bands,
            sma: ta.sma,
            ema: ta.ema,
            stochastic: ta.stochastic,
            tv_reco: ta.market_sentiment,
          },
        };

        const sentiment_agent = {
          role: 'Sentiment Analyst',
          evidence: {
            score: sentiment.sentiment_score,
            label: sentiment.sentiment_label,
            posts_analyzed: sentiment.posts_analyzed,
            bullish_count: sentiment.bullish_count,
            bearish_count: sentiment.bearish_count,
            top_posts: sentiment.top_posts,
          },
        };

        const risk_agent = {
          role: 'Risk Analyst',
          evidence: {
            adx: ta.adx,
            trend_score: ta.market_structure.trend_score,
            trend_strength: ta.market_structure.trend_strength,
            support_resistance: ta.support_resistance,
            momentum_aligned: ta.market_structure.momentum_aligned,
            obv_direction: ta.obv.direction,
          },
        };

        return jsonResult({
          symbol: `${exchange}:${symbol}`,
          timeframe,
          agents: [technical_agent, sentiment_agent, risk_agent],
          prompt_hint:
            'Run each agent\'s evidence against your debate prompt. ' +
            'Output: per-agent verdict (bullish/bearish/neutral) + confidence (1-5), ' +
            'then majority decision + dissent summary.',
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'combined_analysis',
    'One-call power tool: TA indicators + Reddit sentiment + RSS news headlines for a symbol. Pairs well with morning brief / pre-trade decisions.',
    {
      symbol: z.string(),
      exchange: z.string().default('BINANCE'),
      timeframe: z.string().default('4h'),
      news_category: z.enum(['crypto', 'stocks', 'all']).default('all'),
      news_limit: z.number().int().min(1).max(20).default(5),
      sentiment_limit: z.number().int().min(5).max(50).default(15),
    },
    async ({ symbol, exchange, timeframe, news_category, news_limit, sentiment_limit }) => {
      try {
        const [taRaw, sentiment, news] = await Promise.all([
          tvTa.getAnalysis({ symbol, exchange, timeframe }),
          analyzeSentiment({ symbol, category: news_category, limit: sentiment_limit }),
          fetchNewsSummary({ symbol, category: news_category, limit: news_limit }),
        ]);
        const ta = !taRaw.error ? extractExtendedIndicators(taRaw.indicators) : null;
        return jsonResult({
          symbol: `${exchange}:${symbol}`,
          timeframe,
          technical: ta,
          ta_error: taRaw.error || null,
          sentiment,
          news,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
