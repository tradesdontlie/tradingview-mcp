// Extended-hours US stock prices — ported from
// atilaahmettaner/extended_hours_service.py.
// Walks 1m candles from Yahoo Finance chart endpoint with includePrePost,
// classifies each by currentTradingPeriod boundaries.

const TIMEOUT_MS = 12_000;
const UA = 'tradingview-mcp/0.8.1';
const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

function changePct(price, reference) {
  if (price == null || reference == null || reference === 0) return null;
  return Number((((price - reference) / reference) * 100).toFixed(2));
}

function fmtTime(ts) {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export async function getExtendedHoursPrice(symbol) {
  const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let data;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (err) {
    clearTimeout(timer);
    return { symbol: symbol.toUpperCase(), error: err.message };
  } finally {
    clearTimeout(timer);
  }

  let result, meta, period, timestamps, closes;
  try {
    result = data.chart.result[0];
    meta = result.meta;
    period = meta.currentTradingPeriod;
    timestamps = result.timestamp || [];
    closes = result.indicators.quote[0].close || [];
  } catch (err) {
    return { symbol: symbol.toUpperCase(), error: `unexpected response shape: ${err.message}` };
  }

  const regularStart = period.regular.start;
  const regularEnd = period.regular.end;

  let prePrice = null;
  let preTime = null;
  let regularIntraday = null;
  let regularTime = null;
  let postPrice = null;
  let postTime = null;

  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const ts = timestamps[i];
    if (ts < regularStart) {
      prePrice = c;
      preTime = ts;
    } else if (ts <= regularEnd) {
      regularIntraday = c;
      regularTime = ts;
    } else {
      postPrice = c;
      postTime = ts;
    }
  }

  const regularClose = meta.regularMarketPrice ?? regularIntraday;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;

  const out = {
    symbol: symbol.toUpperCase(),
    currency: meta.currency || 'USD',
    exchange: meta.exchangeName,
    market_state: meta.marketState,
    previous_close: previousClose,
    pre_market: null,
    regular: null,
    post_market: null,
    source: 'Yahoo Finance',
  };

  if (prePrice != null) {
    out.pre_market = {
      price: prePrice,
      as_of_utc: fmtTime(preTime),
      change_vs_previous_close_pct: changePct(prePrice, previousClose),
    };
  }
  if (regularClose != null) {
    out.regular = {
      price: regularClose,
      as_of_utc: fmtTime(meta.regularMarketTime ?? regularTime),
      change_pct: changePct(regularClose, previousClose),
    };
  }
  if (postPrice != null) {
    out.post_market = {
      price: postPrice,
      as_of_utc: fmtTime(postTime),
      change_vs_regular_close_pct: changePct(postPrice, regularClose),
    };
  }
  return out;
}
