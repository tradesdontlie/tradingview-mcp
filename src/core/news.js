// Financial news service — ported from atilaahmettaner/news_service.py.
// RSS-driven, no API key required. Symbol filter is case-insensitive substring.

import Parser from 'rss-parser';

const USER_AGENT =
  'Mozilla/5.0 (compatible; tradingview-mcp/0.7.1; +https://github.com/asat2094/tradingview-mcp)';
const TIMEOUT_MS = 8_000;

const RSS_FEEDS = {
  crypto: [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
  ],
  stocks: [
    { url: 'https://finance.yahoo.com/news/rssindex', name: 'Yahoo Finance' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', name: 'MarketWatch Top Stories' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', name: 'MarketWatch Real-Time' },
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', name: 'CNBC Top News' },
  ],
  all: [
    { url: 'https://finance.yahoo.com/news/rssindex', name: 'Yahoo Finance' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', name: 'MarketWatch Top Stories' },
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', name: 'CNBC Top News' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
  ],
};

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
});

function cleanHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export async function fetchNews({ symbol, category = 'stocks', limit = 10 } = {}) {
  const feeds = RSS_FEEDS[category] || RSS_FEEDS.stocks;
  const results = [];

  for (const feedInfo of feeds) {
    if (results.length >= limit) break;
    try {
      const feed = await parser.parseURL(feedInfo.url);
      const sourceName = feed.title || feedInfo.name;
      for (const entry of feed.items || []) {
        if (results.length >= limit) break;
        const title = entry.title || '';
        const summary = entry.contentSnippet || entry.content || entry.summary || '';
        if (symbol) {
          const combined = `${title} ${summary}`.toUpperCase();
          if (!combined.includes(symbol.toUpperCase())) continue;
        }
        results.push({
          title,
          url: entry.link || '',
          published: entry.pubDate || entry.isoDate || '',
          summary: cleanHtml(summary).slice(0, 300),
          source: sourceName,
        });
      }
    } catch {
      // Skip dead/blocked feeds silently.
    }
  }
  return results.slice(0, limit);
}

export async function fetchNewsSummary({ symbol, category = 'stocks', limit = 10 } = {}) {
  const items = await fetchNews({ symbol, category, limit });
  return {
    symbol: symbol || null,
    category,
    count: items.length,
    items,
    timestamp: new Date().toISOString(),
  };
}
