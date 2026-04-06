#!/usr/bin/env node
/**
 * Crypto Scalp Scanner
 * 1. Fetches top 100 crypto from CoinGecko
 * 2. Filters by momentum + volume for scalp candidates
 * 3. Deep-analyzes top picks on TradingView (reads Apex Scanner indicator)
 * 4. Outputs ranked trade setups with entry/SL/TP
 *
 * Usage: node scripts/crypto-scanner.js [--top 15] [--deep 5] [--timeframe 60]
 */

import { chart, data, capture } from '../src/core/index.js';
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

// ── Config ──────────────────────────────────────────────────────────────────
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d';
const STABLES = new Set(['USDT','USDC','DAI','FDUSD','BUSD','TUSD','USDD','PYUSD','USDS','USDP','GUSD','FRAX','LUSD','CRVUSD','GHO','SUSD']);
const WRAPPED = new Set(['WBTC','WETH','WBNB','STETH','CBETH','RETH','WSTETH','CBBTC','WEETH','LBTC','BBTC','METH','TBTC','FIGR_HELOC','WBT']);
const SCAN_DELAY = 3500;
const OUTPUT_DIR = '/Users/apex/tradingview-mcp/scans';

const { values: args } = parseArgs({
  options: {
    top:       { type: 'string', default: '15' },
    deep:      { type: 'string', default: '5' },
    timeframe: { type: 'string', default: '60' },
  },
  strict: false,
});

const TOP_N = parseInt(args.top);
const DEEP_N = parseInt(args.deep);
const TF = args.timeframe;

function log(msg) { process.stderr.write(`[scanner] ${msg}\n`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Fetch top 100 ───────────────────────────────────────────────────
async function fetchTop100() {
  log('Fetching top 100 from CoinGecko...');
  const res = await fetch(COINGECKO_URL);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const coins = await res.json();
  return coins
    .filter(c => {
      const s = c.symbol.toUpperCase();
      return !STABLES.has(s) && !WRAPPED.has(s);
    })
    .map(c => ({
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      price: c.current_price,
      mcap: c.market_cap,
      vol24h: c.total_volume,
      chg1h: c.price_change_percentage_1h_in_currency || 0,
      chg24h: c.price_change_percentage_24h || 0,
      chg7d: c.price_change_percentage_7d_in_currency || 0,
      volMcap: c.total_volume / c.market_cap,
    }));
}

// ── Step 2: Score for scalp potential ────────────────────────────────────────
function scoreCoins(coins) {
  return coins.map(c => {
    let s = 0;
    const a1 = Math.abs(c.chg1h), a24 = Math.abs(c.chg24h);
    // 1h momentum
    if (a1 > 3) s += 30; else if (a1 > 1.5) s += 20; else if (a1 > 0.5) s += 10;
    // 24h momentum
    if (a24 > 8) s += 25; else if (a24 > 4) s += 15; else if (a24 > 2) s += 8;
    // Volume activity
    if (c.volMcap > 0.3) s += 25; else if (c.volMcap > 0.15) s += 15; else if (c.volMcap > 0.05) s += 5;
    // Min volume
    if (c.vol24h < 50_000_000) s -= 20;
    // Same direction momentum
    if (Math.sign(c.chg1h) === Math.sign(c.chg24h) && a1 > 0.5) s += 10;
    return { ...c, score: s };
  }).sort((a, b) => b.score - a.score);
}

// ── Step 3: Deep TradingView analysis ───────────────────────────────────────
async function analyze(coin) {
  const sym = `BINANCE:${coin.symbol}USDT.P`;
  log(`  Analyzing ${sym}...`);
  try {
    await chart.setSymbol({ symbol: sym });
    await sleep(1500);
    await chart.setTimeframe({ timeframe: TF });
    await sleep(2000);

    // Pull all data in parallel-ish
    const [quote, studies, ohlcvData] = await Promise.all([
      data.getQuote(),
      data.getStudyValues(),
      data.getOhlcv({ count: 50 }),
    ]);

    // Try to read Pine lines/labels for levels
    let levels = [], labels_data = [];
    try {
      const [linesRes, labelsRes] = await Promise.all([
        data.getPineLines({}),
        data.getPineLabels({}),
      ]);
      if (linesRes.studies) {
        for (const st of linesRes.studies) {
          if (st.horizontal_levels) {
            const near = st.horizontal_levels.filter(l =>
              l > quote.close * 0.9 && l < quote.close * 1.1
            );
            levels.push(...near.map(p => ({ price: p, src: st.name })));
          }
        }
      }
      if (labelsRes.studies) {
        for (const st of labelsRes.studies) {
          if (st.labels) {
            labels_data.push(...st.labels.filter(l =>
              l.price > quote.close * 0.9 && l.price < quote.close * 1.1
            ).map(l => ({ text: l.text, price: l.price, src: st.name })));
          }
        }
      }
    } catch (_) {}

    // Extract Apex Scanner values if present
    let apex = null;
    for (const st of (studies.studies || [])) {
      if (st.name && st.name.includes('Apex')) {
        apex = st.values;
        break;
      }
    }

    // Compute technicals from bars
    const bars = ohlcvData.bars || [];
    const tech = computeTech(bars, quote);

    // Take screenshot
    let screenshot = null;
    try {
      const ss = await capture.captureScreenshot({ region: 'chart' });
      screenshot = ss.file_path;
    } catch (_) {}

    return {
      symbol: coin.symbol, tv: sym, price: quote.close || quote.last,
      score: coin.score, chg1h: coin.chg1h, chg24h: coin.chg24h, vol24h: coin.vol24h,
      apex, studies: (studies.studies || []).map(s => ({ name: s.name, values: s.values })),
      tech, levels: levels.slice(0, 15), labels: labels_data.slice(0, 15),
      screenshot, ok: true,
    };
  } catch (err) {
    log(`  FAIL ${sym}: ${err.message}`);
    return { symbol: coin.symbol, ok: false, error: err.message, score: coin.score };
  }
}

function computeTech(bars, quote) {
  if (!bars.length) return {};
  const c = bars.map(b => b.close), v = bars.map(b => b.volume);
  const h = bars.map(b => b.high), l = bars.map(b => b.low);
  const price = quote.close || c[c.length - 1];

  const sma9 = avg(c, 9), sma21 = avg(c, 21), sma55 = avg(c, 55);
  const rsi = calcRSI(c, 14);
  const atr = calcATR(h, l, c, 14);
  const recentV = avg(v, 5), prevV = avgSlice(v, 10, 5);
  const volTrend = prevV > 0 ? ((recentV - prevV) / prevV * 100) : 0;
  const hi = Math.max(...h), lo = Math.min(...l);
  const pos = (hi - lo) > 0 ? ((price - lo) / (hi - lo) * 100) : 50;
  const trend = price > sma9 && sma9 > sma21 ? 'bullish' :
                price < sma9 && sma9 < sma21 ? 'bearish' : 'neutral';

  return { sma9: r(sma9), sma21: r(sma21), sma55: r(sma55), rsi: r(rsi,1),
    atr: r(atr), atr_pct: r(atr/price*100, 2), vol_trend: r(volTrend,1),
    price_pos: r(pos,1), range_hi: hi, range_lo: lo, trend };
}

function avg(arr, n) { const s = arr.slice(-n); return s.reduce((a,b)=>a+b,0)/s.length; }
function avgSlice(arr, from, to) { const s = arr.slice(-from, -to); return s.length ? s.reduce((a,b)=>a+b,0)/s.length : 0; }
function r(v, d=6) { return +v.toFixed(d); }

function calcRSI(closes, p) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g/p, al = l/p;
  return al === 0 ? 100 : 100 - 100/(1 + ag/al);
}

function calcATR(h, l, c, p) {
  if (h.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < h.length; i++)
    trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}

// ── Step 4: Generate trade setups ───────────────────────────────────────────
function makeSetup(a) {
  if (!a.ok || !a.tech.atr) return null;
  const { price, tech, apex, chg1h, chg24h } = a;
  const atr = tech.atr;

  // Use Apex scores if available, otherwise compute from tech
  let bullScore = 0, bearScore = 0;
  if (apex) {
    bullScore = parseFloat(apex['Bull Score'] || '0');
    bearScore = parseFloat(apex['Bear Score'] || '0');
  } else {
    // Compute from technicals
    if (tech.trend === 'bullish') bullScore += 20;
    if (tech.trend === 'bearish') bearScore += 20;
    if (tech.rsi > 40 && tech.rsi < 65) bullScore += 15;
    if (tech.rsi > 55 && tech.rsi < 80) bearScore += 15;
    if (tech.rsi < 30) bullScore += 20;
    if (tech.rsi > 70) bearScore += 20;
    if (chg1h > 0.5) bullScore += 10;
    if (chg1h < -0.5) bearScore += 10;
    if (parseFloat(tech.vol_trend) > 20) { bullScore += 10; bearScore += 10; }
  }

  const dir = bullScore > bearScore + 10 ? 'LONG' :
              bearScore > bullScore + 10 ? 'SHORT' : null;
  if (!dir) return null;

  const isLong = dir === 'LONG';
  const slDist = atr * 1.5;
  const entry = price;
  const sl   = isLong ? price - slDist : price + slDist;
  const tp1  = isLong ? price + atr * 1.0 : price - atr * 1.0;
  const tp2  = isLong ? price + atr * 2.0 : price - atr * 2.0;
  const tp3  = isLong ? price + atr * 3.0 : price - atr * 3.0;

  let confidence = Math.max(bullScore, bearScore);
  if (apex) confidence = Math.min(95, confidence);

  return {
    dir, confidence, bull_score: bullScore, bear_score: bearScore,
    entry: r(entry), sl: r(sl), tp1: r(tp1), tp2: r(tp2), tp3: r(tp3),
    risk_pct: r(slDist/price*100, 2),
    rr1: r(1.0/1.5, 2), rr2: r(2.0/1.5, 2), rr3: r(3.0/1.5, 2),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log(`=== APEX CRYPTO SCALP SCANNER ===`);
  log(`TF: ${TF} | Top: ${TOP_N} | Deep: ${DEEP_N}`);

  const coins = await fetchTop100();
  log(`Got ${coins.length} coins (stables/wrapped excluded)`);

  const ranked = scoreCoins(coins);
  const top = ranked.slice(0, TOP_N);
  log(`\nTop ${TOP_N} by scalp score:`);
  for (const c of top) {
    log(`  ${c.symbol.padEnd(8)} scr=${String(c.score).padStart(3)} 1h=${c.chg1h.toFixed(2).padStart(7)}% 24h=${c.chg24h.toFixed(2).padStart(7)}%`);
  }

  log(`\nDeep analyzing top ${DEEP_N}...`);
  const results = [];
  for (const coin of top.slice(0, DEEP_N)) {
    const r = await analyze(coin);
    if (r.ok) r.setup = makeSetup(r);
    results.push(r);
    await sleep(SCAN_DELAY);
  }

  const setups = results
    .filter(r => r.ok && r.setup)
    .sort((a, b) => b.setup.confidence - a.setup.confidence);

  const report = {
    ts: new Date().toISOString(),
    tf: TF,
    scanned: coins.length,
    deep: results.length,
    tradeable: setups.length,
    duration_s: r((Date.now()-t0)/1000, 1),
    top_movers: top.slice(0, 10).map(c => ({
      sym: c.symbol, score: c.score, chg1h: r(c.chg1h,2), chg24h: r(c.chg24h,2),
      vol_mcap: r(c.volMcap*100, 1),
    })),
    setups: setups.map(a => ({
      symbol: a.symbol, tv: a.tv, price: a.price,
      ...a.setup,
      tech: a.tech,
      apex: a.apex,
      levels: a.levels,
      labels: a.labels,
      screenshot: a.screenshot,
    })),
    failed: results.filter(r => !r.ok).map(r => ({ sym: r.symbol, err: r.error })),
  };

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const fname = `scan_${TF}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const fpath = `${OUTPUT_DIR}/${fname}`;
  writeFileSync(fpath, JSON.stringify(report, null, 2));

  // Also write latest for easy access
  writeFileSync(`${OUTPUT_DIR}/latest.json`, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  log(`\nSaved: ${fpath}`);
  log(`=== Done in ${report.duration_s}s | ${setups.length} setups found ===`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
