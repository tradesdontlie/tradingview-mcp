/**
 * Market screener via an AUTHENTICATED in-page fetch to scanner.tradingview.com.
 *
 * The standalone data-API server scrapes this same endpoint ANONYMOUSLY and gets
 * daily-rate-limited (empty body -> "Expecting value"). This module instead runs
 * the fetch INSIDE the logged-in TradingView Desktop page over CDP, so the request
 * carries the user's session cookies (credentials:'include') and is treated as an
 * authenticated request — the same proven primitive the bridge already uses for
 * alerts (core/alerts.js) and pine-facade (core/pine.js).
 *
 * NOTE: TradingView's scanner JSON schema (filter operators, column ids) is
 * undocumented and changes occasionally — a renamed column breaks a query, not the
 * transport. Responses are guarded defensively.
 */
import { evaluateAsync, safeString } from '../connection.js';

// Map friendly market names to scanner.tradingview.com/{market}/scan path segments.
const MARKET_ALIASES = {
  us: 'america', usa: 'america', america: 'america', nasdaq: 'america', nyse: 'america', amex: 'america',
  egx: 'egypt', egypt: 'egypt',
  uae: 'uae', dfm: 'uae', adx: 'uae',
  ksa: 'ksa', saudi: 'ksa', tadawul: 'ksa',
  crypto: 'crypto', global: 'global',
};

const DEFAULT_COLUMNS = ['name', 'close', 'change', 'volume', 'market_cap_basic', 'RSI', 'EMA50', 'EMA200', 'ADX'];

function resolveMarket(market) {
  const m = String(market || 'america').trim().toLowerCase();
  return MARKET_ALIASES[m] || m;
}

function inferMarket(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.startsWith('EGX:')) return 'egypt';
  if (s.startsWith('DFM:') || s.startsWith('ADX:')) return 'uae';
  if (s.startsWith('TADAWUL:')) return 'ksa';
  if (/(BINANCE|KUCOIN|BYBIT|COINBASE):/.test(s)) return 'crypto';
  return 'america';
}

/**
 * Run a scanner query.
 * @param {object} opts
 * @param {string} [opts.market='america']  friendly market name or scanner segment
 * @param {string[]} [opts.columns]         column ids to return
 * @param {Array} [opts.filters]            scanner filter clauses ({left,operation,right})
 * @param {object} [opts.sort]              { sortBy, sortOrder }
 * @param {number[]} [opts.range=[0,50]]    [offset, limit]
 * @param {string[]} [opts.tickers]         explicit tickers (e.g. ['NASDAQ:AAPL']) — tickers mode
 * @param {object} [opts.body]              raw scanner body override (advanced; ignores the above)
 */
export async function scan({ market = 'america', columns, filters, sort, range, tickers, body } = {}) {
  const mkt = resolveMarket(market);
  const cols = Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;

  let payload;
  if (body && typeof body === 'object') {
    payload = body;
  } else if (Array.isArray(tickers) && tickers.length) {
    payload = { symbols: { tickers, query: { types: [] } }, columns: cols };
  } else {
    payload = { symbols: { query: { types: [] } }, columns: cols };
    const flt = Array.isArray(filters) ? filters : [];
    if (flt.length) payload.filter = flt;
    payload.range = Array.isArray(range) && range.length === 2 ? range : [0, 50];
    if (sort && sort.sortBy) payload.sort = { sortBy: sort.sortBy, sortOrder: sort.sortOrder || 'desc' };
  }

  const url = `https://scanner.tradingview.com/${mkt}/scan`;
  // NOTE: deliberately NO Content-Type header. Adding one triggers a CORS
  // preflight (OPTIONS) that scanner.tradingview.com rejects from the chart-page
  // origin ("Failed to fetch"). A header-less POST is a CORS "simple request"
  // and succeeds with credentials:'include' (verified 2026-06-03, HTTP 200).
  const result = await evaluateAsync(`
    fetch(${safeString(url)}, {
      method: 'POST',
      credentials: 'include',
      body: ${safeString(JSON.stringify(payload))}
    })
    .then(function(r) { return r.text(); })
    .then(function(t) {
      if (!t) return { __error: 'empty body (rate-limited or not logged in)' };
      try { return JSON.parse(t); } catch(e) { return { __error: 'non-JSON response: ' + String(t).slice(0, 160) }; }
    })
    .catch(function(e) { return { __error: e && e.message ? e.message : String(e) }; })
  `);

  if (!result || result.__error) {
    throw new Error('Scanner fetch failed: ' + (result?.__error || 'no response'));
  }

  const rawRows = Array.isArray(result.data) ? result.data : [];
  const usedCols = payload.columns || cols;
  const rows = rawRows.map((row) => {
    const obj = { ticker: row.s };
    const d = Array.isArray(row.d) ? row.d : [];
    for (let i = 0; i < usedCols.length; i++) obj[usedCols[i]] = d[i];
    return obj;
  });

  return {
    success: true,
    market: mkt,
    total: typeof result.totalCount === 'number' ? result.totalCount : rows.length,
    count: rows.length,
    columns: usedCols,
    rows,
  };
}

/**
 * Fetch a quote for ANY symbol without changing the chart — fixes quote_get's
 * symbol param by routing through the authenticated scanner (tickers mode).
 */
export async function quoteSymbol(symbol) {
  if (!symbol) throw new Error('symbol is required');
  const ticker = String(symbol).includes(':') ? symbol : symbol; // pass through; caller may prefix
  const r = await scan({
    market: inferMarket(ticker),
    tickers: [ticker],
    columns: ['name', 'close', 'open', 'high', 'low', 'volume', 'change', 'RSI', 'EMA50', 'EMA200'],
  });
  const row = r.rows[0];
  if (!row) throw new Error(`No scanner data for ${ticker} (check exchange prefix, e.g. NASDAQ:${ticker})`);
  return { success: true, source: 'scanner_authenticated', ...row };
}
