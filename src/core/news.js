/**
 * Core news logic.
 *
 * Strategy 1: REST API via news-headlines.tradingview.com (authenticated via browser session)
 * Strategy 2: DOM scrape of the news panel as fallback
 */
import { evaluate, evaluateAsync, getChartApi } from '../connection.js';

/**
 * Get current chart symbol in EXCHANGE:SYMBOL format (e.g. "NASDAQ:AAPL").
 * Returns null if it can't be determined.
 */
async function getCurrentSymbolFull() {
  try {
    const apiPath = await getChartApi();
    return await evaluate(`
      (function() {
        try {
          var chart = ${apiPath};
          // symbol() returns bare ticker; symbolInfo has full_name with exchange prefix
          var info = chart.symbolInfo && chart.symbolInfo();
          if (info && info.full_name) return info.full_name;
          // Fall back to exchange + ticker concatenation
          if (info && info.exchange && info.ticker) return info.exchange + ':' + info.ticker;
          // Last resort: just return raw symbol()
          return chart.symbol ? chart.symbol() : null;
        } catch(e) { return null; }
      })()
    `);
  } catch {
    return null;
  }
}

/**
 * Fetch headlines via the internal TradingView news REST API.
 * The request runs inside the browser context so it inherits the user's session cookies.
 */
async function fetchViaRestApi({ symbol, count, lang }) {
  const params = new URLSearchParams({ lang, client: 'overview' });
  if (symbol) params.set('symbol', symbol);

  const result = await evaluateAsync(`
    (function() {
      var url = 'https://news-headlines.tradingview.com/v2/headlines?' + ${JSON.stringify(params.toString())};
      return fetch(url, {
        credentials: 'include',
        headers: {
          'Origin': 'https://www.tradingview.com',
          'Referer': 'https://www.tradingview.com/',
        }
      })
        .then(function(r) {
          if (!r.ok) return { error: 'HTTP ' + r.status };
          return r.json();
        })
        .then(function(data) {
          if (!data || data.error) return { error: data && data.error ? data.error : 'Empty response' };
          // Response is typically an array of headline objects
          var items = Array.isArray(data) ? data : (data.items || data.headlines || []);
          return { items: items };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  if (result && result.error) return { success: false, error: result.error, source: 'rest_api' };
  if (!result || !Array.isArray(result.items)) return { success: false, error: 'Unexpected response format', source: 'rest_api' };

  const articles = result.items.slice(0, count).map(function(item) {
    return {
      id: item.id,
      title: item.title,
      published: item.published,
      source: item.source,
      provider: item.provider,
      urgency: item.urgency,
      link: item.link || item.story_path || null,
      related_symbols: item.relatedSymbols || item.related_symbols || [],
    };
  });

  return { success: true, source: 'rest_api', count: articles.length, articles };
}

/**
 * Fallback: scrape the TradingView news panel from the DOM.
 * Works if the user has the news widget open in the right sidebar.
 */
async function fetchViaDom({ count }) {
  const articles = await evaluate(`
    (function() {
      var count = ${count};
      // TradingView news items share a common CSS pattern
      var selectors = [
        '[class*="newsItem"]',
        '[class*="news-item"]',
        '[class*="story"]',
        '[class*="headline"]',
        '[data-news-item]',
      ];
      var items = [];
      for (var si = 0; si < selectors.length && items.length === 0; si++) {
        items = Array.from(document.querySelectorAll(selectors[si]));
      }
      if (items.length === 0) return null;

      var results = [];
      for (var i = 0; i < Math.min(items.length, count); i++) {
        var el = items[i];
        var title = (el.querySelector('[class*="title"]') || el.querySelector('[class*="headline"]') || el)
                      .textContent.trim();
        var timeEl = el.querySelector('time, [class*="time"], [class*="date"]');
        var time = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : null;
        var link = el.querySelector('a') ? el.querySelector('a').href : null;
        var src = el.querySelector('[class*="source"], [class*="provider"]');
        var provider = src ? src.textContent.trim() : null;
        if (title) results.push({ title: title, published: time, link: link, provider: provider });
      }
      return results;
    })()
  `);

  if (!articles) {
    return { success: false, error: 'News panel not found in DOM. Open the News widget in TradingView first.', source: 'dom_fallback' };
  }

  return { success: true, source: 'dom_fallback', count: articles.length, articles };
}

/**
 * Main exported function.
 *
 * @param {object} opts
 * @param {string}  [opts.symbol]   - Symbol in any format (e.g. "AAPL", "NASDAQ:AAPL").
 *                                    Defaults to the current chart symbol.
 * @param {number}  [opts.count=10] - Max number of articles to return.
 * @param {string}  [opts.lang="en"]- Language code.
 */
export async function getNews({ symbol, count = 10, lang = 'en' } = {}) {
  count = Math.min(Math.max(1, count || 10), 50);

  // Resolve symbol — prefer explicit arg, else current chart symbol
  let resolvedSymbol = symbol || null;
  if (!resolvedSymbol) {
    resolvedSymbol = await getCurrentSymbolFull();
  }

  // Strategy 1: REST API
  const restResult = await fetchViaRestApi({ symbol: resolvedSymbol, count, lang });
  if (restResult.success) {
    return { ...restResult, symbol: resolvedSymbol };
  }

  // Strategy 2: DOM fallback
  const domResult = await fetchViaDom({ count });
  return { ...domResult, symbol: resolvedSymbol, rest_api_error: restResult.error };
}

/**
 * Fetch the full body of a single news article by its ID.
 * Article IDs come from news_get results.
 */
export async function getNewsContent({ id, lang = 'en' }) {
  if (!id) throw new Error('Article id is required');

  const result = await evaluateAsync(`
    (function() {
      var url = 'https://news-headlines.tradingview.com/v2/content?id=' + encodeURIComponent(${JSON.stringify(id)}) + '&lang=${lang}';
      return fetch(url, {
        credentials: 'include',
        headers: {
          'Origin': 'https://www.tradingview.com',
          'Referer': 'https://www.tradingview.com/',
        }
      })
        .then(function(r) {
          if (!r.ok) return { error: 'HTTP ' + r.status };
          return r.json();
        })
        .then(function(data) {
          return { data: data };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  if (result && result.error) return { success: false, error: result.error };

  const d = result && result.data;
  return {
    success: true,
    id,
    title: d && d.title,
    body: d && (d.body || d.content || d.text),
    published: d && d.published,
    source: d && d.source,
    related_symbols: d && (d.relatedSymbols || d.related_symbols || []),
  };
}
