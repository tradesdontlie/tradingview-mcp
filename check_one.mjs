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
import { barStatus, sessionInfo, entryWindow, lockedLtf } from './bar_status.mjs';
import { atomicWriteCache, cachePaths, evidenceHash, runtimeDataRoot, withChartLock } from './src/core/check_runtime.mjs';
import { extractPreviousMonthProfile, classifyMaAnchor } from './src/scan_policy.mjs';

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

// Gop bar H6 (~Daily, da loc vol thoa thuan) thanh nen tuan theo bucket 7 ngay (epoch-aligned).
function resampleWeekly(bars) {
  const wk = new Map();
  for (const b of bars) {
    const key = Math.floor(b.time / 604800); // 604800 = 7*86400s
    const w = wk.get(key);
    if (!w) wk.set(key, { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    else { w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; w.volume += b.volume || 0; }
  }
  return [...wk.values()].sort((a, b) => a.time - b.time);
}

// Trend khung tuan: UP/DOWN/SIDEWAYS tu structure tuan + gia vs SMA tuan.
function weeklyTrend(weekly) {
  const closes = weekly.map(b => b.close);
  const wN = weekly.length;
  const period = wN >= 20 ? 20 : 10;
  const smaW = sma(closes, period);
  const piv = findPivots(weekly, 2);
  const struct = marketStructure(piv.ph, piv.pl);
  let trend = 'SIDEWAYS';
  if (smaW != null) {
    const above = closes[wN - 1] > smaW;
    if (above && struct !== 'DOWNTREND') trend = 'UP';
    else if (!above && struct !== 'UPTREND') trend = 'DOWN';
  }
  return { trend, weeks: wN, sma_period: period,
    sma_w: smaW != null ? round2(smaW) : null, structure: struct,
    note: smaW == null ? 'thieu du lieu tuan' : (wN < 20 ? `chi ${wN} tuan (SMA${period}W)` : null) };
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
        invalidation: `dong cua lai duoi ${Math.round(r)} (breakout that bai)`,
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
        invalidation: `dong cua duoi ${Math.round(slBase)}`,
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
function contRetestScenario({ shelf, zoneHi, price, resistance, atr14, dir }) {
  if (dir === 'SHORT' || dir === 'NEUTRAL') return null;
  if (shelf == null || zoneHi == null || price == null) return null;
  // KHONG gate theo vol nen dang chay: "vol can" la dieu kien TRIGGER (o trigger text), khong phai dieu kien
  // de plan TON TAI. Gate vol o day lam scenario nhap nhay moi khi vol cat 1x -> rot ve plan cu (loi POW 14:53).
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
    invalidation: `dong cua duoi shelf ${lo}`,   // thesis chet khi DONG CUA duoi shelf; sl la cat cung (wick) rieng
    size_note: 'continuation retest, invalidation = dong duoi shelf' };
}

// Range breakout cho SIDEWAYS (CONTRACTING/EXPANDING): gia sat overhead -> nhanh chase neu DONG CUA tren overhead.
// Bo sung de SIDEWAYS co du 2 duong (retest tu contRetest + breakout o day), khong rot ve plan cu.
function rangeBreakoutScenario({ resistance, headroomPct, price, atr14, dir }) {
  if (dir === 'SHORT' || dir === 'NEUTRAL') return null;
  if (resistance == null || price == null) return null;
  if (headroomPct == null || headroomPct > 5) return null;   // overhead phai gan (<=5%) moi dang "cho breakout"
  if (price > resistance * 1.005) return null;               // da vuot ro -> khong phai pending breakout
  const atr = atr14 || price * 0.02;
  const entry = Math.round(resistance * 1.003);
  const sl = Math.round(resistance * 0.99);                   // ve lai trong range = breakout that bai
  const tp1 = Math.round(entry + 2 * atr);
  const tp2 = Math.round(entry + 3.5 * atr);
  if (!(sl < entry && entry < tp1)) return null;
  return { label: 'breakout', entry_low: entry, entry_high: entry, sl, tp1, tp2,
    trigger: `dong tren ${Math.round(resistance)} + vol>=1.5x`,
    invalidation: `dong cua lai duoi ${Math.round(resistance)} (breakout that bai)`,
    size_note: '1/2 size, chase' };
}

// VN unified setup classification with VSA whitelist/veto
const VSA_PULLBACK_OK = new Set(['TEST', 'NO_SUPPLY', 'SHAKEOUT', 'STOPPING_VOLUME']);
const VSA_BREAKOUT_OK = new Set(['SIGN_OF_STRENGTH', 'EFFORT_TO_RISE', 'ABSORPTION_RETEST']);
const VSA_VETO = new Set(['UPTHRUST', 'DISTRIBUTION', 'EFFORT_NO_RESULT']);

function classifyVnSetup({ price, sma20, sma100, pmPoc, pmVah, pmVal, structure, vsaPattern, fromLowPct, aboveSma100 }) {
  // No setup if price below SMA100
  if (!aboveSma100) return { setup: null, reason: 'price below SMA100', zone_low: null, zone_high: null, anchor: null };

  // Veto check: any VSA veto pattern blocks all setups
  if (vsaPattern && VSA_VETO.has(vsaPattern)) {
    return { setup: null, reason: `VSA veto: ${vsaPattern}`, zone_low: null, zone_high: null, anchor: null };
  }

  const sma20Dist = sma20 != null ? Math.round((price - sma20) / sma20 * 10000) / 100 : null;
  const sma100Dist = sma100 != null ? Math.round((price - sma100) / sma100 * 10000) / 100 : null;

  // Priority order — most specific first

  // 1. BREAKOUT_RETEST: requires proof of breakout (fromLowPct >= 5%) AND retest (price pulled back to within 3% of recent swing)
  // fromLowPct measures distance from recent 10-bar low
  if (fromLowPct != null && fromLowPct >= 5 && vsaPattern && VSA_BREAKOUT_OK.has(vsaPattern)) {
    return {
      setup: 'BREAKOUT_RETEST',
      zone_low: Math.round(price * 0.99),
      zone_high: Math.round(price * 1.01),
      anchor: sma20Dist != null && Math.abs(sma20Dist) <= 3 ? 'sma20' : 'sma100',
      reason: `Breakout + retest (tu day +${fromLowPct}%, VSA: ${vsaPattern})`,
    };
  }

  // 2. PM_VAH_PULLBACK_RETEST: price at VAH, pullback from above VAH
  if (pmVah != null && price >= pmVah * 0.97 && price <= pmVah * 1.03 && price <= pmVah) {
    return {
      setup: 'PM_VAH_PULLBACK_RETEST',
      zone_low: Math.round(pmVah * 0.98),
      zone_high: Math.round(pmVah),
      anchor: 'pm_vah',
      reason: `PM VAH retest (VAH=${pmVah}, pullback tu tren VAH)`,
    };
  }

  // 3. PM_VAL_PULLBACK_RECLAIM: price reclaimed VAL from below
  if (pmVal != null && price >= pmVal * 0.97 && price <= pmVal * 1.05 && price >= pmVal) {
    return {
      setup: 'PM_VAL_PULLBACK_RECLAIM',
      zone_low: Math.round(pmVal),
      zone_high: Math.round(Math.min(pmVal * 1.03, pmVah || Infinity)),
      anchor: 'pm_val',
      reason: `PM VAL reclaim (VAL=${pmVal}, phuc hoi tu duoi VAL)`,
    };
  }

  // 4. SMA20_PULLBACK: near SMA20, uptrend
  if (sma20Dist != null && Math.abs(sma20Dist) <= 3 && structure === 'UPTREND') {
    return {
      setup: 'SMA20_PULLBACK',
      zone_low: Math.round(sma20 * 0.99),
      zone_high: Math.round(sma20 * 1.01),
      anchor: 'sma20',
      reason: `Gia quanh SMA20 (cach ${sma20Dist}%), pullback trong uptrend`,
    };
  }

  // 5. SMA100_PULLBACK_RECLAIM: above SMA100, SMA20 far
  if (sma100Dist != null && sma100Dist <= 5 && sma20Dist != null && Math.abs(sma20Dist) > 3) {
    return {
      setup: 'SMA100_PULLBACK_RECLAIM',
      zone_low: Math.round(sma100 * 0.99),
      zone_high: Math.round(sma100 * 1.02),
      anchor: 'sma100',
      reason: `Gia tren SMA100 (cach ${sma100Dist}%), SMA20 con xa`,
    };
  }

  return { setup: null, reason: 'khong co setup phu hop', zone_low: null, zone_high: null, anchor: null };
}

// Geometry only. Promotion to READY belongs to the deterministic readiness gate.
export function computeDecision(scenarios, price) {
  if (!scenarios || scenarios.length === 0) {
    return { setup_state: 'NO_SETUP', reason: 'khong co kich ban long kha thi', setup: null };
  }
  const inZone = scenarios.find(s =>
    price >= Math.min(s.entry_low, s.entry_high) && price <= Math.max(s.entry_low, s.entry_high));
  if (inZone) {
    return { setup_state: 'IN_ZONE', reason: `gia trong entry zone (${inZone.label})`, setup: inZone.label };
  }
  return { setup_state: 'NEAR_ZONE', reason: `co setup ${scenarios[0].label}, cho trigger`, setup: scenarios[0].label };
}

// T+2.5 (chi VN stock): mua xong ~2.5 phien hang chua ve, KHONG ban duoc -> SL gan chi la muc bao dong.
// Annotate MAY MOC vao tung scenario (skill/bot khoi tinh tay): sl_atr = khoang SL theo boi ATR,
// rr_locked = RR neu phai thoat theo nhieu cua so khoa (1.6 ATR ~ sqrt(2.5) phien), tplus_warn khi SL trong nhieu.
// XAUUSD / VN30F (co '!') khong co T+ -> tra null, khong cham scenario.
export const TPLUS_ATR_FLOOR = 1.6;
export function annotateTplus(scenarios, { atr14, price, ticker }) {
  const isVnStock = /^(HOSE|HNX|UPCOM):/i.test(ticker || '') && !(ticker || '').includes('!');
  if (!isVnStock || !atr14 || !price) return null;
  for (const s of (scenarios || [])) {
    if (!s.entry_high || !s.sl) continue;
    s.sl_atr = round2((s.entry_high - s.sl) / atr14);
    if (s.tp1) s.rr_locked = round2((s.tp1 - s.entry_high) / (TPLUS_ATR_FLOOR * atr14));
    if (s.sl_atr < TPLUS_ATR_FLOOR) {
      s.tplus_warn = `SL ${s.sl_atr}xATR < ${TPLUS_ATR_FLOOR}x nhieu T+ -> size theo floor, vao 1/2 truoc + 1/2 sau khi hang ve`;
    }
  }
  return {
    lock_sessions: 2.5,
    atr_pct: round2(100 * atr14 / price),
    floor_pct: round2(100 * TPLUS_ATR_FLOOR * atr14 / price),
    exit_rule: 'dong cua duoi invalidation khi hang chua ve -> dat ban phien chieu T+2 (ATC neu can), khong cho hoi ve SL',
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

const known = values => values.every(value => value !== null && value !== undefined);
export function phaseEvidence({ volRatio, closePos, conf, buyPct, buyStack, churn,
  resistance, price, wideDownCloseLow, cumDelta, previousCumDelta }) {
  const supplyDry = known([volRatio, buyPct, wideDownCloseLow])
    ? volRatio < 1 && buyPct >= 35 && !wideDownCloseLow : null;
  const microConfirm = known([buyPct, resistance, price])
    ? buyPct > 50 || price > resistance : null;
  const absorption = known([volRatio, closePos, buyPct, churn, cumDelta])
    ? volRatio >= 1 && closePos >= 50 && buyPct > 50 && !churn && cumDelta > 0 : null;
  const deltaFlip = known([previousCumDelta, cumDelta])
    ? previousCumDelta <= 0 && cumDelta > 0 : null;
  return {
    breakout: { closed_above: known([resistance, price]) ? price > resistance : null,
      volume_ratio: volRatio, close_position_pct: closePos, footprint_confidence: conf,
      buy_pct: buyPct, buy_stack: buyStack, churn },
    retest: { supply_dry: supplyDry, micro_confirm: microConfirm, volume_ratio: volRatio, buy_pct: buyPct, wide_down_close_low: wideDownCloseLow },
    range: { absorption, delta_flip: deltaFlip, churn },
  };
}

export function buildCacheEnvelope(payload, generatedAt = new Date().toISOString()) {
  const marketDate = payload.market_date || payload.date || generatedAt.slice(0, 10);
  return { ...payload, schema_version: 1, market_date: marketDate,
    generated_at: generatedAt, date: marketDate, as_of: generatedAt };
}

export async function restoreChartState(chartApi, initialState) {
  if (!initialState) return;
  if (initialState.symbol) await chartApi.setSymbol({ symbol: initialState.symbol });
  if (initialState.resolution) await chartApi.setTimeframe({ timeframe: initialState.resolution });
}

export async function withChartLifecycle(dataRoot, ticker, timeframe, operation) {
  return withChartLock(dataRoot, ticker, timeframe, 180000, operation);
}

async function main() {
  let ticker = process.argv[2] || 'HOSE:OCB';
  const timeframe = process.argv[3] || defaultTf(ticker);
  const shortName = ticker.split(':').pop();
  const cacheDir = runtimeDataRoot();

  try { await getClient(); } catch(e) { console.error('CDP FAIL:', e.message); process.exit(1); }
  return withChartLifecycle(cacheDir, ticker, timeframe, async () => {
  let initState;
  try {
  initState = await chart.getState();

  // VN stock: prefix HOSE co the sai (SHS o HNX) -> resolve dung san qua TradingView symbol search REST,
  // tranh ban symbol invalid len chart (gay ket UI). Non-VN / search khong thay -> giu ticker goc.
  const VN_BOARDS = ['HOSE', 'HSX', 'HNX', 'UPCOM'];
  const givenBoard = ticker.includes(':') ? ticker.split(':')[0].toUpperCase() : null;
  if (givenBoard && VN_BOARDS.includes(givenBoard)) {
    try {
      const sr = await chart.symbolSearch({ query: shortName });
      const matches = (sr.results || []).filter(x =>
        VN_BOARDS.includes((x.exchange || '').toUpperCase()) &&
        x.symbol.toUpperCase() === shortName.toUpperCase());
      // Duplicate tickers exist across VN boards (e.g. HNX:VN30 and HOSE:VN30).
      // Preserve the caller's explicit board before falling back to any match.
      const hit = matches.find(x =>
        (x.exchange || '').toUpperCase() === givenBoard) || matches[0];
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
  if (!ok) throw new Error(`SYMBOL_UNCONFIRMED:${ticker}`);
  if (!tfOk) throw new Error(`TIMEFRAME_UNCONFIRMED:${timeframe}`);
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
    data.getOhlcv({ count: 130 }).catch(() => ({})),  // 130 H6~Daily ~= 26 tuan (du SMA20W)
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
    throw new Error(`FOOTPRINT_MISSING: chart khong co 'Footprint Aggressor Analysis' cho ${ticker} @ TF ${timeframe}. Hay load dung layout (VN / XAUUSD / VN30F1M) roi chay lai.`);
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

  const allBars = ohlcv.bars || [];
  const bars = allBars.slice(-65);   // logic H6 giu nguyen 65 bar; weekly resample tu allBars
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

  // --- Session phase (VN HOSE) ---
  const isVnStock = /^(HOSE|HNX|UPCOM):/i.test(ticker || '') && !(ticker || '').includes('!');
  const sess = sessionInfo(new Date(), isVnStock ? 'VN' : 'N/A');
  const vol_ratio_age_adj = barClosed
    ? lastVolRatio                                      // nen dong roi -> ratio chinh xac
    : (bar.age_pct > 0 ? (lastVolRatio / (bar.age_pct / 100)) : null); // du phong ratio phia cuoi phien

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

  // --- HTF (khung tuan that, resample tu H6~Daily) ---
  const htf = weeklyTrend(resampleWeekly(allBars));

  // --- VSA No Demand / No Supply (co tho, KHONG gate) — dung lai cToday da co ---
  // No Demand: nen tang nhung vol thap + spread hep giua uptrend -> cau yeu.
  // No Supply: nen giam nhung vol thap + spread hep giua pullback/downtrend -> cung can.
  const trendUp = htf.trend === 'UP' || wave.phase === 'IMPULSE';
  const trendPullback = wave.phase === 'PULLBACK' || htf.trend === 'DOWN';
  const vsa_signals = {
    no_demand: { flag: !!(cToday.isUp && cToday.spreadClass === 'narrow' && lastVolRatio !== null && lastVolRatio < PULLBACK_VOL && trendUp) },
    no_supply: { flag: !!(cToday.isDown && cToday.spreadClass === 'narrow' && lastVolRatio !== null && lastVolRatio < PULLBACK_VOL && trendPullback) },
  };

  // --- MTF score: H6 (structure + SMA) + Weekly that ---
  let mtfScore = 0;
  const mtfNotes = [];
  if (sma20_current && sma100_current && sma20_current > sma100_current) { mtfScore += 1; mtfNotes.push('H6_SMA_BULL+1'); }
  if (structure === 'UPTREND')   { mtfScore += 1; mtfNotes.push('H6_UPTREND+1'); }
  if (structure === 'DOWNTREND') { mtfScore -= 2; mtfNotes.push('H6_DOWNTREND-2'); }
  if (htf.trend === 'UP')   { mtfScore += 1; mtfNotes.push('W_UP+1'); }
  if (htf.trend === 'DOWN') { mtfScore -= 2; mtfNotes.push('W_DOWN-2'); }

  // --- Huong (BiDir): tu fp.bias. null = ban cu long-only ---
  const dir = fp.bias === 1 ? 'LONG' : fp.bias === -1 ? 'SHORT' : fp.bias === 0 ? 'NEUTRAL' : 'LONG_ONLY';

  // --- Kich ban phu tu dong (bo qua buoc 6e thu cong) ---
  // Tim nen cau manh 1 lan: dung cho ca SL nhanh IMPULSE va nhanh continuation-retest (structure != UPTREND)
  const db = findDemandBar(bars, n, avgVol20);
  const scenarios = buildScenarios(structure, wave, overhead, dir, db ? db.shelf : null);
  if (!scenarios.some(s => s.label === 'retest') && db) {
    // retest = plan dung cau truc (shelf + vi tri gia), khong gate theo vol nen dang chay -> on dinh ca phien
    const cr = contRetestScenario({
      shelf: db.shelf, zoneHi: db.zoneHi, price,
      resistance: overhead.resistance, atr14, dir,
    });
    if (cr) scenarios.push(cr);
  }
  // SIDEWAYS sat overhead: them nhanh breakout (engine buildScenarios chi lam breakout cho UPTREND PULLBACK)
  if (!scenarios.some(s => s.label === 'breakout') && wave.phase === 'SIDEWAYS') {
    const bo = rangeBreakoutScenario({
      resistance: overhead.resistance, headroomPct: overhead.headroom_pct, price, atr14, dir,
    });
    if (bo) scenarios.push(bo);
  }

  // --- VN UNIFIED CHECK (replaces legacy VN scenario building) ---
  let vn = null;
  if (isVnStock) {
    // 1. Extract Auto Key Levels profile
    const pmProfile = extractPreviousMonthProfile({
      studies: sv.studies || [],
      expectedSymbol: ticker,
      marketDate: bars[n-1]?.time ? new Date(bars[n-1].time * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      observedAt: new Date().toISOString(),
      maxAgeSeconds: 7200,
    });

    // 2. H6 history: SMA, structure, protected low, Avg20 from COMPLETED bars only
    const completedCloses = barClosed ? closes : closes.slice(0, -1);
    const completedBars = barClosed ? bars : bars.slice(0, -1);
    const completedVolumes = completedBars.map(b => b.volume);
    const h6Avg20 = completedVolumes.length >= 20
      ? Math.round(completedVolumes.slice(-20).reduce((a, v) => a + v, 0) / 20)
      : null;

    // Protected low from completed bars
    const demandBar = findDemandBar(completedBars, completedBars.length, h6Avg20);
    const protectedLow = demandBar ? Math.round(demandBar.shelf) : null;

    // 3. H6 live: ONLY current candle data
    const volDelta = fp.buyVol != null && fp.sellVol != null ? fp.buyVol - fp.sellVol : null;
    const h6Live = {
      price: Math.round(price),
      location_vs_sma20: ma.ma20 ? Math.round((price - ma.ma20) / ma.ma20 * 10000) / 100 : null,
      location_vs_sma100: ma.ma100 ? Math.round((price - ma.ma100) / ma.ma100 * 10000) / 100 : null,
      range: todayBar ? Math.round(todayBar.high - todayBar.low) : null,
      range_atr,
      vol_ratio: lastVolRatio,
      vol_above_avg20: lastVolRatio != null && lastVolRatio >= 1.0,
      buy_pct: fp.buyPct,
      // Delta = bar Volume Delta (FP Buy Vol - FP Sell Vol), not cumDelta
      bar_vol_delta: volDelta,
      cum_delta: fp.cumD,
      delta_pct: fp.totalVol && volDelta != null && fp.totalVol > 0
        ? Math.round(volDelta / fp.totalVol * 10000) / 100 : null,
      buy_stack: fp.buyStack,
      sell_stack: fp.sellStack,
      divergence: fp.div,
      vsa_churn: vsa_churn.flag,
      vsa_signals: { no_demand: vsa_signals.no_demand.flag, no_supply: vsa_signals.no_supply.flag },
      footprint_conf: fp.conf,
    };

    // 4. MA anchor classification
    const aboveSma100 = ma.ma100 != null && price >= ma.ma100;
    const maAnchor = classifyMaAnchor({
      price,
      sma20: ma.ma20,
      sma100: ma.ma100,
      preferredAnchor: null,
      maxExtensionPct: 7,
    });

    // 5. fromLowPct — distance from recent 10-bar low (for BREAKOUT_RETEST)
    const recentLow = Math.min(...bars.slice(-10).map(b => b.low));
    const fromLowPct = recentLow > 0 ? Math.round((price - recentLow) / recentLow * 10000) / 100 : null;

    // 6. VSA pattern from topbot detection
    const vsaPattern = topbot?.pattern || null;

    // 7. Setup classification
    const setup = classifyVnSetup({
      price,
      sma20: ma.ma20,
      sma100: ma.ma100,
      pmPoc: pmProfile.valid ? pmProfile.poc : null,
      pmVah: pmProfile.valid ? pmProfile.vah : null,
      pmVal: pmProfile.valid ? pmProfile.val : null,
      structure,
      vsaPattern,
      fromLowPct,
      aboveSma100,
    });

    // 8. Entry window
    const win = entryWindow(new Date());

    // 9. Locked LTF (stub: real M5/M15/H1 bars require LTF data from chart)
    // When LTF bars with per-bar footprints are available, pass them here
    const ltfResult = lockedLtf({
      bars: [], // populated when LTF data with per-bar footprint is available
      timeframe: '15',
      expectedSymbol: ticker,
      now: new Date(),
      protectedLow,
    });

    // 10. Blockers for readiness
    const blockers = [];
    // PM Profile
    if (!pmProfile.valid && pmProfile.error?.includes('not found')) blockers.push('PM_PROFILE_MISSING');
    else if (!pmProfile.valid) blockers.push('PM_PROFILE_STALE');
    // MA gate
    if (maAnchor.blocker === 'BELOW_SMA100') blockers.push('BELOW_SMA100');
    else if (maAnchor.blocker === 'OVEREXTENDED') blockers.push('OVEREXTENDED');
    // Setup
    if (setup.setup == null) blockers.push('NO_SETUP');
    // Profile below SMA100 → block even if setup exists
    if (!aboveSma100) blockers.push('BELOW_SMA100');
    // H6 live context
    if (h6Live.vol_ratio == null) blockers.push('H6_VOLUME_EVIDENCE_MISSING');
    if (!barClosed && h6Live.vol_ratio != null && h6Live.vol_ratio < 0.5) blockers.push('H6_LIVE_CONTEXT_INVALID');
    // LTF
    if (ltfResult.locked === false && ltfResult.reason !== 'missing_data') {
      if (ltfResult.reason.includes('open')) blockers.push('LTF_OPEN');
      else if (ltfResult.reason.includes('bearish')) blockers.push('LTF_BEARISH_CONTRADICTION');
      else blockers.push('LTF_STABILITY_INSUFFICIENT');
    }
    // Entry window
    if (win.window === 'BLOCKED') blockers.push('ENTRY_WINDOW_BLOCKED');
    // VSA veto
    if (vsaPattern && (vsaPattern === 'UPTHRUST' || vsaPattern === 'BUYING_CLIMAX')) {
      blockers.push('H6_LIVE_VSA_UNCONFIRMED');
    }
    // Footprint
    if (fp.conf == null) blockers.push('FOOTPRINT_MISSING');
    else if (fp.div === 1) blockers.push('FOOTPRINT_BEARISH');

    // Setup state: IN_ZONE if setup exists and no hard blockers
    const hardBlockers = ['BELOW_SMA100', 'OVEREXTENDED', 'PM_PROFILE_MISSING', 'PM_PROFILE_STALE', 'NO_SETUP'];
    const hasHardBlocker = blockers.some(b => hardBlockers.includes(b));
    const setupState = setup.setup != null && !hasHardBlocker ? 'IN_ZONE' : setup.setup != null ? 'NEAR_ZONE' : 'NO_SETUP';

    // Entry window permission: only HIGH/NORMAL promote
    const windowOk = win.window === 'HIGH' || win.window === 'NORMAL';

    vn = {
      pm_profile: pmProfile.valid ? {
        source: pmProfile.source,
        symbol: pmProfile.symbol,
        market_date: pmProfile.market_date,
        profile_month: pmProfile.profile_month,
        poc: pmProfile.poc,
        vah: pmProfile.vah,
        val: pmProfile.val,
        observed_at: pmProfile.observed_at,
        complete: pmProfile.complete,
        stale: pmProfile.stale,
        evidence_hash_fields: pmProfile.evidence_hash_fields,
      } : { error: pmProfile.error },
      h6_history: {
        sma20: ma.ma20 ? Math.round(ma.ma20) : null,
        sma100: ma.ma100 ? Math.round(ma.ma100) : null,
        structure,
        protected_low: protectedLow,
        avg_vol_20: h6Avg20,
        bars_completed: completedBars.length,
      },
      h6_live: h6Live,
      ma_anchor: maAnchor,
      setup,
      locked_ltf: ltfResult,
      entry_window: win,
      exit_policy: {
        sl: protectedLow,
        trail: trail.status,
        note: protectedLow ? `Cat lo neu dong cua duoi ${protectedLow}` : 'Trailing SMA20',
      },
      blockers,
      setup_state: setupState,
      window_ok: windowOk,
    };
  }

  // T+2.5: annotate sl_atr/rr_locked/tplus_warn vao scenario + tplus top-level (null neu khong phai VN stock)
  const tplus = annotateTplus(scenarios, { atr14, price, ticker });

  // --- Compact output (gate heavy diagnostics behind --full) ---
  const fpOut = { ...fp, score: fpScore, checks: fpChecks };
  if (!FULL) { delete fpOut.buyVol; delete fpOut.sellVol; delete fpOut.totalVol; }
  if (!FULL) { delete wave.amp_prev; delete wave.amp_prev_pct; }

  const out = buildCacheEnvelope({
    ticker, price, timeframe, tf_confirmed: tfOk, dir,
    symbol_confirmed: ok,
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
    session: {
      phase: sess.phase,
      trust_level: sess.trust_level,
      age_pct: bar.age_pct,
      vol_ratio_age_adj,
      warnings: sess.warnings,
      next_phase: sess.next_phase,
      minutes_remaining: sess.minutes_remaining,
      phase_warning: sess.phase_warning,
    },
    vsa_churn,
    vsa_signals,
    topbot,
    price_limit,
    adtv_20_bn,
    days_to_vn30f_expiry,
    overhead,
    scenarios,
    setup_state: computeDecision(scenarios, price).setup_state,
    decision: computeDecision(scenarios, price),
    phase_evidence: phaseEvidence({ volRatio: lastVolRatio, closePos: fp.closePos, conf: fp.conf,
      buyPct: fp.buyPct, buyStack: fp.buyStack, churn: vsa_churn.flag,
      resistance: overhead.resistance ?? bars[n-2]?.high, price,
      wideDownCloseLow: cToday?.isDown && cToday?.spreadClass === 'wide' && (fp.closePos ?? 100) < 50,
      cumDelta: fp.cumD, previousCumDelta: null }),
    tplus,
    rs,
    htf,
    avg_vol20: Math.round(avgVol20 || 0),
    mtf: { score: mtfScore, notes: mtfNotes },
    pivots: {
      ph: ph.map(p => ({ price: p.price, d: `D-${n-1-p.i}` })),
      pl: pl.map(p => ({ price: p.price, d: `D-${n-1-p.i}` })),
    },
    vn,  // VN unified check (null for non-VN)
  });

  try {
    const cacheDate = out.date || new Date().toISOString().slice(0,10);
    out.evidence_hash = evidenceHash(out);
    const paths = cachePaths(cacheDir, shortName.toUpperCase(), timeframe);
    paths.dated = path.join(cacheDir, `check_${shortName.toUpperCase()}_${cacheDate.replace(/-/g, '')}_${timeframe}.json`);
    atomicWriteCache(paths, out);
  } catch (e) {
    throw new Error(`CACHE_WRITE_FAILED:${e.message}`);
  }

  console.log('DATA_JSON:' + JSON.stringify(out));
  return out;
  } finally {
    try { await restoreChartState(chart, initState); } catch(e) {}
  }
  });
}
export { buildScenarios, contRetestScenario, findDemandBar, rangeBreakoutScenario, resampleWeekly, weeklyTrend, classifyVnSetup };

// Chi chay engine khi goi truc tiep (node check_one.mjs ...), khong khi bi import vao test.
if ((process.argv[1] || '').replace(/\\/g, '/').endsWith('check_one.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
