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
import { computeRS, readVnindexCache } from './rs_util.mjs';
import { barStatus } from './bar_status.mjs';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseNum(val) {
  if (val == null || val === '' || val === '∅') return null;
  const s = val.toString().replace(/[,\s]/g,'').replace('−','-');
  const n = parseFloat(s); return isNaN(n) ? null : n;
}

// Volume thresholds — đồng bộ toàn hệ thống (scan_live.mjs, scan_engine.py, check.md)
const BREAKOUT_VOL = 1.5;
const PULLBACK_VOL = 1.0;
// TopBot VSA/Wyckoff: nguong vol sieu cao (climactic) + cao (effort)
const VOL_ULTRA = 2.0;
const VOL_HIGH  = BREAKOUT_VOL;
// Bien do tran/san: coi la sat tran/san khi da di >=93% bien do tu tham chieu
const NEAR_LIMIT = 0.93;

// --full flag: include heavy diagnostic fields (fp_table_summary, raw vol, amp_prev, mtf)
const FULL = process.argv.includes('full') || process.env.CHECK_FULL === '1';

function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// === TopBot DOAN 1: phan loai nen (VSA: vol + spread + close position) ===
const round2 = (num) => Math.round(num * 100) / 100;

function classifyBar(bar, avgVol, avgSpread, prior20Highs, prior20Lows) {
  const spread = bar.high - bar.low;
  const volRatio = avgVol ? round2(bar.volume / avgVol) : null;
  const spreadRatio = avgSpread ? round2(spread / avgSpread) : null;
  let spreadClass = 'normal';
  if (spreadRatio !== null) {
    if (spreadRatio < 0.7) spreadClass = 'narrow';
    else if (spreadRatio > 1.3) spreadClass = 'wide';
  }
  const highEqLow = bar.high === bar.low;
  const closePos = highEqLow ? 50 : Math.round(((bar.close - bar.low) / (bar.high - bar.low)) * 100);
  const isUp = bar.close > bar.open;
  const isDown = bar.close < bar.open;
  const atNewHigh = prior20Highs.length ? bar.high >= Math.max(...prior20Highs) : false;
  const atNewLow = prior20Lows.length ? bar.low <= Math.min(...prior20Lows) : false;
  return { volRatio, spread, spreadRatio, spreadClass, closePos, isUp, isDown, atNewHigh, atNewLow };
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

// Sinh kich ban phu (alt scenario) MAY MOC tu wave + overhead — khong de LLM tu nho (skill 6e).
// Chi VN LONG uptrend; SL<entry<TP1 bat buoc, geometry khong thoa -> bo nhanh do (rong la dung).
function buildScenarios(structure, wave, overhead, dir, shelf = null) {
  if (structure !== 'UPTREND') return [];
  if (dir === 'SHORT' || dir === 'NEUTRAL') return [];
  const tp = wave.tp || {};
  const tp1 = tp.tp1272 || null;
  const tp2 = tp.tp1618 || null;
  if (!tp1) return [];
  const valid = (lo, hi, sl, t1) => sl < lo && lo <= hi && hi < t1;
  const out = [];
  if (wave.phase === 'PULLBACK' && overhead.resistance
      && overhead.headroom_pct != null && overhead.headroom_pct <= 5) {
    // primary = retest/pullback -> them nhanh breakout qua overhead
    const r = overhead.resistance;
    const entry = Math.round(r * 1.003);
    const sl = Math.round(r * 0.99);
    if (valid(entry, entry, sl, tp1)) {
      out.push({ label: 'breakout', entry_low: entry, entry_high: entry,
        sl, tp1, tp2, trigger: `dong tren ${Math.round(r)} + vol>=1.5x`,
        size_note: '1/2 size, chase' });
    }
  } else if (wave.phase === 'IMPULSE' && wave.ph1) {
    // primary = breakout/IMPULSE -> them nhanh retest ve pivot high cu
    const lvl = wave.ph1;
    const lo = Math.round(lvl * 0.997);
    const hi = Math.round(lvl * 1.003);
    // SL uu tien shelf (muc 25% nen cau manh, chat + dung cau truc) > pivot low xa > -3%
    const slBase = (shelf != null && shelf < lo) ? shelf
                 : (wave.pl1 && wave.pl1 < lo) ? wave.pl1 : lvl * 0.97;
    const sl = Math.round(slBase * 0.998);
    if (valid(lo, hi, sl, tp1)) {
      out.push({ label: 'retest', entry_low: lo, entry_high: hi,
        sl, tp1, tp2, trigger: `retest ve ${Math.round(lvl)} giu duoc + buy-tick`,
        size_note: 'full size neu giu' });
    }
  }
  return out;
}

// Giu bao nhieu % range nen cau manh moi coi la "con da". Dong cua duoi muc (1-HOLD_FRAC) range = mat.
// HOLD_FRAC=0.75 -> giu nua tren + 1/4, shelf o muc 25% nen manh (vd POW 13800-14550 -> shelf ~13988). Chinh duoc.
const HOLD_FRAC = 0.75;

// Tim nen cau manh gan nhat trong `lookback` nen DA DONG (D-1..D-5): vol>=1.5x + dong cao + nen tang.
// Shelf = muc (1-HOLD_FRAC) cua RANGE chinh nen manh = ranh gioi giu da. con nguyen = chua nen da-dong nao
// sau no dong cua duoi shelf. Tra { shelf, zoneHi=close }.
function findDemandBar(bars, n, avgVol20, lookback = 5) {
  if (!avgVol20) return null;
  for (let off = 1; off <= lookback; off++) {
    const idx = n - 1 - off;
    const b = bars[idx];
    if (!b) continue;
    const range = b.high - b.low;
    const closePos = range > 0 ? (b.close - b.low) / range : 0;
    if (b.close > b.open && (b.volume / avgVol20) >= 1.5 && closePos >= 0.65) {
      const shelf = b.low + (1 - HOLD_FRAC) * range; // muc 25% cua nen manh (POW ~13988)
      let broken = false;
      for (let j = idx + 1; j <= n - 2; j++) { if (bars[j] && bars[j].close < shelf) { broken = true; break; } }
      if (broken) continue;               // da dong cua duoi muc 25% sau do -> mat da, bo
      return { shelf, zoneHi: b.close, off };
    }
  }
  return null;
}

// Continuation-retest: nen cau manh (findDemandBar) + nen hien tai can cung -> neo retest vao ZONE [shelf .. close].
// Invalidation = DONG CUA DUOI shelf (vd POW: dung dong duoi ~14000). Trigger = pullback giu tren shelf + can cung
// + LTF lat delta. Chay ca khi structure != UPTREND -> chong vong "cho breakout".
function contRetestScenario({ shelf, zoneHi, price, d0vol, resistance, atr14, dir }) {
  if (dir === 'SHORT' || dir === 'NEUTRAL') return null;
  if (shelf == null || zoneHi == null || price == null) return null;
  if (d0vol == null || d0vol >= 1.0) return null;                      // nen hien tai phai can cung (<1x)
  if (price <= shelf) return null;                                     // mat shelf -> bo
  if (atr14 && (price - zoneHi) > 2 * atr14) return null;              // retest qua xa, chua actionable
  const lo = Math.round(shelf);
  const hi = Math.round(Math.min(zoneHi, price));                      // khong de xuat mua tren gia hien tai
  const sl = Math.round(shelf - (atr14 ? atr14 * 0.5 : shelf * 0.01));
  const tp1 = (resistance && resistance > price * 1.01) ? Math.round(resistance)
            : Math.round(price + 2 * (atr14 || price * 0.02));
  const tp2 = Math.round(tp1 + (atr14 ? atr14 * 2 : tp1 * 0.03));
  if (!(sl < lo && lo <= hi && hi < tp1)) return null;
  return { label: 'retest', entry_low: lo, entry_high: hi, sl, tp1, tp2,
    trigger: `pullback giu tren shelf ${lo} (KHONG dong cua duoi) + vol can + nen LTF (H1) lat delta duong`,
    size_note: 'continuation retest, invalidation = dong duoi shelf' };
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
  let ticker = process.argv[2] || 'HOSE:OCB';
  const timeframe = process.argv[3] || defaultTf(ticker);
  const shortName = ticker.split(':').pop();

  try { await getClient(); } catch(e) { console.error('CDP FAIL:', e.message); process.exit(1); }

  const initState = await chart.getState();

  // VN stock: prefix HOSE co the sai (SHS o HNX) -> resolve dung san qua TradingView symbol search REST,
  // tranh ban symbol invalid len chart (gay ket UI). Non-VN / search khong thay -> giu ticker goc.
  const VN_BOARDS = ['HOSE', 'HSX', 'HNX', 'UPCOM'];
  const givenBoard = ticker.includes(':') ? ticker.split(':')[0].toUpperCase() : null;
  if (givenBoard && VN_BOARDS.includes(givenBoard)) {
    try {
      const sr = await chart.symbolSearch({ query: shortName });
      const hit = (sr.results || []).find(x =>
        VN_BOARDS.includes((x.exchange || '').toUpperCase()) &&
        x.symbol.toUpperCase() === shortName.toUpperCase());
      if (hit) ticker = hit.full_name;
    } catch (e) {}
  }

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
  // nen D-0 da dong chua: chua dong -> phase/scenario chot theo nen D-1 (khong nhay trong phien)
  const bar = barStatus(bars[n-1].time, Number(timeframe) || 360);
  const barClosed = bar.closed;

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
  // gia QUYET DINH phase: nen D-0 chua dong -> dung close D-1 (chot ca phien); dong roi -> gia thuc
  const decisionPrice = barClosed ? price : (bars[n-2]?.close ?? price);
  if (structure === 'UPTREND' && ph.length >= 1 && pl.length >= 2) {
    const ph1 = ph[0].price, ph2 = ph.length >= 2 ? ph[1].price : null;
    const pl1 = pl[0].price, pl2 = pl[1].price;
    const ampPrev = ph1 - pl2;
    const pullbackPct = ph1 > pl1 ? Math.round((ph1 - decisionPrice) / (ph1 - pl1) * 100) : null;
    const phase = decisionPrice < ph1 ? 'PULLBACK' : 'IMPULSE';
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
    const bounce = pl1 && ph1 ? Math.round((decisionPrice - pl1) / (ph1 - pl1) * 100) : null;
    wave = { phase: 'DOWNTREND', ph1, pl1, bounce_pct: bounce };
  } else {
    const hi20 = Math.max(...bars.slice(-20).map(b => b.high));
    const lo20 = Math.min(...bars.slice(-20).map(b => b.low));
    const range_pct = Math.round((hi20 - lo20) / lo20 * 100 * 10) / 10;
    const pos_pct = lo20 < hi20 ? Math.round((decisionPrice - lo20) / (hi20 - lo20) * 100) : null;
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

  // Derived volume state for phase-aware logic
  const lastVolRatio = vol5.length > 0 ? vol5[vol5.length - 1].ratio : null;
  const vol_state = {
    ratio_last: lastVolRatio,
    breakout: lastVolRatio !== null && lastVolRatio >= BREAKOUT_VOL,
    exhausted: lastVolRatio !== null && lastVolRatio < PULLBACK_VOL,
  };

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

  // --- VSA effort-vs-result (chom cung tai nen no-progress) ---
  // Bo sung cho 'div': bat ca vol cao + dong cua yeu/mid + than nho (gia khong tien len).
  let vsa_churn = { flag: false, close_pos: fp.closePos ?? null, body_pct: null, vol_ratio: lastVolRatio, note: null };
  if (todayBar && todayBar.high > todayBar.low) {
    const spread = todayBar.high - todayBar.low;
    const bodyPct = Math.round(Math.abs(todayBar.close - todayBar.open) / spread * 100);
    const effort    = lastVolRatio !== null && lastVolRatio >= 1.2;  // no luc > TB
    const weakClose = (fp.closePos ?? 50) <= 50;                     // dong <=50% nen
    const noResult  = bodyPct < 35;                                  // than nho -> gia khong tien
    const flag = effort && weakClose && noResult;
    vsa_churn = {
      flag, close_pos: fp.closePos ?? null, body_pct: bodyPct, vol_ratio: lastVolRatio,
      note: flag ? 'no luc cao + ket qua kem -> chom cung/cau yeu, can delta xac nhan' : null,
    };
  }

  // --- Overhead resistance gan nhat (room cho RR) ---
  const aboveHighs = ph.map(p => p.price).filter(p => p > price);
  const overheadPrice = aboveHighs.length ? Math.min(...aboveHighs) : null;
  const overhead = {
    resistance: overheadPrice,
    headroom_pct: overheadPrice ? Math.round((overheadPrice - price) / price * 1000) / 10 : null,
  };

  // === TopBot DOAN 2: detector 6 pattern cao trao + nen xac nhan ===
  const avgSpread20 = sma(bars.map(b => b.high - b.low), 20);

  function detectPattern(idx) {
    const prior20Highs = bars.slice(Math.max(0, idx - 20), idx).map(b => b.high);
    const prior20Lows = bars.slice(Math.max(0, idx - 20), idx).map(b => b.low);
    const c = classifyBar(bars[idx], avgVol20, avgSpread20, prior20Highs, prior20Lows);
    if (c.isUp && c.spreadClass === 'narrow' && c.volRatio >= VOL_ULTRA && c.closePos >= 40 && c.atNewHigh) {
      return { pattern: 'ERM', side: 'SELL' };
    }
    if (c.isUp && c.spreadClass === 'wide' && c.volRatio >= VOL_ULTRA && c.atNewHigh && c.closePos >= 30 && c.closePos <= 70) {
      return { pattern: 'BUYING_CLIMAX', side: 'SELL' };
    }
    if (c.atNewHigh && c.closePos <= 20 && c.volRatio >= VOL_HIGH) {
      return { pattern: 'UPTHRUST', side: 'SELL' };
    }
    if (c.isDown && c.spreadClass === 'narrow' && c.volRatio >= VOL_ULTRA && c.closePos <= 20 && c.atNewLow) {
      return { pattern: 'BAG_HOLDING', side: 'BUY' };
    }
    if (c.isDown && c.spreadClass === 'wide' && c.volRatio >= VOL_ULTRA && c.atNewLow && c.closePos >= 30) {
      return { pattern: 'SELLING_CLIMAX', side: 'BUY' };
    }
    if (c.isDown && c.volRatio >= VOL_ULTRA && c.closePos >= 50) {
      return { pattern: 'STOPPING_VOL', side: 'BUY' };
    }
    return null;
  }

  let signalIdx = -1;
  let det = detectPattern(n - 2);
  if (det) {
    signalIdx = n - 2;
  } else {
    det = detectPattern(n - 1);
    if (det) signalIdx = n - 1;
  }

  let signalBar, cSig, confirmed, confirm_rule, stop, target, rr, rr_ok;
  if (det) {
    signalBar = bars[signalIdx];
    cSig = classifyBar(signalBar, avgVol20, avgSpread20,
      bars.slice(Math.max(0, signalIdx - 20), signalIdx).map(b => b.high),
      bars.slice(Math.max(0, signalIdx - 20), signalIdx).map(b => b.low)
    );
    if (signalIdx === n - 2) {
      const confBar = bars[n - 1];
      confirmed = det.side === 'SELL' ? confBar.close < signalBar.close : confBar.close > signalBar.close;
      confirm_rule = null;
    } else {
      confirmed = false;
      confirm_rule = det.side === 'SELL'
        ? `cho nen sau dong < ${Math.round(signalBar.close)}`
        : `cho nen sau dong > ${Math.round(signalBar.close)}`;
    }
    const entry = signalBar.close;
    if (det.side === 'SELL') {
      stop = Math.round(signalBar.high * 1.002);
      const cands = pl.filter(p => p.price < price).map(p => p.price);
      target = cands.length ? Math.max(...cands) : null;
    } else {
      stop = Math.round(signalBar.low * 0.998);
      target = overhead.resistance || null;
    }
    rr = (target && stop) ? Math.round(Math.abs(entry - target) / Math.abs(entry - stop) * 100) / 100 : null;
    rr_ok = rr != null && rr >= 2.0;
  }

  // === TopBot DOAN 3: output object ===
  let topbot;
  if (!det) {
    topbot = { pattern: null };
  } else {
    let note = '';
    switch (det.pattern) {
      case 'ERM':            note = 'tang gia bien hep + vol sieu cao tai dinh moi -> cung hap thu het cau, nguy co dao chieu giam'; break;
      case 'BUYING_CLIMAX':  note = 'cuc tang gia bien rong + vol sieu cao, dong cua roi dinh -> to chuc phan phoi'; break;
      case 'UPTHRUST':       note = 'bay tang gia: pha dinh roi dong cua thap + vol cao -> luc ban manh'; break;
      case 'BAG_HOLDING':    note = 'giam bien hep + vol sieu cao tai day moi -> to chuc hap thu cung, kha nang tao day'; break;
      case 'SELLING_CLIMAX': note = 'cuc giam bien rong + vol sieu cao tai day moi, dong cua hoi -> hap thu cung hoang loan'; break;
      case 'STOPPING_VOL':   note = 'giam nhung vol sieu cao + dong cua nua tren -> dong tien lon chan da roi'; break;
      default: note = '';
    }
    topbot = {
      pattern: det.pattern,
      side: det.side,
      signal_bar: {
        d: `D-${n - 1 - signalIdx}`,
        close: Math.round(signalBar.close),
        vol_ratio: cSig.volRatio,
        spread_class: cSig.spreadClass,
        close_pos: cSig.closePos
      },
      confirmed, confirm_rule, stop, target, rr, rr_ok, note
    };
  }
  const cToday = classifyBar(todayBar, avgVol20, avgSpread20,
    bars.slice(Math.max(0, n - 21), n - 1).map(b => b.high),
    bars.slice(Math.max(0, n - 21), n - 1).map(b => b.low)
  );
  // --- ATR(14) tu True Range (tinh ca gap) + range nen hien tai theo boi so ATR ---
  const trArr = bars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  const atr14 = trArr.length >= 14 ? round2(trArr.slice(-14).reduce((a, c) => a + c, 0) / 14) : null;
  const range_atr = (atr14 && todayBar) ? round2((todayBar.high - todayBar.low) / atr14) : null;
  const spreadOut = { class: cToday.spreadClass, ratio: cToday.spreadRatio, atr14 };
  // doc nen hien tai = 3 so tho, khong phan: range theo boi so ATR + vol ratio + vi tri dong cua
  const bar_read = { range_atr, vol_ratio: lastVolRatio, close_pos: fp.closePos ?? null };
  // nen DA DONG gan nhat (1-3 cay ben trai). bar_read tren la nen real-time chua dong -> doc ket luan o day cho chac
  const closedRead = (b) => b ? {
    range_atr: atr14 ? round2((b.high - b.low) / atr14) : null,
    vol_ratio: avgVol20 ? Math.round(b.volume / avgVol20 * 100) / 100 : null,
    close_pos: b.high > b.low ? Math.round((b.close - b.low) / (b.high - b.low) * 100) : null,
  } : null;
  const prev_closed = [bars[n-2], bars[n-3], bars[n-4]].map(closedRead);
  // `bar`/`barClosed` da tinh dau ham (truoc wave) de chot phase theo nen D-1 khi D-0 chua dong
  vol_state.ultra = lastVolRatio != null && lastVolRatio >= VOL_ULTRA;

  // === VN structural fields: bien do tran/san + ADTV + dao han VN30F ===
  // Tach board tu prefix
  const board = ticker.split(':')[0].toUpperCase();
  const LIMIT_MAP = { HOSE: 0.07, HSX: 0.07, HNX: 0.10, UPCOM: 0.15, UPCOMVN: 0.15 };
  const limit = LIMIT_MAP[board] ?? null;

  // (A) price_limit
  let price_limit;
  if (limit === null) {
    price_limit = { board: null };
  } else {
    const limitPct = Math.round(limit * 1000) / 10;
    const refBar = bars[n - 2];
    if (refBar != null) {
      const ref = refBar.close;
      const ceiling = Math.round(ref * (1 + limit));
      const floor = Math.round(ref * (1 - limit));
      const pctFromRef = Math.round((price - ref) / ref * 1000) / 10;
      const distToCeilingPct = Math.round((ceiling - price) / price * 1000) / 10;
      const ceilingRisk = pctFromRef >= limit * 100 * NEAR_LIMIT;
      const floorRisk = pctFromRef <= -limit * 100 * NEAR_LIMIT;
      price_limit = {
        board, limit_pct: limitPct, ref, ceiling, floor,
        pct_from_ref: pctFromRef, dist_to_ceiling_pct: distToCeilingPct,
        ceiling_risk: ceilingRisk, floor_risk: floorRisk,
      };
    } else {
      price_limit = { board, limit_pct: limitPct, note: 'thieu nen tham chieu' };
    }
  }

  // (B) adtv_20_bn — gia tri giao dich TB 20 nen, quy ty VND
  let adtv_20_bn = null;
  const last20 = bars.slice(-20);
  if (last20.length > 0) {
    const sum = last20.reduce((acc, b) => acc + b.close * b.volume, 0);
    adtv_20_bn = Math.round(sum / last20.length / 1e9 * 10) / 10;
  }

  // (C) days_to_vn30f_expiry — thu Nam tuan thu 3 hang thang
  const today = bars[n - 1] ? new Date(bars[n - 1].time * 1000) : new Date();
  const thirdThursday = (year, month) => {
    const first = new Date(year, month, 1);
    const firstThu = 1 + ((4 - first.getDay() + 7) % 7);
    return new Date(year, month, firstThu + 14);
  };
  let expiry = thirdThursday(today.getFullYear(), today.getMonth());
  if (today > expiry) {
    let nextMonth = today.getMonth() + 1;
    let nextYear = today.getFullYear();
    if (nextMonth > 11) { nextMonth = 0; nextYear++; }
    expiry = thirdThursday(nextYear, nextMonth);
  }
  const days_to_vn30f_expiry = Math.ceil((expiry - today) / 86400000);

  // --- RS vs VNINDEX (doc cache scan_live ghi; cu >36h -> null, chay /scan de lam moi) ---
  const idxCache = readVnindexCache();
  const rs = (idxCache && idxCache.fresh)
    ? computeRS(bars, idxCache.closes)
    : { rs_20: null, leader: null, note: idxCache ? 'cache VNINDEX cu, chay /scan' : 'chua co cache, chay /scan' };

  // --- MTF score ---
  let mtfScore = 0;
  const mtfNotes = [];
  // W/D bull: price > sma20 > sma100
  if (sma20_current && sma100_current && sma20_current > sma100_current) { mtfScore += 1; mtfNotes.push('SMA_BULL+1'); }
  if (structure === 'UPTREND')   { mtfScore += 1; mtfNotes.push('D_UPTREND+1'); }
  if (structure === 'DOWNTREND') { mtfScore -= 2; mtfNotes.push('D_DOWNTREND-2'); }

  // --- Huong (BiDir): tu fp.bias. null = ban cu long-only ---
  const dir = fp.bias === 1 ? 'LONG' : fp.bias === -1 ? 'SHORT' : fp.bias === 0 ? 'NEUTRAL' : 'LONG_ONLY';

  // --- Kich ban phu tu dong (bo qua buoc 6e thu cong) ---
  // Tim nen cau manh 1 lan: dung cho ca SL nhanh IMPULSE va nhanh continuation-retest (structure != UPTREND)
  const db = findDemandBar(bars, n, avgVol20);
  const scenarios = buildScenarios(structure, wave, overhead, dir, db ? db.shelf : null);
  if (!scenarios.some(s => s.label === 'retest') && db) {
    // D-0 chua dong -> chot theo nen D-1 (gia close + vol ratio cua no), khong an gia/vol nen dang chay
    const scenVol = barClosed ? vol_state.ratio_last : (prev_closed[0]?.vol_ratio ?? vol_state.ratio_last);
    const cr = contRetestScenario({
      shelf: db.shelf, zoneHi: db.zoneHi, price: decisionPrice,
      d0vol: scenVol, resistance: overhead.resistance, atr14, dir,
    });
    if (cr) scenarios.push(cr);
  }

  // --- Compact output (gate heavy diagnostics behind --full) ---
  const fpOut = { ...fp, score: fpScore, checks: fpChecks };
  if (!FULL) { delete fpOut.buyVol; delete fpOut.sellVol; delete fpOut.totalVol; }
  if (!FULL) { delete wave.amp_prev; delete wave.amp_prev_pct; }

  const out = {
    ticker, price, timeframe, tf_confirmed: tfOk, dir,
    symbol_confirmed: ok,
    as_of: new Date().toISOString(),
    date: bars[n-1]?.time ? new Date(bars[n-1].time * 1000).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
    ohlc_today: { o: todayBar?.open, h: todayBar?.high, l: todayBar?.low, c: todayBar?.close, vol: todayBar?.volume },
    ma: { sma20: sma20_current, sma100: sma100_current },
    fp: fpOut,
    fp_table_summary: FULL ? tableRows : undefined,
    structure,
    wave,
    trail: { ...trail, sma20_current },
    vol5,
    vol_state,
    spread: spreadOut,
    bar_read,
    bar,
    prev_closed,
    vsa_churn,
    topbot,
    price_limit,
    adtv_20_bn,
    days_to_vn30f_expiry,
    overhead,
    scenarios,
    rs,
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
export { buildScenarios, contRetestScenario, findDemandBar };

// Chi chay engine khi goi truc tiep (node check_one.mjs ...), khong khi bi import vao test.
if ((process.argv[1] || '').replace(/\\/g, '/').endsWith('check_one.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
