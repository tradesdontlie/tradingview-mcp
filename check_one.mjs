/**
 * check_one.mjs — Lay du lieu 1 ma tu TradingView CDP
 * Run: node check_one.mjs HOSE:OCB
 * Output: compact JSON (~500 tokens) thay vi raw 65 bars (~12k tokens)
 */
import fs from 'fs';
import path from 'path';
import * as chart from './src/core/chart.js';
import * as data from './src/core/data.js';
import { getClient } from './src/connection.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseNum(val) {
  if (val == null || val === '' || val === '∅') return null;
  const s = val.toString().replace(/[,\s]/g,'').replace('−','-');
  const n = parseFloat(s); return isNaN(n) ? null : n;
}
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Pivot High: high[i] = max trong window ±w
function findPivots(bars, w = 3) {
  const ph = [], pl = [];
  for (let i = w; i < bars.length - w; i++) {
    const hi = bars[i].high;
    const lo = bars[i].low;
    let isPH = true, isPL = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (bars[j].high >= hi) isPH = false;
      if (bars[j].low  <= lo) isPL = false;
    }
    if (isPH) ph.push({ i, price: hi, time: bars[i].time });
    if (isPL) pl.push({ i, price: lo, time: bars[i].time });
  }
  return { ph: ph.slice(-3).reverse(), pl: pl.slice(-3).reverse() };
}

function marketStructure(ph, pl) {
  if (ph.length < 2 || pl.length < 2) return 'INSUFFICIENT_DATA';
  const hhhl = ph[0].price > ph[1].price && pl[0].price > pl[1].price;
  const lhll = ph[0].price < ph[1].price && pl[0].price < pl[1].price;
  if (hhhl) return 'UPTREND';
  if (lhll) return 'DOWNTREND';
  if (ph[0].price > ph[1].price && pl[0].price < pl[1].price) return 'EXPANDING';
  return 'CONTRACTING';
}

function tpProjections(pl1, ph1, pl2) {
  const amp = ph1 - pl2;
  return {
    tp100:  Math.round(pl1 + amp * 1.000),
    tp1272: Math.round(pl1 + amp * 1.272),
    tp1618: Math.round(pl1 + amp * 1.618),
  };
}

function trailStatus(bars, sma20arr) {
  // Check last 3 bars vs SMA20
  const n = bars.length;
  const results = [];
  for (let offset = 2; offset >= 0; offset--) {
    const idx = n - 1 - offset;
    const bar = bars[idx];
    const ma  = sma20arr[idx];
    if (!bar || !ma) continue;
    results.push({ label: `D-${offset}`, close: bar.close, sma20: Math.round(ma), above: bar.close > ma });
  }
  const consecutive_below = results.filter(r => !r.above).length;
  let status = 'SAFE';
  if (consecutive_below === 1) status = 'WARNING';
  if (consecutive_below >= 2 && !results[results.length-1].above && !results[results.length-2]?.above) status = 'EXIT';
  return { bars: results, status };
}

// TF mac dinh theo loai tai san — XAUUSD & VN30F intraday=M5, VN stock=H6 (loc volume thoa thuan, sach hon daily)
function defaultTf(ticker) {
  const t = ticker.toUpperCase();
  if (t.includes('XAU')) return '5';
  if (t.includes('VN30') || t.includes('VN301')) return '5';
  return '360';
}

async function main() {
  const ticker = process.argv[2] || 'HOSE:OCB';
  const timeframe = process.argv[3] || defaultTf(ticker);
  const shortName = ticker.split(':').pop();

  try { await getClient(); } catch(e) { console.error('CDP FAIL:', e.message); process.exit(1); }

  const initState = await chart.getState();

  await chart.setSymbol({ symbol: ticker });
  let ok = false;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    try {
      const st = await chart.getState();
      if ((st.symbol||'').toUpperCase().includes(shortName.toUpperCase())) { ok = true; break; }
    } catch(e) {}
  }
  // PIN timeframe — KHONG doc bua TF chart dang mo (vd 6h) gay sai footprint/bars
  await chart.setTimeframe({ timeframe });
  const normTf = r => String(r).replace(/^1(?=[DWM])/, '').toUpperCase();  // "1D"->"D"
  let tfOk = false;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    try {
      const st = await chart.getState();
      if (normTf(st.resolution) === normTf(timeframe)) { tfOk = true; break; }
    } catch(e) {}
  }
  await sleep(2000);

  // Doc study values — retry cho footprint kip tinh sau khi doi symbol/TF (cold layout switch)
  let sv = { studies: [] };
  for (let i = 0; i < 8; i++) {
    sv = await data.getStudyValues().catch(() => ({ studies: [] }));
    if ((sv.studies||[]).some(s => (s.name||'').includes('Footprint Aggressor'))) break;
    await sleep(1500);
  }
  const [fpTbl, ohlcv, quote] = await Promise.all([
    data.getPineTables({}).catch(() => ({ studies: [] })),
    data.getOhlcv({ count: 65 }).catch(() => ({})),
    data.getQuote({}).catch(() => ({})),
  ]);

  // --- Footprint + MA ---
  const fp = { conf:null, cumD:null, buyVol:null, sellVol:null, totalVol:null,
    buyPct:null, div:null, buyStack:null, sellStack:null, vah:null, val:null, ver:null,
    confShort:null, bias:null, confNet:null };
  const ma = { ma20: null, ma100: null };

  let fpFound = false;
  for (const s of (sv.studies||[])) {
    const v = s.values || {};
    if (s.name.includes('Footprint Aggressor')) {
      fpFound = true;
      fp.conf      = parseNum(v['Confluence']);
      fp.confShort = parseNum(v['Confluence Short']);  // chi co o ban BiDir
      fp.bias      = parseNum(v['Bias']);              // 1=LONG -1=SHORT 0=NEUTRAL
      fp.confNet   = parseNum(v['Conf Net']);
      fp.cumD      = parseNum(v['Cum Delta']);
      fp.buyVol    = parseNum(v['FP Buy Vol']);
      fp.sellVol   = parseNum(v['FP Sell Vol']);
      fp.totalVol  = parseNum(v['FP Total Vol']);
      fp.div       = parseNum(v['Div Signal']);
      fp.buyStack  = parseNum(v['Max Buy Stack']);
      fp.sellStack = parseNum(v['Max Sell Stack']);
      fp.vah       = parseNum(v['FP VAH']);
      fp.val       = parseNum(v['FP VAL']);
      fp.ver       = parseNum(v['VER Ratio']);
      if (fp.totalVol > 0 && fp.buyVol !== null)
        fp.buyPct = Math.round(fp.buyVol / fp.totalVol * 100);
    }
    if (s.name.includes('Pocket Pivot PRO')) {
      ma.ma20  = parseNum(v['MA Nhanh (Tim)'] || v['MA Nhanh (Tím)'] || v['MA Nhanh'] || v['MA Fast']);
      ma.ma100 = parseNum(v['MA Cham'] || v['MA Chậm'] || v['MA Slow'] || v['MA Macro']);
    }
    if (s.name.includes('Price Action GEM') && !ma.ma20) {
      ma.ma20  = parseNum(v['MA Fast']);
      ma.ma100 = parseNum(v['MA Slow']);
    }
  }

  // GUARD: thieu indicator footprint = sai layout. Bao loi ro thay vi doc bua.
  if (!fpFound) {
    console.error(`FOOTPRINT_MISSING: chart khong co 'Footprint Aggressor Analysis' cho ${ticker} @ TF ${timeframe}. Hay load dung layout (VN / XAUUSD / VN30F1M) roi chay lai.`);
    process.exit(2);
  }

  // --- Footprint table (compact: only key rows) ---
  const tableRows = [];
  for (const s of (fpTbl.studies||[])) {
    for (const tbl of (s.tables||[])) {
      for (const row of (tbl.rows||[])) {
        // Keep: IMB, CumDelta, VER, Confluence, Vol summary
        if (/IMB Stack|Cum Delta|VER|Confluence|Vol:|Avg Vol/i.test(row))
          tableRows.push(row);
      }
    }
  }

  const bars = (ohlcv.bars || []).slice(-65);
  const closes = bars.map(b => b.close);
  const n = bars.length;

  // --- Compute SMA20 for every bar (for trail check) ---
  const sma20arr = closes.map((_, i) => i < 19 ? null : sma(closes.slice(0, i+1), 20));
  const sma20_current = ma.ma20 || sma20arr[n-1];    // prefer indicator value
  const sma100_current = ma.ma100 || null;

  // --- Pivot analysis ---
  const { ph, pl } = findPivots(bars, 3);
  const structure = marketStructure(ph, pl);

  // --- Wave context ---
  let wave = {};
  const price = quote.last || quote.close || bars[n-1]?.close;
  if (structure === 'UPTREND' && ph.length >= 1 && pl.length >= 2) {
    const ph1 = ph[0].price, ph2 = ph.length >= 2 ? ph[1].price : null;
    const pl1 = pl[0].price, pl2 = pl[1].price;
    const ampPrev = ph1 - pl2;
    const pullbackPct = ph1 > pl1 ? Math.round((ph1 - price) / (ph1 - pl1) * 100) : null;
    const phase = price < ph1 ? 'PULLBACK' : 'IMPULSE';
    wave = {
      phase, ph1, ph2: ph2 || null,
      pl1, pl2,
      amp_prev: ampPrev,
      amp_prev_pct: Math.round(ampPrev / pl2 * 100 * 10) / 10,
      pullback_pct: pullbackPct,
      tp: tpProjections(pl1, ph1, pl2),
    };
  } else if (structure === 'DOWNTREND') {
    const ph1 = ph[0]?.price, pl1 = pl[0]?.price;
    const bounce = pl1 && ph1 ? Math.round((price - pl1) / (ph1 - pl1) * 100) : null;
    wave = { phase: 'DOWNTREND', ph1, pl1, bounce_pct: bounce };
  } else {
    const hi20 = Math.max(...bars.slice(-20).map(b => b.high));
    const lo20 = Math.min(...bars.slice(-20).map(b => b.low));
    const range_pct = Math.round((hi20 - lo20) / lo20 * 100 * 10) / 10;
    const pos_pct = lo20 < hi20 ? Math.round((price - lo20) / (hi20 - lo20) * 100) : null;
    wave = { phase: 'SIDEWAYS', range_hi: hi20, range_lo: lo20, range_pct, pos_pct };
  }

  // --- Trail SL ---
  const trail = trailStatus(bars, sma20arr);

  // --- Volume: last 5 bars ---
  const avgVol20 = sma(bars.map(b => b.volume), 20);
  const vol5 = bars.slice(-5).map((b, i) => ({
    d: `D-${4-i}`,
    vol: b.volume,
    ratio: avgVol20 ? Math.round(b.volume / avgVol20 * 100) / 100 : null,
  }));

  // --- Footprint score ---
  let fpScore = 0;
  const fpChecks = {
    conf_60:     fp.conf !== null && fp.conf >= 60,
    cumd_pos:    fp.cumD !== null && fp.cumD > 0,
    buypct_55:   fp.buyPct !== null && fp.buyPct >= 55,
    vol_ver:     fp.ver !== null && fp.ver >= 0.8,
    closepos_50: false, // need close position %
    no_div:      fp.div === 0 || fp.div === null,
    imb_buy:     fp.buyStack !== null && fp.buyStack >= 1 && (fp.sellStack === null || fp.buyStack > fp.sellStack),
  };
  // ClosePos: (close - low) / (high - low)
  const todayBar = bars[n-1];
  if (todayBar && todayBar.high > todayBar.low) {
    const cp = (todayBar.close - todayBar.low) / (todayBar.high - todayBar.low) * 100;
    fpChecks.closepos_50 = cp >= 50;
    fp.closePos = Math.round(cp);
  }
  fpScore = Object.values(fpChecks).filter(Boolean).length;

  // --- MTF score ---
  let mtfScore = 0;
  const mtfNotes = [];
  // W/D bull: price > sma20 > sma100
  if (sma20_current && sma100_current && sma20_current > sma100_current) { mtfScore += 1; mtfNotes.push('SMA_BULL+1'); }
  if (structure === 'UPTREND')   { mtfScore += 1; mtfNotes.push('D_UPTREND+1'); }
  if (structure === 'DOWNTREND') { mtfScore -= 2; mtfNotes.push('D_DOWNTREND-2'); }

  // --- Huong (BiDir): tu fp.bias. null = ban cu long-only ---
  const dir = fp.bias === 1 ? 'LONG' : fp.bias === -1 ? 'SHORT' : fp.bias === 0 ? 'NEUTRAL' : 'LONG_ONLY';

  // --- Compact output ---
  const out = {
    ticker, price, timeframe, tf_confirmed: tfOk, dir,
    symbol_confirmed: ok,
    date: bars[n-1]?.time ? new Date(bars[n-1].time * 1000).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
    ohlc_today: { o: todayBar?.open, h: todayBar?.high, l: todayBar?.low, c: todayBar?.close, vol: todayBar?.volume },
    ma: { sma20: sma20_current, sma100: sma100_current },
    fp: { ...fp, score: fpScore, checks: fpChecks },
    fp_table_summary: tableRows,
    structure,
    wave,
    trail: { ...trail, sma20_current },
    vol5,
    avg_vol20: Math.round(avgVol20 || 0),
    mtf: { score: mtfScore, notes: mtfNotes },
    pivots: {
      ph: ph.map(p => ({ price: p.price, d: `D-${n-1-p.i}` })),
      pl: pl.map(p => ({ price: p.price, d: `D-${n-1-p.i}` })),
    },
  };

  const json = JSON.stringify(out);
  try {
    const cacheDir = 'C:/Users/ADMIN/claude_os/data';
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheDate = out.date || new Date().toISOString().slice(0,10);
    const cachePath = path.join(cacheDir, `check_${shortName.toUpperCase()}_${cacheDate.replace(/-/g, '')}.json`);
    const latestPath = path.join(cacheDir, `check_${shortName.toUpperCase()}_latest.json`);
    fs.writeFileSync(cachePath, json, 'utf8');
    fs.writeFileSync(latestPath, json, 'utf8');
  } catch (e) {
    console.error('CACHE_WRITE_WARN:', e.message);
  }

  console.log('DATA_JSON:' + json);

  try { await chart.setSymbol({ symbol: initState.symbol }); } catch(e) {}
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
