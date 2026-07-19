/**
 * India market dashboard (hexadelta-style).
 *
 * One page showing, for a user-editable NSE watchlist:
 *   - live price / change / volume / relative volume
 *   - distance of price from the DAILY 10 & 21 EMAs
 *   - distance of price from the WEEKLY 10 / 21 / 40 EMAs
 * plus two market-wide panels: top gainers and volume shockers, each with the
 * news headline ("catalyst") behind the move.
 *
 * Data paths (no TradingView Desktop needed, no npm deps):
 *
 *   EMAs -- the scanner API only exposes fixed EMA periods (10/20/50...), not
 *     21 or 40. So daily bars come from Yahoo (5y, one request per symbol),
 *     weekly bars are resampled locally, and the EMA is computed here. What is
 *     cached per period is the EMA up to the PREVIOUS bar; the final step is
 *     applied at quote time with the live price, so the distance always agrees
 *     with the price on screen (same thing TradingView does intraday).
 *
 *   Live quotes + market movers -- TradingView's public India scanner API,
 *     one batched request per poll for the watchlist, one filtered+sorted
 *     scan per minute for gainers / volume shockers.
 *
 *   Catalysts -- Google News RSS search per company, cached 15 minutes.
 *
 * Run:  node dashboard/server.mjs
 * Open: http://localhost:8790
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASH_PORT) || 8790;
const SCAN_ENDPOINT = 'https://scanner.tradingview.com/india/scan';
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart';
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
const EMA_CACHE_FILE = path.join(__dirname, 'ema-cache.json');

const QUOTE_MS = 15000;          // watchlist quote poll
const MOVERS_MS = 60000;         // market-wide gainers / volume scan
const WEEKLY_MS = 5 * 60 * 1000; // 7-day movers scan
const EMA_REFRESH_MS = 30 * 60 * 1000;  // re-derive EMA base from Yahoo bars
const NEWS_TTL_MS = 15 * 60 * 1000;
const CATALYST_COUNT = 8;        // auto-fetch news for this many top gainers

const INDICES = ['NSE:NIFTY', 'NSE:BANKNIFTY'];
const EMA_DEFS = [
  { key: 'd10', tf: 'daily', n: 10 },
  { key: 'd21', tf: 'daily', n: 21 },
  { key: 'w10', tf: 'weekly', n: 10 },
  { key: 'w21', tf: 'weekly', n: 21 },
  { key: 'w40', tf: 'weekly', n: 40 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIST = () => new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false });
function loadJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
const saveJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));

let watchlist = loadJson(WATCHLIST_FILE, []);
let emaCache = loadJson(EMA_CACHE_FILE, {});   // sym -> { d10:{prev,n}, ..., at }

const clients = new Set();
let watchRows = [];
let indexRows = [];
let gainers = [];
let losers = [];
let volumeShockers = [];
let gainers7 = [];
let losers7 = [];
let volumeBuildup = [];
let breadth = null;   // { adv, dec }
let eps = [];         // episodic pivots
let sectors = [];     // sector heatmap tiles
let lastPoll = null;
let lastError = null;
let emaState = { active: false, done: 0, total: 0 };

function broadcast(o) {
  const msg = `data: ${JSON.stringify(o)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------------- EMA base (Yahoo daily bars, resampled) ----------------

// NSE:POLYCAB -> POLYCAB.NS
const yahooSymbol = tv => tv.split(':').pop() + '.NS';

async function fetchDailyCloses(tvSymbol) {
  const url = `${YF}/${yahooSymbol(tvSymbol)}?interval=1d&range=5y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(j.chart?.error?.description || 'no data');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), close: q.close[i] });
  }
  return bars;
}

// last close of each Monday-anchored week, ascending
function weeklyCloses(bars) {
  const weeks = [];
  let curKey = null;
  for (const b of bars) {
    const d = new Date(b.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d.toISOString().slice(0, 10);
    if (key !== curKey) { weeks.push(b.close); curKey = key; }
    else weeks[weeks.length - 1] = b.close;
  }
  return weeks;
}

// EMA over the whole series (SMA seed), or null if too short
function emaLast(closes, n) {
  if (closes.length < n) return null;
  let e = 0;
  for (let i = 0; i < n; i++) e += closes[i];
  e /= n;
  const k = 2 / (n + 1);
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

// The cached value is the EMA up to the bar BEFORE the latest one; the latest
// bar is stood in for by the live price at quote time.
async function computeEmaBase(sym) {
  const daily = await fetchDailyCloses(sym);
  const weekly = weeklyCloses(daily);
  const dPrev = daily.slice(0, -1).map(b => b.close);
  const wPrev = weekly.slice(0, -1);
  const out = { at: new Date().toISOString() };
  for (const { key, tf, n } of EMA_DEFS) {
    out[key] = { prev: emaLast(tf === 'daily' ? dPrev : wPrev, n), n };
  }
  return out;
}

async function refreshEmas(symbols = watchlist, force = false) {
  const todo = symbols.filter(s => force || !emaCache[s] ||
    Date.now() - new Date(emaCache[s].at).getTime() > EMA_REFRESH_MS);
  if (!todo.length || emaState.active) return;
  emaState = { active: true, done: 0, total: todo.length };
  broadcast({ type: 'ema', ...emaState });
  try {
    for (const sym of todo) {
      try {
        emaCache[sym] = await computeEmaBase(sym);
      } catch (e) {
        console.log(`[EMA] ${sym} failed: ${e.message}`);
      }
      emaState.done++;
      broadcast({ type: 'ema', ...emaState });
      await sleep(200);   // be polite to Yahoo
    }
    saveJson(EMA_CACHE_FILE, emaCache);
  } finally {
    emaState = { active: false, done: 0, total: 0 };
    broadcast({ type: 'ema', ...emaState });
  }
}

// final EMA step with the live price standing in for the current bar
function emaVal(entry, live) {
  if (!entry || entry.prev == null || live == null) return null;
  const k = 2 / (entry.n + 1);
  return entry.prev * (1 - k) + live * k;
}
function liveDist(entry, live) {
  const e = emaVal(entry, live);
  return e == null ? null : ((live - e) / e) * 100;
}

// ---------------- live quotes (scanner API) ----------------

const QUOTE_COLUMNS = ['close', 'change', 'volume', 'relative_volume_10d_calc', 'description', 'market_cap_basic',
  'price_52_week_high', 'earnings_release_next_date'];

// Qullamaggie-style read on the EMA distances:
//   pullback -- weekly uptrend intact (price above W10/21/40) and price has come
//               back into the daily 10/21 EMA zone: the buyable dip.
//   trend    -- price above all five EMAs and not currently tagging the dailies.
function classifySetup(r) {
  const { d10, d21, w10, w21, w40 } = r;
  if ([d10, d21, w10, w21, w40].some(v => v == null)) return null;
  const weeklyUp = w10 > 0 && w21 > 0 && w40 > 0;
  if (!weeklyUp) return null;
  if (Math.min(d10, d21) <= 0.5) return 'pullback';
  if (d10 > 0 && d21 > 0) return 'trend';
  return null;
}

async function scan(body) {
  const res = await fetch(SCAN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scanner API HTTP ${res.status}`);
  return res.json();
}

async function pollQuotes() {
  try {
    const tickers = [...INDICES, ...watchlist];
    if (!tickers.length) return;
    const j = await scan({ symbols: { tickers }, columns: QUOTE_COLUMNS });
    const quotes = new Map();
    for (const r of j.data || []) {
      const [close, chg, volume, rvol, description, mcap, high52, nextEarn] = r.d;
      quotes.set(r.s, { close, chg, volume, rvol, description, mcap, high52, nextEarn });
    }
    indexRows = INDICES.map(sym => {
      const q = quotes.get(sym);
      return q ? { symbol: sym, name: sym.split(':').pop(), price: q.close, chg: q.chg } : null;
    }).filter(Boolean);

    watchRows = watchlist.map(sym => {
      const q = quotes.get(sym);
      if (!q) return { symbol: sym, name: sym.split(':').pop(), missing: true };
      const e = emaCache[sym] || {};
      const row = {
        symbol: sym, name: sym.split(':').pop(), description: q.description,
        price: q.close, chg: q.chg, volume: q.volume, rvol: q.rvol, mcap: q.mcap,
        off52: q.high52 ? ((q.close / q.high52) - 1) * 100 : null,
      };
      if (q.nextEarn) {
        const days = Math.ceil((q.nextEarn * 1000 - Date.now()) / 86400000);
        if (days >= 0 && days <= 14) {
          row.earnDays = days;
          row.earnDate = new Date(q.nextEarn * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
        }
      }
      for (const { key } of EMA_DEFS) row[key] = liveDist(e[key], q.close);
      row.setup = classifySetup(row);
      // Weinstein Stage 2: weekly EMAs stacked upward and price on top of them
      const ew10 = emaVal(e.w10, q.close), ew21 = emaVal(e.w21, q.close), ew40 = emaVal(e.w40, q.close);
      row.stage2 = ew10 != null && ew21 != null && ew40 != null &&
        q.close > ew10 && ew10 > ew21 && ew21 > ew40;
      // exit rule: price closed below the weekly 21 EMA
      row.exit = ew21 != null && q.close < ew21;
      return row;
    });

    lastPoll = new Date().toISOString();
    lastError = null;
    broadcast({ type: 'rows', watchRows, indexRows, lastPoll });
  } catch (e) {
    lastError = e.message;
    broadcast({ type: 'error', error: e.message });
  }
}

// ---------------- market movers (gainers / volume shockers) ----------------

const MOVER_FILTER = [
  { left: 'exchange', operation: 'equal', right: 'NSE' },
  { left: 'type', operation: 'equal', right: 'stock' },
  { left: 'is_primary', operation: 'equal', right: true },
  { left: 'market_cap_basic', operation: 'egreater', right: 5e9 },   // >= ~500 Cr
  { left: 'close', operation: 'egreater', right: 20 },               // skip penny stocks
  { left: 'volume', operation: 'egreater', right: 100000 },
];
const MOVER_COLUMNS = ['name', 'description', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'market_cap_basic', 'sector'];

function moverRows(j) {
  return (j.data || []).map(r => {
    const [name, description, close, chg, volume, rvol, mcap, sector] = r.d;
    return { symbol: r.s, name, description, price: close, chg, volume, rvol, mcap, sector };
  });
}

const SCAN_BASE = {
  options: { lang: 'en' },
  markets: ['india'],
  symbols: { query: { types: [] }, tickers: [] },
};
// breadth counts the whole NSE main board, not just the mover universe
const BREADTH_FILTER = MOVER_FILTER.slice(0, 3);

// Episodic Pivot: big one-day move on multiples of normal volume — the kind of
// gap that starts multi-week moves. Gap% and distance to 52w high shown so a
// bottomed-out reversal EP is distinguishable from a breakout EP.
const EP_FILTER = [
  ...MOVER_FILTER,
  { left: 'change', operation: 'egreater', right: 4 },
  { left: 'relative_volume_10d_calc', operation: 'egreater', right: 3 },
];
const EP_COLUMNS = [...MOVER_COLUMNS, 'gap', 'price_52_week_high'];

async function pollMovers() {
  try {
    const base = { ...SCAN_BASE, filter: MOVER_FILTER, columns: MOVER_COLUMNS, range: [0, 15] };
    const count = { ...SCAN_BASE, columns: ['name'], range: [0, 1] };
    const [g, l, v, ep, adv, dec] = await Promise.all([
      scan({ ...base, sort: { sortBy: 'change', sortOrder: 'desc' } }),
      scan({ ...base, sort: { sortBy: 'change', sortOrder: 'asc' } }),
      scan({ ...base, sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' } }),
      scan({ ...SCAN_BASE, filter: EP_FILTER, columns: EP_COLUMNS, sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }, range: [0, 15] }),
      scan({ ...count, filter: [...BREADTH_FILTER, { left: 'change', operation: 'greater', right: 0 }] }),
      scan({ ...count, filter: [...BREADTH_FILTER, { left: 'change', operation: 'less', right: 0 }] }),
    ]);
    gainers = moverRows(g);
    losers = moverRows(l);
    volumeShockers = moverRows(v);
    eps = (ep.data || []).map(r => {
      const [name, description, close, chg, volume, rvol, mcap, sector, gap, high52] = r.d;
      return {
        symbol: r.s, name, description, price: close, chg, volume, rvol, mcap, sector, gap,
        off52: high52 ? ((close / high52) - 1) * 100 : null,
      };
    });
    breadth = { adv: adv.totalCount ?? null, dec: dec.totalCount ?? null };
    broadcast({ type: 'movers', gainers, losers, volumeShockers, eps, breadth });
    attachCatalysts();   // async, re-broadcasts when headlines arrive
  } catch (e) {
    lastError = e.message;
    broadcast({ type: 'error', error: e.message });
  }
}

// ---------------- sector heatmap ----------------
// The scanner API can't quote most NSE sector indices, so the heatmap is
// aggregated from constituents: mcap-weighted change per TradingView sector
// over the whole liquid universe.
const SECTOR_SHORT = {
  'Technology Services': 'IT Services', 'Electronic Technology': 'Tech Hardware',
  'Health Technology': 'Pharma', 'Health Services': 'Healthcare',
  'Consumer Non-Durables': 'FMCG', 'Consumer Durables': 'Durables',
  'Non-Energy Minerals': 'Metals', 'Energy Minerals': 'Energy',
  'Producer Manufacturing': 'Manufacturing', 'Process Industries': 'Chemicals',
  'Industrial Services': 'Industrials', 'Commercial Services': 'Services',
  'Distribution Services': 'Distribution', 'Consumer Services': 'Consumer Svcs',
  'Retail Trade': 'Retail', 'Communications': 'Telecom',
};

async function pollSectors() {
  try {
    const j = await scan({
      ...SCAN_BASE, filter: MOVER_FILTER,
      columns: ['sector', 'change', 'market_cap_basic'],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, range: [0, 1500],
    });
    const agg = new Map();
    for (const r of j.data || []) {
      const [sector, chg, mcap] = r.d;
      if (!sector || chg == null || !mcap) continue;
      const a = agg.get(sector) || { w: 0, sum: 0, n: 0, adv: 0 };
      a.w += mcap; a.sum += chg * mcap; a.n++; if (chg > 0) a.adv++;
      agg.set(sector, a);
    }
    sectors = [...agg.entries()]
      .filter(([, a]) => a.n >= 3)
      .map(([sector, a]) => ({ sector, short: SECTOR_SHORT[sector] || sector, chg: a.sum / a.w, n: a.n, adv: a.adv }))
      .sort((a, b) => b.chg - a.chg);
    broadcast({ type: 'sectors', sectors });
  } catch (e) {
    lastError = e.message;
    broadcast({ type: 'error', error: e.message });
  }
}

// ---------------- 7-day movers ----------------

async function pollWeekly() {
  try {
    const base = { ...SCAN_BASE, filter: MOVER_FILTER, columns: [...MOVER_COLUMNS, 'Perf.W'], range: [0, 15] };
    const rows7 = j => (j.data || []).map(r => {
      const [name, description, close, chg, volume, rvol, mcap, sector, perfW] = r.d;
      return { symbol: r.s, name, description, price: close, chg, volume, rvol, mcap, sector, perfW };
    });
    const [g, l, vb] = await Promise.all([
      scan({ ...base, sort: { sortBy: 'Perf.W', sortOrder: 'desc' } }),
      scan({ ...base, sort: { sortBy: 'Perf.W', sortOrder: 'asc' } }),
      // volume buildup: 10-day avg volume vs 90-day avg — sustained interest,
      // not a one-day spike. Ratio isn't a sortable server column, so pull a
      // wide liquid slice and rank locally.
      scan({
        ...SCAN_BASE, filter: MOVER_FILTER,
        columns: ['name', 'description', 'close', 'change', 'Perf.W', 'average_volume_10d_calc', 'average_volume_90d_calc'],
        sort: { sortBy: 'average_volume_10d_calc', sortOrder: 'desc' }, range: [0, 600],
      }),
    ]);
    gainers7 = rows7(g);
    losers7 = rows7(l);
    volumeBuildup = (vb.data || []).map(r => {
      const [name, description, close, chg, perfW, a10, a90] = r.d;
      return {
        symbol: r.s, name, description, price: close, chg, perfW,
        a10, ratio: a90 > 50000 ? a10 / a90 : null,
      };
    }).filter(r => r.ratio != null).sort((a, b) => b.ratio - a.ratio).slice(0, 15);
    broadcast({ type: 'weekly', gainers7, losers7, volumeBuildup });
  } catch (e) {
    lastError = e.message;
    broadcast({ type: 'error', error: e.message });
  }
}

// ---------------- catalysts (Google News RSS) ----------------

const newsCache = new Map();   // query -> { at, items }

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

async function fetchNews(companyName) {
  const cached = newsCache.get(companyName);
  if (cached && Date.now() - cached.at < NEWS_TTL_MS) return cached.items;
  const q = encodeURIComponent(`"${companyName}" (stock OR shares OR NSE)`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`news HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = tag => {
      const t = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return t ? decodeEntities(t[1]).trim() : null;
    };
    let title = pick('title');
    const source = pick('source');
    // Google appends " - Source" to titles; strip it since source is separate
    if (title && source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    // publisher-name variants slip through the exact match — strip a trailing
    // " - X" segment too, as long as a real headline remains
    if (title) {
      const bare = title.replace(/\s+-\s+[^-]{2,40}$/, '').trim();
      if (bare.length >= 15) title = bare;
    }
    if (!title || title.length < 10 || /^[-–—]/.test(title)) continue;
    items.push({ title, link: pick('link'), source, pubDate: pick('pubDate') });
    if (items.length >= 6) break;
  }
  newsCache.set(companyName, { at: Date.now(), items });
  return items;
}

// company name minus the boilerplate suffixes, for a tighter news query
const newsQueryName = d => (d || '').replace(/\s+(LIMITED|LTD\.?|INDIA)\s*$/i, '').trim();

// prefer an actual news story over generic "share price live" tracker pages
function pickCatalyst(items) {
  const generic = /share price|stock price|live updates|price today/i;
  return items.find(i => i.title && !generic.test(i.title)) || items[0] || null;
}

async function attachCatalysts() {
  let changed = false;
  for (const row of [...eps.slice(0, CATALYST_COUNT), ...gainers.slice(0, CATALYST_COUNT), ...losers.slice(0, CATALYST_COUNT)]) {
    if (row.catalyst !== undefined) continue;
    try {
      row.catalyst = pickCatalyst(await fetchNews(newsQueryName(row.description)));
      changed = true;
    } catch (e) {
      console.log(`[NEWS] ${row.name} failed: ${e.message}`);
      row.catalyst = null;
    }
    await sleep(150);
  }
  if (changed) broadcast({ type: 'movers', gainers, losers, volumeShockers, eps, breadth });
}

// ---------------- Chartink dashboard scanners ----------------
// Pulls the scanner widgets off a public Chartink dashboard, runs each scan
// through chartink.com/screener/process (public CSRF flow, no login), and
// aggregates the results: a stock hit by MULTIPLE scanners at once is the
// "high potential" confluence read.
const CHARTINK_URL = process.env.CHARTINK_DASHBOARD || 'https://chartink.com/dashboard/328813';
const CHARTINK_MS = 5 * 60 * 1000;
let chartink = { title: null, scanners: [], stocks: [], at: null, error: null };
let ckWidgets = null;
let ckWidgetsAt = 0;
let ckSession = null;

const decodeHtml = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function chartinkWidgets() {
  if (ckWidgets && Date.now() - ckWidgetsAt < 60 * 60 * 1000) return ckWidgets;
  const html = await fetch(CHARTINK_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
  const m = html.match(/widgets="([\s\S]*?)"\s/);
  if (!m) throw new Error('no scanner widgets found on Chartink dashboard (is it public?)');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  const widgets = JSON.parse(decodeHtml(m[1])).map(w => {
    const wm = (w.query || '').match(/WHERE\s*([\s\S]*?)\s*(GROUP BY|ORDER BY|$)/i);
    return { id: w.id, name: w.name, clause: wm ? wm[1].trim() : null };
  }).filter(w => w.clause);
  ckWidgets = { title: (title || 'Chartink').trim(), widgets };
  ckWidgetsAt = Date.now();
  return ckWidgets;
}

async function chartinkSession(force = false) {
  if (ckSession && !force) return ckSession;
  const r = await fetch('https://chartink.com/screener/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await r.text();
  const csrf = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  const cookies = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!csrf) throw new Error('no Chartink CSRF token');
  ckSession = { csrf, cookies };
  return ckSession;
}

async function chartinkScan(clause, retry = true) {
  const s = await chartinkSession();
  const r = await fetch('https://chartink.com/screener/process', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0', 'X-CSRF-TOKEN': s.csrf, Cookie: s.cookies,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: 'https://chartink.com/screener/',
    },
    body: 'scan_clause=' + encodeURIComponent(clause),
  });
  if ((r.status === 419 || r.status === 403) && retry) {
    ckSession = null;
    return chartinkScan(clause, false);
  }
  if (!r.ok) throw new Error(`Chartink HTTP ${r.status}`);
  return (await r.json()).data || [];
}

async function pollChartink() {
  try {
    const { title, widgets } = await chartinkWidgets();
    const stocks = new Map();
    const scanners = [];
    for (const w of widgets) {
      let rows = [];
      try {
        rows = await chartinkScan(w.clause);
      } catch (e) {
        console.log(`[CHARTINK] ${w.name} failed: ${e.message}`);
      }
      scanners.push({ id: w.id, name: w.name, count: rows.length });
      for (const r of rows) {
        const s = stocks.get(r.nsecode) || {
          symbol: 'NSE:' + r.nsecode, name: r.nsecode, description: r.name, scanners: [],
        };
        s.scanners.push(w.name);
        s.price = r.close; s.chg = r.per_chg; s.volume = r.volume;
        stocks.set(r.nsecode, s);
      }
      await sleep(1200);   // be polite to Chartink
    }
    chartink = {
      title, scanners,
      stocks: [...stocks.values()]
        .sort((a, b) => b.scanners.length - a.scanners.length || b.chg - a.chg)
        .slice(0, 40),
      at: new Date().toISOString(), error: null,
    };
    broadcast({ type: 'chartink', chartink });
    attachChartinkCatalysts();
  } catch (e) {
    chartink = { ...chartink, error: e.message, at: new Date().toISOString() };
    broadcast({ type: 'chartink', chartink });
  }
}

async function attachChartinkCatalysts() {
  let changed = false;
  for (const s of chartink.stocks.slice(0, CATALYST_COUNT)) {
    if (s.catalyst !== undefined) continue;
    try {
      s.catalyst = pickCatalyst(await fetchNews(newsQueryName(s.description)));
      changed = true;
    } catch {
      s.catalyst = null;
    }
    await sleep(150);
  }
  if (changed) broadcast({ type: 'chartink', chartink });
}

// ---------------- chart hand-off (CDP -> TradingView Desktop) ----------------
// Same mechanism as the MCP server in this repo (src/connection.js), but over
// Node's built-in WebSocket so the dashboard stays dependency-free.
const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;

async function cdpEvaluate(expression) {
  let list;
  try {
    list = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`).then(r => r.json());
  } catch {
    throw new Error(`TradingView Desktop not reachable on port ${CDP_PORT} — launch it with CDP enabled (tv_launch)`);
  }
  const target = list.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || list.find(t => t.type === 'page' && /tradingview/i.test(t.url));
  if (!target) throw new Error('No TradingView chart tab found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP websocket connection failed'));
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 8000);
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id !== 1) return;
        clearTimeout(timer);
        if (m.error) return reject(new Error(m.error.message));
        const ex = m.result?.exceptionDetails;
        if (ex) return reject(new Error(ex.exception?.description || ex.text || 'evaluation error'));
        resolve(m.result?.result?.value);
      };
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

function chartOpen(symbol) {
  return cdpEvaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${JSON.stringify(String(symbol))}, {});
        setTimeout(function() { resolve(chart.symbol()); }, 600);
      });
    })()
  `);
}

// ---------------- multi-horizon gainers (+20% over 1d / 1w / 15d) ----------------

const GAIN_MS = 5 * 60 * 1000;
const CAND_MS = 60 * 60 * 1000;
let gainers1d = [], gainersW = [], gainers15 = [], ep15 = [];
const candBars = new Map();   // sym -> { at, bars }

const gainRows = j => (j.data || []).map(r => {
  const [name, description, close, chg, volume, rvol, mcap, sector, perfW] = r.d;
  return { symbol: r.s, name, description, price: close, chg, volume, rvol, mcap, sector, perfW };
});

async function pollGainers() {
  try {
    const cols = [...MOVER_COLUMNS, 'Perf.W'];
    const mk = (extra, sortBy) => scan({
      ...SCAN_BASE, filter: [...MOVER_FILTER, extra], columns: cols,
      sort: { sortBy, sortOrder: 'desc' }, range: [0, 50],
    });
    const [d, w] = await Promise.all([
      mk({ left: 'change', operation: 'egreater', right: 20 }, 'change'),
      mk({ left: 'Perf.W', operation: 'egreater', right: 20 }, 'Perf.W'),
    ]);
    gainers1d = gainRows(d);
    gainersW = gainRows(w);
    broadcast({ type: 'gain', gainers1d, gainersW, gainers15, ep15 });
  } catch (e) {
    lastError = e.message;
    broadcast({ type: 'error', error: e.message });
  }
}

// 15-day numbers aren't a scanner column, so they're computed from Yahoo daily
// bars over a candidate pool (top 200 by 1-month performance). The same bars
// feed the 15-day episodic-pivot history below.
async function fetchCandBars(sym) {
  const url = `${YF}/${yahooSymbol(sym)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error('no data');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      close: q.close[i], high: q.high[i] ?? q.close[i], low: q.low[i] ?? q.close[i], volume: q.volume[i] || 0,
    });
  }
  return bars;
}

async function getBarsCached(sym) {
  let cb = candBars.get(sym);
  if (!cb || Date.now() - cb.at > CAND_MS) {
    cb = { at: Date.now(), bars: await fetchCandBars(sym) };
    candBars.set(sym, cb);
    await sleep(140);   // be polite to Yahoo
  }
  return cb.bars;
}

function analyze15(bars) {
  if (!bars || bars.length < 20) return null;
  const n = bars.length;
  const chg15 = n > 15 ? ((bars[n - 1].close / bars[n - 16].close) - 1) * 100 : null;
  // most recent EP day inside the last 15 sessions: +4% on 3x the 10-day avg volume
  let ep = null;
  for (let i = Math.max(11, n - 15); i < n; i++) {
    const dchg = ((bars[i].close / bars[i - 1].close) - 1) * 100;
    const win = bars.slice(i - 10, i);
    const avg = win.reduce((s, b) => s + b.volume, 0) / win.length;
    if (dchg >= 4 && avg > 0 && bars[i].volume >= 3 * avg) {
      ep = { date: bars[i].date, chg: dchg, volx: bars[i].volume / avg, close: bars[i].close };
    }
  }
  return { chg15, ep, sinceEp: ep ? ((bars[n - 1].close / ep.close) - 1) * 100 : null };
}

// "IV pause": a stock that ran 20%+ in a week / 15d / month and is now
// consolidating tight on the daily 10/20/50 EMA — the resting phase before a
// possible continuation.
function detectPause(bars) {
  if (!bars || bars.length < 60) return null;
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const last = closes[n - 1];
  const run = k => {
    if (n <= k) return null;
    const start = closes[n - 1 - k];
    return ((Math.max(...closes.slice(n - 1 - k)) / start) - 1) * 100;
  };
  const runs = [['1w', run(5)], ['15d', run(15)], ['1m', run(21)]].filter(([, v]) => v != null && v >= 20);
  if (!runs.length) return null;
  const best = runs.sort((a, b) => b[1] - a[1])[0];
  const e10 = emaLast(closes, 10), e20 = emaLast(closes, 20), e50 = emaLast(closes, 50);
  const near = [['10 EMA', e10], ['20 EMA', e20], ['50 EMA', e50]]
    .map(([lbl, e]) => [lbl, e == null ? null : ((last - e) / e) * 100])
    .filter(([, d]) => d != null && Math.abs(d) <= 3)
    .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
  if (!near) return null;
  const w5 = closes.slice(-5);
  const range5 = ((Math.max(...w5) - Math.min(...w5)) / Math.min(...w5)) * 100;
  if (range5 > 8) return null;                       // not consolidating
  if (e50 != null && last < e50 * 0.97) return null; // broken down, not pausing
  return { runup: best[1], runWindow: best[0], nearEma: near[0], emaDist: near[1], range5 };
}

// recent listing = Yahoo history starts inside the last ~6 months
function detectRecentListing(bars) {
  if (!bars || !bars.length) return null;
  const first = bars[0].date;
  if (new Date(first) < new Date(Date.now() - 190 * 86400000)) return null;
  const closes = bars.map(b => b.close);
  const last = closes[closes.length - 1];
  const hi = Math.max(...closes);
  return { listedOn: first, offHigh: ((last / hi) - 1) * 100 };
}

let ivPause = [], ipos = [];
let candRunning = false;
async function refreshCandidates() {
  if (candRunning) return;
  candRunning = true;
  try {
    const j = await scan({
      ...SCAN_BASE, filter: [...MOVER_FILTER, { left: 'Perf.1M', operation: 'egreater', right: 8 }],
      columns: MOVER_COLUMNS, sort: { sortBy: 'Perf.1M', sortOrder: 'desc' }, range: [0, 200],
    });
    const cands = moverRows(j);
    const g15 = [], e15 = [], pauses = [], listings = [];
    for (const c of cands) {
      let bars;
      try {
        bars = await getBarsCached(c.symbol);
      } catch { continue; }
      const a = analyze15(bars);
      if (a) {
        if (a.chg15 != null && a.chg15 >= 20) g15.push({ ...c, chg15: a.chg15 });
        if (a.ep) e15.push({ ...c, epDate: a.ep.date, epChg: a.ep.chg, epVolx: a.ep.volx, sinceEp: a.sinceEp });
      }
      const p = detectPause(bars);
      if (p) pauses.push({ ...c, ...p });
      const l = detectRecentListing(bars);
      if (l) listings.push({ ...c, ...l, chg15: a?.chg15 ?? null });
    }
    gainers15 = g15.sort((a, b) => b.chg15 - a.chg15).slice(0, 50);
    ep15 = e15.sort((a, b) => b.epDate.localeCompare(a.epDate) || b.epVolx - a.epVolx).slice(0, 50);
    ivPause = pauses.sort((a, b) => b.runup - a.runup).slice(0, 30);
    ipos = listings.sort((a, b) => b.listedOn.localeCompare(a.listedOn)).slice(0, 30);
    const payload = () => ({ type: 'gain', gainers1d, gainersW, gainers15, ep15, ivPause, ipos });
    broadcast(payload());
    let changed = false;
    for (const s of ep15.slice(0, CATALYST_COUNT)) {
      if (s.catalyst !== undefined) continue;
      try {
        s.catalyst = pickCatalyst(await fetchNews(newsQueryName(s.description)));
        changed = true;
      } catch { s.catalyst = null; }
      await sleep(150);
    }
    if (changed) broadcast(payload());
  } catch (e) {
    lastError = e.message;
  } finally {
    candRunning = false;
  }
}

// ---------------- F&O open-interest spurts (NSE) ----------------

const OI_MS = 5 * 60 * 1000;
let oi = { rows: [], at: null, error: null };
const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// NSE ticker -> TradingView ticker (M&M -> M_M, BAJAJ-AUTO -> BAJAJ_AUTO)
const nseToTv = s => 'NSE:' + s.replace(/[&-]/g, '_');

async function pollOI() {
  try {
    const home = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': NSE_UA, Accept: 'text/html' } }).catch(() => null);
    const cookies = home ? (home.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ') : '';
    const r = await fetch('https://www.nseindia.com/api/live-analysis-oi-spurts-underlyings', {
      headers: {
        'User-Agent': NSE_UA, Accept: 'application/json',
        Referer: 'https://www.nseindia.com/market-data/oi-spurts', Cookie: cookies,
      },
    });
    if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
    const j = await r.json();
    let rows = (j.data || []).map(d => ({
      symbol: nseToTv(d.symbol), name: d.symbol,
      oi: d.latestOI, oiChg: d.avgInOI, volume: d.volume, futValue: d.futValue, price: d.underlyingValue,
    }));
    fnoUniverse = rows.map(r => r.symbol);   // full F&O underlying list for the pivot scan
    rows.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg));
    rows = rows.slice(0, 40);
    try {
      const q = await scan({ symbols: { tickers: rows.map(x => x.symbol) }, columns: ['change', 'description'] });
      const map = new Map((q.data || []).map(x => [x.s, x.d]));
      for (const row of rows) {
        const d = map.get(row.symbol);
        if (d) { row.chg = d[0]; row.description = d[1]; }
      }
    } catch { /* classification degrades gracefully without price change */ }
    for (const row of rows) {
      row.buildup = row.chg == null ? null
        : row.oiChg >= 0
          ? (row.chg >= 0 ? 'long buildup' : 'short buildup')
          : (row.chg >= 0 ? 'short covering' : 'long unwinding');
    }
    oi = { rows, at: new Date().toISOString(), error: null };
    broadcast({ type: 'oi', oi });
  } catch (e) {
    oi = { ...oi, error: e.message };
    broadcast({ type: 'oi', oi });
  }
}

// ---------------- unusual options activity (NSE most-active stock options) ----------------
// The strike-by-strike option-chain API is bot-gated, so UOA uses NSE's
// most-active stock options feed: the contracts the market is piling into,
// with premium %change and OI, joined with the underlying's catalyst.

let uoa = { rows: [], at: null, error: null };

async function pollUOA() {
  try {
    const r = await fetch('https://www.nseindia.com/api/liveEquity-derivatives?index=stock_opt', {
      headers: { 'User-Agent': NSE_UA, Accept: '*/*', Referer: 'https://www.nseindia.com/market-data/equity-derivatives-watch' },
    });
    if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
    const j = await r.json();
    const rows = (j.data || []).map(d => ({
      symbol: nseToTv(d.underlying), name: d.underlying,
      strike: d.strikePrice, side: d.optionType, expiry: d.expiryDate,
      ltp: d.lastPrice, premChg: d.pChange, volume: d.volume, oi: d.openInterest,
      value: d.value, spot: d.underlyingValue,
    }));
    try {
      const q = await scan({ symbols: { tickers: [...new Set(rows.map(x => x.symbol))] }, columns: ['description', 'change'] });
      const map = new Map((q.data || []).map(x => [x.s, x.d]));
      for (const row of rows) {
        const d = map.get(row.symbol);
        if (d) { row.description = d[0]; row.chg = d[1]; }
      }
    } catch { /* names/chg optional */ }
    uoa = { rows, at: new Date().toISOString(), error: null };
    broadcast({ type: 'uoa', uoa });
    const seen = new Set();
    let changed = false;
    for (const row of rows) {
      if (seen.size >= CATALYST_COUNT) break;
      if (seen.has(row.symbol) || row.catalyst !== undefined) continue;
      seen.add(row.symbol);
      try {
        row.catalyst = pickCatalyst(await fetchNews(newsQueryName(row.description || row.name)));
        changed = true;
      } catch { row.catalyst = null; }
      await sleep(150);
    }
    if (changed) broadcast({ type: 'uoa', uoa });
  } catch (e) {
    uoa = { ...uoa, error: e.message };
    broadcast({ type: 'uoa', uoa });
  }
}

// ---------------- weekly Fibonacci R1 crossers (F&O universe) ----------------
// Weekly Fib pivots off the previous week's H/L/C: P = (H+L+C)/3,
// R1 = P + 0.382*(H-L), R2 = P + 0.618*(H-L). Reports F&O stocks whose daily
// close crossed above R1 within the last 7 sessions and still holds above it.

const PIVOT_MS = 30 * 60 * 1000;
let fnoUniverse = [];
let r1Crossers = [];
let pivotRunning = false;

function weekKeyOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function detectR1Cross(bars) {
  if (!bars || bars.length < 15) return null;
  const weeks = [];
  for (const b of bars) {
    const k = weekKeyOf(b.date);
    const w = weeks[weeks.length - 1];
    if (!w || w.key !== k) weeks.push({ key: k, high: b.high, low: b.low, close: b.close });
    else { w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; }
  }
  const fib = key => {
    const i = weeks.findIndex(w => w.key === key);
    if (i <= 0) return null;
    const p = weeks[i - 1];
    const P = (p.high + p.low + p.close) / 3, range = p.high - p.low;
    return { r1: P + 0.382 * range, r2: P + 0.618 * range };
  };
  const n = bars.length;
  let cross = null;
  for (let i = Math.max(1, n - 7); i < n; i++) {
    const pv = fib(weekKeyOf(bars[i].date));
    if (pv && bars[i - 1].close < pv.r1 && bars[i].close >= pv.r1) {
      cross = { crossDate: bars[i].date, crossClose: bars[i].close };
    }
  }
  if (!cross) return null;
  const last = bars[n - 1].close;
  const now = fib(weekKeyOf(bars[n - 1].date));
  if (!now || last < now.r1) return null;   // gave the level back
  return { crossDate: cross.crossDate, r1: now.r1, r2: now.r2, price: last, aboveR1: ((last - now.r1) / now.r1) * 100 };
}

async function pollPivots() {
  if (!fnoUniverse.length || pivotRunning) return;
  pivotRunning = true;
  try {
    const out = [];
    for (const sym of fnoUniverse) {
      let bars;
      try {
        bars = await getBarsCached(sym);
      } catch { continue; }
      const r = detectR1Cross(bars);
      if (r) out.push({ symbol: sym, name: sym.slice(4), ...r });
    }
    try {
      const q = await scan({ symbols: { tickers: out.map(o => o.symbol) }, columns: ['description', 'change'] });
      const map = new Map((q.data || []).map(x => [x.s, x.d]));
      for (const o of out) {
        const d = map.get(o.symbol);
        if (d) { o.description = d[0]; o.chg = d[1]; }
      }
    } catch { /* optional */ }
    r1Crossers = out.sort((a, b) => b.crossDate.localeCompare(a.crossDate) || b.aboveR1 - a.aboveR1);
    broadcast({ type: 'pivots', r1Crossers });
  } catch (e) {
    lastError = e.message;
  } finally {
    pivotRunning = false;
  }
}

// ---------------- results reaction ----------------

const RESULTS_MS = 60 * 60 * 1000;
let results = [];

async function pollResults() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const j = await scan({
      ...SCAN_BASE,
      filter: [...BREADTH_FILTER,
        { left: 'market_cap_basic', operation: 'egreater', right: 5e9 },
        { left: 'earnings_release_date', operation: 'egreater', right: now - 4 * 86400 }],
      columns: [...MOVER_COLUMNS, 'earnings_release_date', 'total_revenue_yoy_growth_fq', 'net_income_yoy_growth_fq'],
      sort: { sortBy: 'change', sortOrder: 'desc' }, range: [0, 50],
    });
    results = (j.data || []).map(r => {
      const [name, description, close, chg, volume, rvol, mcap, sector, edate, revG, niG] = r.d;
      return {
        symbol: r.s, name, description, price: close, chg, volume, rvol, sector, revG, niG,
        reported: edate ? new Date(edate * 1000).toISOString().slice(0, 10) : null,
      };
    });
    broadcast({ type: 'results', results });
    let changed = false;
    for (const s of results.slice(0, CATALYST_COUNT)) {
      if (s.catalyst !== undefined) continue;
      try {
        s.catalyst = pickCatalyst(await fetchNews(newsQueryName(s.description)));
        changed = true;
      } catch { s.catalyst = null; }
      await sleep(150);
    }
    if (changed) broadcast({ type: 'results', results });
  } catch (e) {
    lastError = e.message;
  }
}

// ---------------- watchlist news feed ----------------

const WNEWS_MS = 15 * 60 * 1000;
let wnews = { items: [], at: null };

async function pollWatchNews() {
  try {
    const items = [];
    for (const sym of watchlist.slice(0, 40)) {
      const row = watchRows.find(r => r.symbol === sym);
      try {
        for (const it of await fetchNews(newsQueryName(row?.description || sym.split(':').pop()))) {
          items.push({ ...it, symbol: sym, name: sym.split(':').pop() });
        }
      } catch { /* one symbol failing shouldn't kill the feed */ }
      await sleep(120);
    }
    const seen = new Set();
    wnews = {
      items: items
        .filter(i => { if (seen.has(i.title)) return false; seen.add(i.title); return true; })
        .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
        .slice(0, 40),
      at: new Date().toISOString(),
    };
    broadcast({ type: 'wnews', wnews });
  } catch (e) {
    lastError = e.message;
  }
}

// ---------------- intraday: pre-market gappers / in-play pace / VWAP flips ----------------
// Fast-polled during market hours (~08:50-15:40 IST), throttled to 10 min
// otherwise. Pre-market gappers use premarket_change while the pre-open
// session is live; once the market opens, rows fall back to the gap column.

const INTRA_MS = 60 * 1000;
let gappers = [], pace = [];
let vwapFlips = [];               // recent reclaim/reject events, newest first
const vwapState = new Map();      // sym -> was price above VWAP on last poll
let lastIntradayRun = 0;

function istNowMinutes() {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).split(':');
  return Number(h) * 60 + Number(m);
}
const marketHoursIST = () => {
  const t = istNowMinutes();
  return t >= 8 * 60 + 50 && t <= 15 * 60 + 40;
};

async function pollIntraday() {
  if (!marketHoursIST() && Date.now() - lastIntradayRun < 10 * 60 * 1000) return;
  lastIntradayRun = Date.now();
  try {
    const cols = [...MOVER_COLUMNS, 'premarket_change', 'premarket_volume', 'gap'];
    const mk = (field, op, right, order) => scan({
      ...SCAN_BASE, filter: [...MOVER_FILTER, { left: field, operation: op, right }],
      columns: cols, sort: { sortBy: field, sortOrder: order }, range: [0, 15],
    });
    const gapRows = (j, src) => (j.data || []).map(r => {
      const [name, description, close, chg, volume, rvol, mcap, sector, pre, preVol, gap] = r.d;
      return { symbol: r.s, name, description, price: close, chg, volume, rvol, sector, pre, preVol, gap, src };
    });
    // pre-market first; if the pre-open session isn't producing data, fall back to open gaps
    let up = gapRows(await mk('premarket_change', 'egreater', 2, 'desc'), 'pre');
    let dn = gapRows(await mk('premarket_change', 'eless', -2, 'asc'), 'pre');
    if (!up.length && !dn.length) {
      up = gapRows(await mk('gap', 'egreater', 2, 'desc'), 'open');
      dn = gapRows(await mk('gap', 'eless', -2, 'asc'), 'open');
    }
    gappers = [...up, ...dn];

    const p = await scan({
      ...SCAN_BASE, filter: [...MOVER_FILTER, { left: 'relative_volume_intraday|5', operation: 'egreater', right: 3 }],
      columns: [...MOVER_COLUMNS, 'relative_volume_intraday|5'],
      sort: { sortBy: 'relative_volume_intraday|5', sortOrder: 'desc' }, range: [0, 25],
    });
    pace = (p.data || []).map(r => {
      const [name, description, close, chg, volume, rvol, mcap, sector, ipace] = r.d;
      return { symbol: r.s, name, description, price: close, chg, volume, rvol, sector, pace: ipace };
    });

    // VWAP flips over the F&O + watchlist universe
    const uni = [...new Set([...fnoUniverse, ...watchlist])];
    if (uni.length) {
      const q = await scan({ symbols: { tickers: uni }, columns: ['close', 'VWAP', 'change', 'relative_volume_10d_calc', 'description'] });
      const t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5);
      for (const r of q.data || []) {
        const [close, vwap, chg, rvol, description] = r.d;
        if (close == null || vwap == null) continue;
        const above = close > vwap;
        const prev = vwapState.get(r.s);
        vwapState.set(r.s, above);
        if (prev !== undefined && prev !== above && marketHoursIST()) {
          vwapFlips.unshift({
            symbol: r.s, name: r.s.split(':').pop(), description,
            dir: above ? 'reclaim' : 'reject', time: t,
            price: close, vwap, dist: ((close - vwap) / vwap) * 100, chg, rvol,
          });
        }
      }
      if (vwapFlips.length > 40) vwapFlips.length = 40;
    }
    broadcast({ type: 'intraday', gappers, pace, vwapFlips, at: new Date().toISOString() });
    let changed = false;
    for (const s of gappers.slice(0, CATALYST_COUNT)) {
      if (s.catalyst !== undefined) continue;
      try {
        s.catalyst = pickCatalyst(await fetchNews(newsQueryName(s.description)));
        changed = true;
      } catch { s.catalyst = null; }
      await sleep(150);
    }
    if (changed) broadcast({ type: 'intraday', gappers, pace, vwapFlips, at: new Date().toISOString() });
  } catch (e) {
    lastError = e.message;
  }
}

// ---------------- VCP / base detection ----------------
// Volatility contraction over the last ~60 sessions: three 20-bar segments
// whose high-low ranges shrink in sequence, on drying volume, near 52w highs,
// with a defined pivot (the recent contraction high).

function detectVcp(bars) {
  if (!bars || bars.length < 120) return null;
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const last = closes[n - 1];
  const hi52 = Math.max(...closes);
  if (last < hi52 * 0.75) return null;
  const win = bars.slice(-60);
  const seg = (a, b) => {
    const s = win.slice(a, b);
    const hi = Math.max(...s.map(x => x.high)), lo = Math.min(...s.map(x => x.low));
    return { hi, dd: ((hi - lo) / hi) * 100, vol: s.reduce((t, x) => t + x.volume, 0) / s.length };
  };
  const s1 = seg(0, 20), s2 = seg(20, 40), s3 = seg(40, 60);
  if (!(s1.dd > s2.dd && s2.dd > s3.dd)) return null;   // must contract
  if (s3.dd > 10 || s1.dd > 35) return null;
  if (s3.vol > s1.vol) return null;                     // volume must dry up
  const pivot = Math.max(s2.hi, s3.hi);
  const toPivot = ((pivot - last) / last) * 100;
  if (toPivot < -3 || toPivot > 15) return null;
  return { c1: s1.dd, c2: s2.dd, c3: s3.dd, pivot, toPivot, offHigh: ((last / hi52) - 1) * 100 };
}

let vcp = [];
async function refreshVcp() {
  const hits = [];
  for (const [sym, cb] of candBars) {
    const v = detectVcp(cb.bars);
    if (v) hits.push({ symbol: sym, name: sym.split(':').pop(), ...v });
  }
  if (hits.length) {
    try {
      const q = await scan({ symbols: { tickers: hits.map(h => h.symbol) }, columns: ['description', 'change', 'close'] });
      const map = new Map((q.data || []).map(x => [x.s, x.d]));
      for (const h of hits) {
        const d = map.get(h.symbol);
        if (d) { h.description = d[0]; h.chg = d[1]; h.price = d[2]; }
      }
    } catch { /* optional decoration */ }
  }
  vcp = hits.sort((a, b) => Math.abs(a.toPivot) - Math.abs(b.toPivot)).slice(0, 30);
  broadcast({ type: 'vcp', vcp });
}

// ---------------- fundamentals (concept from MrChartist/Funda-Scanner-Base-Project) ----------------
// Piotroski-style pass/fail checklist with the same Strong >=7 / Moderate >=4
// grading as that project's FundamentalScoring, fed by live scanner columns.

const FUNDA_COLS = ['description', 'sector', 'market_cap_basic', 'price_earnings_ttm',
  'earnings_per_share_basic_ttm', 'return_on_equity', 'debt_to_equity', 'price_book_fq',
  'dividend_yield_recent', 'net_margin', 'total_revenue_yoy_growth_ttm', 'net_income_yoy_growth_ttm', 'beta_1_year'];

async function getFunda(symbol) {
  const j = await scan({ symbols: { tickers: [symbol] }, columns: FUNDA_COLS });
  const r = (j.data || [])[0];
  if (!r) throw new Error('no fundamentals for ' + symbol);
  const [description, sector, mcap, pe, eps, roe, de, pb, divYield, margin, revG, niG, beta] = r.d;
  const checks = [
    ['ROE ≥ 15%', roe != null && roe >= 15],
    ['Net margin ≥ 8%', margin != null && margin >= 8],
    ['EPS positive', eps != null && eps > 0],
    ['Revenue growing YoY', revG != null && revG > 0],
    ['Profit growing YoY', niG != null && niG > 0],
    ['Profit outgrowing revenue', niG != null && revG != null && niG > revG],
    ['Debt/Equity ≤ 1', de != null && de <= 1],
    ['P/E ≤ 50', pe != null && pe > 0 && pe <= 50],
    ['P/B ≤ 8', pb != null && pb <= 8],
  ].map(([label, pass]) => ({ label, pass: !!pass }));
  const score = checks.filter(c => c.pass).length;
  return {
    symbol, description, sector, mcap, pe, eps, roe, de, pb, divYield, margin, revG, niG, beta,
    score, max: checks.length, checks,
    label: score >= 7 ? 'Strong' : score >= 4 ? 'Moderate' : 'Weak',
  };
}

// ---------------- watchlist edits ----------------

function normalizeSymbol(input) {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  return s.includes(':') ? s : `NSE:${s}`;
}

async function validateSymbol(sym) {
  const j = await scan({ symbols: { tickers: [sym] }, columns: ['close', 'description'] });
  const r = (j.data || [])[0];
  return r && r.d[0] != null ? { symbol: r.s, description: r.d[1] } : null;
}

// ---------------- boot ----------------

(async () => {
  await pollQuotes();
  pollMovers();
  pollWeekly();
  pollSectors();
  pollChartink();
  pollGainers();
  pollResults();
  pollUOA();
  await pollOI();                       // fills fnoUniverse for the pivot scan
  pollIntraday();
  refreshCandidates().then(() => pollPivots()).then(() => refreshVcp());
  refreshEmas().then(() => { pollQuotes(); pollWatchNews(); });
})();
setInterval(pollQuotes, QUOTE_MS);
setInterval(pollMovers, MOVERS_MS);
setInterval(pollWeekly, WEEKLY_MS);
setInterval(pollSectors, WEEKLY_MS);
setInterval(pollChartink, CHARTINK_MS);
setInterval(pollGainers, GAIN_MS);
setInterval(pollOI, OI_MS);
setInterval(pollUOA, OI_MS);
setInterval(refreshCandidates, CAND_MS);
setInterval(pollPivots, PIVOT_MS);
setInterval(pollResults, RESULTS_MS);
setInterval(pollWatchNews, WNEWS_MS);
setInterval(pollIntraday, INTRA_MS);
setInterval(refreshVcp, PIVOT_MS);
setInterval(() => refreshEmas(), EMA_REFRESH_MS);

// ---------------- http ----------------

const readBody = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
});
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({
      type: 'init', watchRows, indexRows, gainers, losers, volumeShockers,
      gainers7, losers7, volumeBuildup, breadth, eps, sectors, chartink,
      gainers1d, gainersW, gainers15, ep15, oi,
      ivPause, ipos, r1Crossers, results, uoa, wnews,
      gappers, pace, vwapFlips, vcp,
      lastPoll, lastError, ema: emaState, watchlist,
    })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/watchlist/add' && req.method === 'POST') {
    const { symbol } = await readBody(req);
    const sym = normalizeSymbol(symbol || '');
    if (!sym) return json(res, 400, { ok: false, error: 'empty symbol' });
    if (watchlist.includes(sym)) return json(res, 200, { ok: true, note: 'already in watchlist' });
    try {
      const v = await validateSymbol(sym);
      if (!v) return json(res, 404, { ok: false, error: `${sym} not found on NSE` });
      watchlist.push(v.symbol);
      saveJson(WATCHLIST_FILE, watchlist);
      json(res, 200, { ok: true, symbol: v.symbol, description: v.description });
      await refreshEmas([v.symbol], true);
      await pollQuotes();
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/watchlist/remove' && req.method === 'POST') {
    const { symbol } = await readBody(req);
    watchlist = watchlist.filter(s => s !== symbol);
    saveJson(WATCHLIST_FILE, watchlist);
    watchRows = watchRows.filter(r => r.symbol !== symbol);
    json(res, 200, { ok: true });
    broadcast({ type: 'rows', watchRows, indexRows, lastPoll });
    return;
  }

  if (url.pathname === '/funda') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return json(res, 400, { ok: false, error: 'no symbol' });
    try {
      json(res, 200, { ok: true, funda: await getFunda(symbol) });
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  // import the active watchlist from TradingView Desktop (same DOM read as
  // the MCP server's watchlist_get, over raw CDP)
  if (url.pathname === '/tv/watchlist' && req.method === 'POST') {
    try {
      const symbols = await cdpEvaluate(`
        (async function() {
          function rows() { return document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]'); }
          if (!rows().length) {
            var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
              || document.querySelector('[aria-label="Watchlist, details, and news"]')
              || document.querySelector('[aria-label^="Watchlist"]');
            if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
            var end = Date.now() + 5000;
            while (Date.now() < end && !rows().length) await new Promise(function(r) { setTimeout(r, 250); });
          }
          var out = [], seen = {};
          rows().forEach(function(el) {
            var s = el.getAttribute('data-symbol-full');
            if (s && !seen[s]) { seen[s] = 1; out.push(s); }
          });
          return out;
        })()
      `);
      const nse = (symbols || []).filter(s => s.startsWith('NSE:'));
      const added = nse.filter(s => !watchlist.includes(s));
      watchlist.push(...added);
      saveJson(WATCHLIST_FILE, watchlist);
      json(res, 200, { ok: true, found: (symbols || []).length, nse: nse.length, added: added.length });
      if (added.length) refreshEmas(added, true).then(pollQuotes);
      else pollQuotes();
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/chart/open' && req.method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) return json(res, 400, { ok: false, error: 'no symbol' });
    try {
      const opened = await chartOpen(symbol);
      json(res, 200, { ok: true, symbol: opened || symbol });
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/news') {
    const name = url.searchParams.get('name') || '';
    try {
      json(res, 200, { ok: true, items: await fetchNews(newsQueryName(name)) });
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`India dashboard: http://localhost:${PORT} (${watchlist.length} watchlist symbols) ${nowIST()} IST`));
