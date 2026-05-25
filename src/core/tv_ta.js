// TradingView TA endpoint client — ported from tradingview_ta Python lib pattern.
// Posts to scanner.tradingview.com/{screener}/scan with curated column list.
// No auth. No key. Public endpoint.

const TV_SCAN_BASE = 'https://scanner.tradingview.com';
const TIMEOUT_MS = 12_000;
const UA = 'tradingview-mcp/0.5.0';

// TV interval suffix mapping. Empty string = daily (default column suffix).
const INTERVAL_MAP = {
  '1m':  '|1',
  '5m':  '|5',
  '15m': '|15',
  '30m': '|30',
  '1h':  '|60',
  '2h':  '|120',
  '4h':  '|240',
  '1D':  '',
  '1d':  '',
  '1W':  '|1W',
  '1w':  '|1W',
  '1M':  '|1M',
};

// Crypto exchanges → use 'crypto' screener; stocks vary by venue.
export const EXCHANGE_SCREENER = {
  BINANCE: 'crypto', KUCOIN: 'crypto', BYBIT: 'crypto', MEXC: 'crypto',
  BITGET: 'crypto', OKX: 'crypto', COINBASE: 'crypto', GATEIO: 'crypto',
  HUOBI: 'crypto', BITFINEX: 'crypto', KRAKEN: 'crypto', BITSTAMP: 'crypto',
  NASDAQ: 'america', NYSE: 'america', AMEX: 'america',
  NSE: 'india', BSE: 'india',
  BIST: 'turkey', EGX: 'egypt',
  HKEX: 'hongkong', SSE: 'china', SZSE: 'china',
  TWSE: 'taiwan', TPEX: 'taiwan', BURSA: 'malaysia', ASX: 'australia',
};

// Curated column set covering the most-used indicators across the
// original Python service. Suffix appended per timeframe.
const BASE_COLUMNS = [
  'close', 'open', 'high', 'low', 'volume', 'change',
  'RSI', 'RSI[1]',
  'MACD.macd', 'MACD.signal',
  'BB.upper', 'BB.lower', 'BB.lower',
  'SMA10', 'SMA20', 'SMA30', 'SMA50', 'SMA100', 'SMA200',
  'EMA10', 'EMA20', 'EMA30', 'EMA50', 'EMA100', 'EMA200',
  'Stoch.K', 'Stoch.D',
  'ADX', 'ADX+DI', 'ADX-DI',
  'AO', 'CCI20', 'Mom', 'P.SAR',
  'Pivot.M.Classic.Middle', 'Pivot.M.Classic.R1', 'Pivot.M.Classic.R2',
  'Pivot.M.Classic.R3', 'Pivot.M.Classic.S1', 'Pivot.M.Classic.S2', 'Pivot.M.Classic.S3',
  'Recommend.All', 'Recommend.MA', 'Recommend.Other',
];

function withInterval(col, intervalSuffix) {
  // 'close|60' for 1h, 'close' for 1D (no suffix).
  if (!intervalSuffix) return col;
  // Some cols never get interval suffix (P.SAR etc.) — but TV is permissive
  // so let downstream None / null filter at extraction time.
  return col + intervalSuffix;
}

/**
 * Fetch raw indicator analysis for a single symbol.
 *
 * @param {object} opts
 * @param {string} opts.symbol      e.g. "BTCUSDT", "AAPL", "RELIANCE"
 * @param {string} opts.exchange    e.g. "BINANCE", "NASDAQ", "NSE"
 * @param {string} [opts.timeframe] "5m" | "15m" | "1h" | "4h" | "1D" | "1W"
 * @returns {Promise<{symbol, exchange, screener, timeframe, indicators, raw}|{symbol, error}>}
 */
export async function getAnalysis({ symbol, exchange = 'BINANCE', timeframe = '15m' }) {
  const screener = EXCHANGE_SCREENER[exchange] || 'crypto';
  const intervalSuffix = INTERVAL_MAP[timeframe] ?? '|15';
  const cols = BASE_COLUMNS.map(c => withInterval(c, intervalSuffix));

  const body = {
    symbols: { tickers: [`${exchange}:${symbol}`], query: { types: [] } },
    columns: cols,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let data;
  try {
    const r = await fetch(`${TV_SCAN_BASE}/${screener}/scan`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (err) {
    clearTimeout(timer);
    return { symbol, exchange, error: err.message };
  } finally {
    clearTimeout(timer);
  }

  const row = data?.data?.[0]?.d;
  if (!Array.isArray(row)) {
    return { symbol, exchange, error: 'no data row returned from TV scanner' };
  }

  const indicators = {};
  cols.forEach((c, i) => {
    // Use the base name (without interval suffix) as the key so downstream
    // logic can reference 'RSI' instead of 'RSI|60'.
    const base = c.split('|')[0];
    indicators[base] = row[i];
  });

  return {
    symbol,
    exchange,
    screener,
    timeframe,
    indicators,
    raw_columns: cols,
  };
}
