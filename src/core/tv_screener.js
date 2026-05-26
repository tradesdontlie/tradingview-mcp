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
  symbols,
}) {
  // When restricting to an index/symbol set (symbols.symbolset), do NOT also
  // pin exchange — the symbolset already scopes the universe and an extra
  // exchange equality can return zero rows for dual-listed members.
  const allFilters = [
    ...(exchange && !symbols ? [{ left: 'exchange', operation: 'equal', right: exchange }] : []),
    ...filter,
  ];

  const body = {
    columns,
    filter: allFilters,
    range,
    ...(sort ? { sort } : {}),
    ...(symbols ? { symbols } : {}),
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

// ── Gap screener ──────────────────────────────────────────────────
// Friendly index name → TV symbolset id (proname suffix after the exchange).
const INDEX_SYMBOLSET = {
  'NIFTY 50': 'NIFTY',
  'NIFTY50': 'NIFTY',
  'NIFTY 100': 'CNX100',
  'NIFTY100': 'CNX100',
  'NIFTY 200': 'CNX200',
  'NIFTY200': 'CNX200',
  'NIFTY 500': 'CNX500',
  'NIFTY500': 'CNX500',
};

const GAP_COLUMNS = [
  'name', 'description', 'open', 'close', 'gap', 'change',
  'volume', 'relative_volume_10d_calc', 'market_cap_basic',
];

// Classify a row by crossing gap sign against intraday change sign — the core
// insight: a gap is the OPEN event, change is where price is NOW.
//   up + green  = held (gap stuck / extended)
//   up + red    = faded (gap sold into — trap)
//   down + red  = sold (gap-down continued — bearish)
//   down + green = reversed (gap-down bought back — bullish flip)
function classifyGap(gap, change) {
  if (gap >= 0) return change >= 0 ? 'held' : 'faded';
  return change <= 0 ? 'sold' : 'reversed';
}

// Takes the { symbol, values } row from screenerQuery and shapes it.
function mapGapRow({ symbol, values: v }) {
  return {
    symbol,
    name: v.name,
    description: v.description,
    open: v.open,
    ltp: v.close,
    gap_pct: v.gap,
    change_pct: v.change,
    volume: v.volume,
    rel_volume: v.relative_volume_10d_calc,
    market_cap_cr: v.market_cap_basic != null ? Math.round(v.market_cap_basic / 1e7) : null,
    bucket: classifyGap(v.gap ?? 0, v.change ?? 0),
  };
}

// Dedup dual listings (NSE + BSE return the same name) — keep highest volume.
function dedupByName(rows) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || (r.volume ?? 0) > (cur.volume ?? 0)) best.set(r.name, r);
  }
  return [...best.values()];
}

/**
 * Screen for gap-up and/or gap-down stocks with market-cap and volume filters.
 *
 * @param {object} opts
 * @param {string}  [opts.screener='india']
 * @param {string}  [opts.exchange='NSE']
 * @param {'up'|'down'|'both'} [opts.direction='both']
 * @param {number}  [opts.minGapPct=0.5]      absolute gap threshold (%)
 * @param {number}  [opts.minMarketCapCr=0]   minimum market cap in crore
 * @param {number}  [opts.minRelVol=0]        minimum relative_volume_10d (1 = avg)
 * @param {string}  [opts.index]              e.g. "NIFTY 500" or a symbolset id like "CNX500"
 * @param {number}  [opts.limit=100]          rows per direction (pre-dedup)
 * @returns {Promise<{filters:object, up:object[], down:object[], counts:object}>}
 */
export async function gapScreener({
  screener = 'india',
  exchange = 'NSE',
  direction = 'both',
  minGapPct = 0.5,
  minMarketCapCr = 0,
  minRelVol = 0,
  index = null,
  limit = 100,
} = {}) {
  const mcapRupees = Number(minMarketCapCr) > 0 ? Number(minMarketCapCr) * 1e7 : 0;
  const symbolsetId = index ? (INDEX_SYMBOLSET[index] || index) : null;
  const symbols = symbolsetId ? { symbolset: [`SYML:${exchange};${symbolsetId}`] } : undefined;

  async function runDir(dir) {
    const gapFilter = dir === 'up'
      ? { left: 'gap', operation: 'greater', right: minGapPct }
      : { left: 'gap', operation: 'less', right: -minGapPct };
    const filter = [gapFilter];
    if (mcapRupees > 0) filter.push({ left: 'market_cap_basic', operation: 'greater', right: mcapRupees });
    if (Number(minRelVol) > 0) filter.push({ left: 'relative_volume_10d_calc', operation: 'egreater', right: Number(minRelVol) });

    const { rows } = await screenerQuery({
      screener,
      exchange,
      columns: GAP_COLUMNS,
      filter,
      symbols,
      sort: { sortBy: 'gap', sortOrder: dir === 'up' ? 'desc' : 'asc' },
      range: [0, limit],
    });
    return dedupByName(rows.map(mapGapRow));
  }

  const up = direction === 'down' ? [] : await runDir('up');
  const down = direction === 'up' ? [] : await runDir('down');

  return {
    filters: { screener, exchange, direction, minGapPct, minMarketCapCr, minRelVol, index: index || null, limit },
    counts: { up: up.length, down: down.length },
    up,
    down,
  };
}
