// TradingView screener client — ported from tradingview-screener Python lib.
// POSTs filter+sort queries directly against scanner.tradingview.com so we
// don't need pre-loaded symbol lists (unlike the coinlist-based original).

import { EXCHANGE_SCREENER } from './tv_ta.js';

const TV_SCAN_BASE = 'https://scanner.tradingview.com';
const TIMEOUT_MS = 15_000;
const UA = 'tradingview-mcp/0.5.0';

// TV interval suffix mapping reused locally so we don't depend on tv_ta exports.
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

export function intervalSuffix(timeframe) {
  return INTERVAL_MAP[timeframe] ?? '|15';
}

export function exchangeToScreener(exchange) {
  return EXCHANGE_SCREENER[exchange] || 'crypto';
}

/**
 * Run a screener query.
 *
 * @param {object} opts
 * @param {string} opts.screener   "crypto" | "america" | "india" | "egypt" | ...
 * @param {string} opts.exchange   filter equal value for column "exchange"
 * @param {string[]} opts.columns  TV column names (with interval suffix)
 * @param {Array<object>} [opts.filter]  extra filters
 * @param {{sortBy:string, sortOrder:'asc'|'desc'}} [opts.sort]
 * @param {[number, number]} [opts.range] inclusive start, exclusive end
 * @returns {Promise<{ totalCount: number, rows: Array<{symbol:string, values:object}> }>}
 */
export async function screenerQuery({
  screener,
  exchange,
  columns,
  filter = [],
  sort,
  range = [0, 100],
}) {
  const allFilters = [
    ...(exchange ? [{ left: 'exchange', operation: 'equal', right: exchange }] : []),
    ...filter,
  ];

  const body = {
    columns,
    filter: allFilters,
    range,
    ...(sort ? { sort } : {}),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
    const data = await r.json();
    const totalCount = data.totalCount ?? 0;
    const rows = (data.data || []).map(row => {
      const values = {};
      columns.forEach((c, i) => {
        const base = c.split('|')[0];
        values[base] = row.d[i];
      });
      return { symbol: row.s, values };
    });
    return { totalCount, rows };
  } finally {
    clearTimeout(timer);
  }
}

/** Curated column set for gainers/losers + base metric tools. */
export function baseColumns(timeframe) {
  const suf = intervalSuffix(timeframe);
  return [
    'name', 'close', 'open', 'high', 'low', 'volume',
    'change' + suf,
    'RSI' + suf,
    'SMA20' + suf,
    'BB.upper' + suf,
    'BB.lower' + suf,
    'EMA50' + suf,
    'average_volume_10d_calc',
    'Recommend.All' + suf,
  ];
}

export function changeKey(timeframe) {
  return 'change' + intervalSuffix(timeframe);
}
