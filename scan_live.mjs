/**
 * scan_live.mjs Ã¢â‚¬â€ Scan current VN watchlist qua TradingView CDP (H6)
 * Doc du lieu truc tiep tu Footprint + PP PRO indicators
 * Run: node scan_live.mjs
 */

import * as chart from './src/core/chart.js';
import * as data from './src/core/data.js';
import { getClient } from './src/connection.js';
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { computeRS, writeVnindexCache, VNINDEX_SYM } from './rs_util.mjs';

// Evening Scout feed: scan_live ghi ket qua footprint cho morning brief (scout_promote.py doc file nay)
const requiredEnv = name => {
  if (!process.env[name]) throw new Error(`Missing ${name}; run via cos.py scan-live`);
  return process.env[name];
};
const SCOUT_SCAN_PATH = requiredEnv('SCOUT_SCAN_PATH');
const SCAN_LATEST_PATH = requiredEnv('SCAN_LATEST_PATH');
const SCAN_CANDIDATES_PATH = requiredEnv('SCAN_CANDIDATES_PATH');
const COS_PATH = requiredEnv('CLAUDE_OS_COS');
const FOREIGN_LATEST_PATH = requiredEnv('FOREIGN_LATEST_PATH');
const REGIME_LATEST_PATH = requiredEnv('REGIME_LATEST_PATH');
const SECTOR_MAP_PATH = requiredEnv('SECTOR_MAP_PATH');
const PYTHON_EXECUTABLE = requiredEnv('PYTHON_EXECUTABLE');

// Fallback neu decision watchlist loi/rong.
const FALLBACK_WATCHLIST = [
  { t: 'HOSE:GMD',  g: 1, name: 'GMD'  },
  { t: 'HOSE:ACB',  g: 1, name: 'ACB'  },
  { t: 'HOSE:VND',  g: 2, name: 'VND'  },
  { t: 'HOSE:OCB',  g: 2, name: 'OCB'  },
  { t: 'HOSE:HCM',  g: 3, name: 'HCM'  },
  { t: 'HOSE:NAB',  g: 0, name: 'NAB'  },
  { t: 'HOSE:TPB',  g: 0, name: 'TPB'  },
  { t: 'HOSE:SAB',  g: 0, name: 'SAB'  },
  { t: 'HOSE:SHS',  g: 0, name: 'SHS'  },
];

function exchangePrefix(raw) {
  const ex = (raw || '').toUpperCase();
  if (ex === 'HSX' || ex === 'HOSE') return 'HOSE';
  if (ex === 'HNX') return 'HNX';
  if (ex === 'UPCOM') return 'UPCOM';
  return 'HOSE';
}

function loadExchangeMap() {
  try {
    const payload = JSON.parse(readFileSync(FOREIGN_LATEST_PATH, 'utf-8'));
    const rows = payload.data || {};
    return Object.fromEntries(Object.entries(rows).map(([ticker, row]) => [
      ticker.toUpperCase(),
      exchangePrefix(row?.exchange),
    ]));
  } catch {
    return {};
  }
}

function loadWatchlist() {
  try {
    const payload = JSON.parse(readFileSync(SCAN_CANDIDATES_PATH, 'utf-8'));
    if (Array.isArray(payload.candidates) && payload.candidates.length > 0) {
      return payload.candidates.map(row => {
        const name = String(row.ticker).toUpperCase();
        return { t: exchangePrefix(row.exchange) + ':' + name, g: 0, name };
      });
    }
  } catch {}
  try {
    const output = execFileSync(PYTHON_EXECUTABLE, [COS_PATH, 'decision', 'watchlist'], { encoding: 'utf-8' });
    const rows = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length === 0) return FALLBACK_WATCHLIST;
    const exchanges = loadExchangeMap();
    return rows
      .filter(row => row && row.ticker)
      .map(row => {
        const name = String(row.ticker).toUpperCase();
        const ex = exchanges[name] || 'HOSE';
        return { t: ex + ':' + name, g: row.group_num ?? 0, name };
      });
  } catch (e) {
    console.error('decision watchlist failed, fallback hardcoded:', e.message);
    return FALLBACK_WATCHLIST;
  }
}

const MARKET_ADJ = { RISK_ON: 5, NEUTRAL: -5, RISK_OFF: -15 };

function loadMarketRegime() {
  try {
    const payload = JSON.parse(readFileSync(REGIME_LATEST_PATH, 'utf-8'));
    const raw = String(payload.date || '');
    const date = /^\d{8}$/.test(raw)
      ? new Date(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8)))
      : new Date(raw);
    const ageDays = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (!Number.isFinite(ageDays) || ageDays > 2) return { regime: 'N/A', note: 'regime stale/missing; gate skipped' };
    return { regime: payload.regime || 'N/A', note: null };
  } catch {
    return { regime: 'N/A', note: 'regime stale/missing; gate skipped' };
  }
}

function applyRegimeGate(result, regime) {
  const adj = MARKET_ADJ[regime] || 0;
  result.scored.pct = Math.round(Math.max(0, Math.min(100, result.scored.pct + adj)) * 10) / 10;
  result.scored.market_regime = regime;
  result.scored.market_adj = adj;
  result.scored.regime_note = null;
  if (regime === 'RISK_OFF' && result.scored.sig === 'BUY') {
    result.scored.sig = 'WATCH';
    result.scored.regime_note = 'RISK_OFF: BUY->WATCH';
  }
  return result;
}

function loadHeat() {
  try {
    return JSON.parse(execFileSync(PYTHON_EXECUTABLE, [COS_PATH, 'heat', '--json'], { encoding: 'utf-8' }));
  } catch (e) {
    return { status: 'N/A', warnings: ['heat unavailable: ' + e.message] };
  }
}

function sectorWarnings(results) {
  let sectors = {};
  try { sectors = JSON.parse(readFileSync(SECTOR_MAP_PATH, 'utf-8')); } catch {}
  const buys = {};
  for (const result of results) {
    result.sector = sectors[result.name] || 'Unknown';
    if (result.sig === 'BUY' && result.sector !== 'Unknown') {
      (buys[result.sector] ||= []).push(result.name);
    }
  }
  return Object.entries(buys)
    .filter(([, tickers]) => tickers.length > 2)
    .map(([sector, tickers]) => `Sector cluster ${sector}: ${tickers.join(',')} = one correlated bet`);
}

// CLI args: node scan_live.mjs FPT SAB -> scan ad-hoc thay vi WATCHLIST
const argSymbols = process.argv.slice(2).filter(a => /^[A-Za-z0-9:]+$/.test(a));
const SCAN_LIST = argSymbols.length > 0
  ? argSymbols.map(s => {
      const sym = s.toUpperCase();
      return { t: sym.includes(':') ? sym : 'HOSE:' + sym, g: 0, name: sym.split(':').pop() };
    })
  : loadWatchlist();

const GROUP_LABEL = { 0: 'ADHOC', 1: 'PP+SW', 2: 'PP only', 3: 'SW only' };
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseNum(val) {
  if (val == null || val === 'Ã¢Ë†â€¦' || val === '') return null;
  const s = val.toString().replace(/[,\s]/g, '').replace('Ã¢Ë†â€™', '-');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// --- Nguong volume THONG NHAT toan he thong (xem hermes_volume_consistency_plan.md) ---
const BREAKOUT_VOL = 1.5;   // vol nen pha >= 1.5x avgVol20 -> xac nhan breakout
const PULLBACK_VOL = 0.5;   // vol nen <0.5x avgVol20 -> can cung (pullback lanh)

// --- Helpers port tu check_one.mjs de tinh wave.phase (giu dong bo 1 nguon) ---
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function findPivots(bars, w = 3) {
  const ph = [], pl = [];
  for (let i = w; i < bars.length - w; i++) {
    const hi = bars[i].high, lo = bars[i].low;
    let isPH = true, isPL = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (bars[j].high >= hi) isPH = false;
      if (bars[j].low  <= lo) isPL = false;
    }
    if (isPH) ph.push({ i, price: hi });
    if (isPL) pl.push({ i, price: lo });
  }
  return { ph: ph.slice(-3).reverse(), pl: pl.slice(-3).reverse() };
}
function marketStructure(ph, pl) {
  if (ph.length < 2 || pl.length < 2) return 'INSUFFICIENT_DATA';
  if (ph[0].price > ph[1].price && pl[0].price > pl[1].price) return 'UPTREND';
  if (ph[0].price < ph[1].price && pl[0].price < pl[1].price) return 'DOWNTREND';
  if (ph[0].price > ph[1].price && pl[0].price < pl[1].price) return 'EXPANDING';
  return 'CONTRACTING';
}
// Tra { phase, vol_ratio } — phase khop logic check_one.mjs (PULLBACK/IMPULSE/DOWNTREND/SIDEWAYS)
function computeWave(bars, price) {
  if (!bars || bars.length < 25) return { phase: 'UNKNOWN', vol_ratio: null };
  const { ph, pl } = findPivots(bars, 3);
  const structure = marketStructure(ph, pl);
  let phase = 'SIDEWAYS';
  if (structure === 'UPTREND' && ph.length >= 1 && pl.length >= 2) {
    phase = price < ph[0].price ? 'PULLBACK' : 'IMPULSE';
  } else if (structure === 'DOWNTREND') {
    phase = 'DOWNTREND';
  }
  const vols = bars.map(b => b.volume);
  const avgVol20 = sma(vols, 20);
  const vol_ratio = avgVol20 ? Math.round(bars[bars.length - 1].volume / avgVol20 * 100) / 100 : null;
  // VSA churn: no luc cao + dong yeu/mid + than nho (chom cung tai nen no-progress)
  let churn = false;
  const lb = bars[bars.length - 1];
  if (lb && lb.high > lb.low && vol_ratio !== null) {
    const spread = lb.high - lb.low;
    const closePos = (lb.close - lb.low) / spread * 100;
    const bodyPct = Math.abs(lb.close - lb.open) / spread * 100;
    churn = vol_ratio >= 1.2 && closePos <= 50 && bodyPct < 35;
  }
  return { phase, vol_ratio, churn };
}

function extractFP(studies) {
  const fp = {
    conf: null, cumDelta: null, buyVol: null, sellVol: null, totalVol: null,
    buyPct: null, divSignal: null, maxBuyStack: null, maxSellStack: null,
    pocHigh: null, pocLow: null, vah: null, val: null, verRatio: null,
    fpDelta: null,
  };
  const ma = { ma20: null, ma100: null, ppSignal: null };
  let price = null;

  for (const s of studies) {
    const v = s.values;
    if (s.name.includes('Footprint Aggressor')) {
      fp.conf         = parseNum(v['Confluence']);
      fp.cumDelta     = parseNum(v['Cum Delta']);
      fp.buyVol       = parseNum(v['FP Buy Vol']);
      fp.sellVol      = parseNum(v['FP Sell Vol']);
      fp.totalVol     = parseNum(v['FP Total Vol']);
      fp.divSignal    = parseNum(v['Div Signal']);
      fp.maxBuyStack  = parseNum(v['Max Buy Stack']);
      fp.maxSellStack = parseNum(v['Max Sell Stack']);
      fp.pocHigh      = parseNum(v['FP POC High']);
      fp.pocLow       = parseNum(v['FP POC Low']);
      fp.vah          = parseNum(v['FP VAH']);
      fp.val          = parseNum(v['FP VAL']);
      fp.verRatio     = parseNum(v['VER Ratio']);
      fp.fpDelta      = parseNum(v['FP Delta']);
      if (fp.totalVol > 0 && fp.buyVol !== null)
        fp.buyPct = Math.round(fp.buyVol / fp.totalVol * 100);
    }
    if (s.name.includes('Pocket Pivot PRO')) {
      ma.ma20     = parseNum(v['MA Nhanh (Tim)'] || v['MA Nhanh (TÃƒÂ­m)'] || v['MA Fast'] || v['MA Nhanh']);
      ma.ma100    = parseNum(v['MA Cham'] || v['MA ChÃ¡ÂºÂ­m'] || v['MA Slow'] || v['MA Macro']);
      ma.ppSignal = parseNum(v['Pocket Pivot PRO']);
    }
    // Fallback: lay gia tu Price Action GEM
    if (s.name.includes('Price Action GEM') && !ma.ma20) {
      ma.ma20  = parseNum(v['MA Fast']);
      ma.ma100 = parseNum(v['MA Slow']);
    }
  }

  return { fp, ma };
}

function parseFPTable(fpTableResult) {
  // Tra ve cac row tu Footprint table de hien thi
  if (!fpTableResult || !fpTableResult.studies || fpTableResult.studies.length === 0)
    return [];
  const rows = [];
  for (const s of fpTableResult.studies) {
    for (const tbl of s.tables || []) {
      rows.push(...(tbl.rows || []));
    }
  }
  return rows;
}

// phase/vol_ratio tu computeWave — scoreSignal PHAI khop pha (xem feedback_trigger_phase_match.md):
// pullback dung CAN-CUNG, breakout moi doi CAU-MUA-AP-DAO + vol >= BREAKOUT_VOL.
function scoreSignal(fp, ma, price, phase = 'UNKNOWN', vol_ratio = null, churn = false) {
  const c = {};

  // 1. Confluence >= 60
  c.conf = fp.conf !== null ? fp.conf >= 60 : null;
  // 2. Cum Delta > 0
  c.cumD = Number.isFinite(fp.cumDelta) ? fp.cumDelta > 0 : null;
  // 3. Buy% >= 55%
  c.buyPct = fp.buyPct !== null ? fp.buyPct >= 55 : null;
  // 4. No Div Signal
  c.noDIV = fp.divSignal !== null ? fp.divSignal === 0 : null;
  // 5. IMB Buy Stack >= 1
  c.buyIMB = fp.maxBuyStack !== null ? fp.maxBuyStack >= 1 : null;
  // 6. Price > SMA20
  c.aboveMA20 = (price && ma.ma20) ? price > ma.ma20 : null;
  // 7. SMA20 > SMA100
  c.ma20vsMa100 = (ma.ma20 && ma.ma100) ? ma.ma20 > ma.ma100 : null;

  const known = Object.values(c).filter(v => v !== null);
  const passed = known.filter(v => v === true).length;
  const total  = known.length;
  const pct    = total > 0 ? Math.round(passed / Object.keys(c).length * 1000) / 10 : null;

  // Hard reject: Div TRUE + CumDelta < 0
  let sig = 'N/A';
  if (pct !== null) {
    if (fp.divSignal === 1 && fp.cumDelta !== null && fp.cumDelta < 0) sig = 'LOAI';
    else if (pct >= 71) sig = 'BUY';
    else if (pct >= 43) sig = 'WATCH';
    else sig = 'AVOID';
  }
  // CumDelta must-pass: dong tien am thi khong BUY du diem cao (swarm review 12/06)
  if (sig === 'BUY' && c.cumD === false) sig = 'WATCH';

  // --- PHASE-AWARE override (fix lo hong GMD v6 o duong batch) ---
  if (sig !== 'LOAI' && pct !== null) {
    if (phase === 'PULLBACK') {
      // Pullback lanh = CAN CUNG: cau truc nguyen (price>SMA20) + khong ban climactic (buyPct>=35)
      // + cumD khong sup manh + vol can (neu do duoc). Momentum yeu o pullback la BINH THUONG ->
      // KHONG day xuong AVOID, giu o WATCH cho 1 micro buy-tick (batch khong thay intra-bar nen khong tu BUY).
      const structureOK   = c.aboveMA20 !== false;                       // chua thung SMA20
      const notClimactic  = fp.buyPct === null || fp.buyPct >= 35;        // delta khong climactic ban
      const cumNotCollapse= fp.cumDelta === null || fp.cumDelta >= 0 || c.aboveMA20 === true;
      const volExhausted  = vol_ratio === null || vol_ratio < PULLBACK_VOL; // can cung (neu co so)
      const healthyPB = structureOK && notClimactic && cumNotCollapse;
      if (healthyPB) {
        if (sig === 'AVOID') sig = 'WATCH';       // pullback lanh khong phai AVOID
        if (sig === 'BUY' && !volExhausted) sig = 'WATCH'; // breakout-vol o pullback = nghi ngo, cho retest
      }
      // pullback KHONG con can-cung (thung SMA20 / ban climactic) -> de momentum quyet (co the AVOID)
    } else if (phase === 'IMPULSE') {
      // Breakout that = momentum + VOL >= 1.5x. Vol yeu -> chua xac nhan pha, ha BUY ve WATCH (cho retest).
      if (sig === 'BUY' && vol_ratio !== null && vol_ratio < BREAKOUT_VOL) sig = 'WATCH';
    }
    // DOWNTREND / SIDEWAYS / UNKNOWN: giu nguyen logic momentum.
  }

  // VSA churn: no luc cao ma gia khong tien -> khong chase, ha BUY ve WATCH (cho delta xac nhan).
  if (sig === 'BUY' && churn) sig = 'WATCH';

  // Require at least 4 known criteria
  if (total < 4) sig = 'N/A';

  return { sig, pct, passed, total, c, phase, vol_ratio, churn };
}

function buildScoutResult(r, marketRegime) {
  return {
    ticker: r.name,
    signal: r.sig,
    score: r.scored?.pct ?? 0,
    conf: r.fp?.conf ?? null,
    cum_delta: r.fp?.cumDelta ?? null,
    buy_pct: r.fp?.buyPct ?? null,
    chg_pct: r.chg_pct ?? null,
    phase: r.phase ?? null,
    vol_ratio: r.vol_ratio ?? null,
    churn: r.churn ?? false,
    rs_20: r.rs?.rs_20 ?? null,
    leader: r.rs?.leader ?? null,
    div_signal: r.fp?.divSignal ?? null,
    max_buy_stack: r.fp?.maxBuyStack ?? null,
    price: r.price ?? null,
    sma20: r.ma?.ma20 ?? null,
    sma100: r.ma?.ma100 ?? null,
    above_ma20: r.scored?.c?.aboveMA20 ?? null,
    ma20_slope_ok: r.scored?.c?.ma20vsMa100 ?? null,
    market_regime: r.scored?.market_regime ?? marketRegime.regime,
    market_adj: r.scored?.market_adj ?? 0,
    regime_note: r.scored?.regime_note ?? marketRegime.note,
    sector: r.sector,
  };
}

function fmtNum(n, decimals = 0) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return n.toFixed(decimals);
}

function computeBreadth(results) {
  const scanned = results.filter(r => !r.error && r.price != null);
  const up = scanned.filter(r => (r.chg_pct ?? 0) > 0).length;
  const down = scanned.filter(r => (r.chg_pct ?? 0) < 0).length;
  const pct_up = scanned.length > 0 ? Math.round(up / scanned.length * 1000) / 10 : null;
  return { up, down, pct_up };
}

async function scanOne(ticker, name, idxCloses) {
  // Set symbol
  try {
    await chart.setSymbol({ symbol: ticker });
  } catch(e) {
    return { error: 'setSymbol: ' + e.message };
  }

  // Poll until chart symbol actually changes (max 6s)
  const shortTicker = ticker.split(':').pop();
  let confirmed = false;
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    try {
      const st = await chart.getState();
      const curSym = (st.symbol || '').split(':').pop().toUpperCase();
      if (curSym === shortTicker.toUpperCase()) { confirmed = true; break; }
    } catch(e) {}
  }
  if (!confirmed) {
    // extra wait
    await sleep(1500);
  }
  // Extra wait for Footprint indicator to reload data
  await sleep(1500);

  // Read data in parallel (OHLCV de tinh wave.phase — port full tu check_one.mjs)
  let sv, fpTbl, q, ohlcv;
  try {
    [sv, fpTbl, q, ohlcv] = await Promise.all([
      data.getStudyValues().catch(()=>({ studies: [] })),
      data.getPineTables({ study_filter: 'Footprint' }).catch(()=>({ studies: [] })),
      data.getQuote({}).catch(()=>({})),
      data.getOhlcv({ count: 65 }).catch(()=>({ bars: [] })),
    ]);
  } catch(e) {
    return { error: 'read data: ' + e.message };
  }

  const price = q.last || q.close || null;
  const chg_pct = q.open > 0 && q.close != null
    ? Math.round((q.close - q.open) / q.open * 1000) / 10
    : null;
  const { fp, ma } = extractFP(sv.studies || []);
  const tableRows = parseFPTable(fpTbl);
  const bars = (ohlcv.bars || []).slice(-65);
  const { phase, vol_ratio, churn } = computeWave(bars, price);
  const scored = scoreSignal(fp, ma, price, phase, vol_ratio, churn);
  const rs = idxCloses ? computeRS(bars, idxCloses) : { rs_20: null, leader: null };

  return { price, chg_pct, fp, ma, scored, tableRows, phase, vol_ratio, churn, rs };
}

async function main() {
  if (process.argv.includes('--print-watchlist')) {
    console.log(JSON.stringify(SCAN_LIST));
    process.exit(0);
  }
  if (process.argv.includes('--self-test-regime')) {
    const sample = applyRegimeGate({ scored: { sig: 'BUY', pct: 85 } }, 'RISK_OFF');
    console.log(JSON.stringify(sample));
    process.exit(sample.scored.sig === 'WATCH' && sample.scored.pct === 70 ? 0 : 1);
  }
  if (process.argv.includes('--self-test-sector')) {
    const sample = ['ACB', 'MBB', 'TCB', 'VCB'].map(name => ({ name, sig: 'BUY' }));
    const warnings = sectorWarnings(sample);
    console.log(JSON.stringify({ results: sample, warnings }));
    process.exit(warnings.length === 1 ? 0 : 1);
  }
  if (process.argv.includes('--self-test-missing-footprint')) {
    const fp = { conf: 80, cumDelta: null, buyPct: 60, divSignal: 0, maxBuyStack: 1 };
    const ma = { ma20: 100, ma100: 90 };
    const scored = scoreSignal(fp, ma, 110);
    const zeroDelta = scoreSignal({ ...fp, cumDelta: 0 }, ma, 110);
    const result = buildScoutResult(
      { name: 'TEST', sig: scored.sig, scored, fp: {}, ma: {}, rs: {} },
      { regime: 'NEUTRAL', note: null },
    );
    console.log(JSON.stringify(result));
    const footprintNull = ['conf', 'cum_delta', 'buy_pct', 'max_buy_stack']
      .every(field => result[field] === null);
    process.exit(footprintNull && scored.sig === 'BUY' && zeroDelta.sig === 'WATCH' ? 0 : 1);
  }
  // Verify CDP
  try {
    await getClient();
  } catch(e) {
    console.error('CDP connection FAILED:', e.message);
    process.exit(1);
  }

  const initState = await chart.getState();
  console.log('Connected! Chart: ' + initState.symbol + ' | TF: ' + initState.resolution);
  if (initState.resolution !== '360') {
    console.log('WARNING: TF is not H6 (360). Scan results may be wrong!');
    console.log('Per user profile: MUST use H6 for VN stocks volume analysis');
  }
  console.log('Scanning ' + SCAN_LIST.length + ' ma...\n');

  // --- VNINDEX 1 lan dau de tinh RS (Relative Strength) + ghi cache cho check_one ---
  let idxCloses = null;
  try {
    await chart.setSymbol({ symbol: VNINDEX_SYM });
    for (let k = 0; k < 12; k++) {
      await sleep(500);
      const st = await chart.getState().catch(() => ({}));
      if ((st.symbol || '').toUpperCase().includes('VNINDEX')) break;
    }
    await sleep(1200);
    const idxOhlcv = await data.getOhlcv({ count: 65 }).catch(() => ({ bars: [] }));
    const closes = (idxOhlcv.bars || []).map(b => b.close).filter(c => c != null);
    if (closes.length >= 25) { idxCloses = closes; writeVnindexCache(closes); console.log('VNINDEX RS baseline OK (' + closes.length + ' bars)\n'); }
    else console.log('VNINDEX baseline thieu data -> RS=N/A\n');
  } catch (e) { console.log('VNINDEX fetch loi -> RS=N/A: ' + e.message + '\n'); }

  const marketRegime = loadMarketRegime();
  console.log('Market regime: ' + marketRegime.regime + (marketRegime.note ? ' | ' + marketRegime.note : ''));
  const results = [];

  for (let i = 0; i < SCAN_LIST.length; i++) {
    const { t, g, name } = SCAN_LIST[i];
    process.stdout.write('[' + (i+1) + '/' + SCAN_LIST.length + '] ' + name + '... ');
    const r = await scanOne(t, name, idxCloses);
    if (r.error) {
      console.log('ERROR: ' + r.error);
      results.push({ name, group: g, error: r.error, sig: 'ERR' });
      continue;
    }
    applyRegimeGate(r, marketRegime.regime);
    const sig = r.scored.sig;
    const pct = r.scored.pct;
    console.log(sig + (pct !== null ? ' (' + pct + '%)' : '') +
      ' | Conf:' + (r.fp.conf ?? 'N/A') +
      ' CumD:' + (r.fp.cumDelta !== null ? fmtNum(r.fp.cumDelta) : 'N/A') +
      ' Buy%:' + (r.fp.buyPct ?? 'N/A') +
      (r.fp.divSignal === 1 ? ' DIV!' : ''));
    results.push({ name, group: g, ...r, sig });
  }

  // Restore chart
  try { await chart.setSymbol({ symbol: initState.symbol }); } catch(e) {}

  // ---- OUTPUT ----
  const W = 80;
  const buy   = results.filter(r => r.sig === 'BUY').sort((a,b) => (b.scored?.pct||0)-(a.scored?.pct||0));
  const watch = results.filter(r => r.sig === 'WATCH').sort((a,b) => (b.scored?.pct||0)-(a.scored?.pct||0));
  const avoid = results.filter(r => r.sig === 'AVOID');
  const loai  = results.filter(r => r.sig === 'LOAI');
  const noData= results.filter(r => r.sig === 'N/A' || r.sig === 'ERR');
  const breadth = computeBreadth(results);
  const heat = loadHeat();
  const sectorClusterWarnings = sectorWarnings(results);

  // ---- PERSIST: scout_scan.json cho morning brief (0 token, headless) ----
  let persistOk = false;
  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const scoutPayload = {
      date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
      scan_time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      source: 'scan_live.mjs H6 Footprint',
      results: results.map(r => buildScoutResult(r, marketRegime)),
      breadth,
      market_regime: marketRegime,
      heat,
      sector_warnings: sectorClusterWarnings,
    };
    writeFileSync(SCOUT_SCAN_PATH, JSON.stringify(scoutPayload, null, 2), 'utf-8');
    writeFileSync(SCAN_LATEST_PATH, JSON.stringify(scoutPayload, null, 2), 'utf-8');
    execFileSync(PYTHON_EXECUTABLE, [COS_PATH, 'scan-persist', '--source', 'TradingView_H6'], {
      stdio: 'inherit',
    });
    persistOk = true;
  } catch (e) { console.error('scan persist failed; result is not brief/review safe:', e.message); }

  console.log('\n' + '='.repeat(W));
  console.log('  SCAN REPORT H6 | ' + new Date().toLocaleDateString('vi-VN') + ' | BUY:' + buy.length + ' WATCH:' + watch.length + ' AVOID:' + avoid.length + ' LOAI:' + loai.length);
  console.log('  Breadth: up ' + breadth.up + ' | down ' + breadth.down + ' | pct_up ' + (breadth.pct_up ?? 'N/A') + '%');
  console.log('  Regime: ' + marketRegime.regime + ' | Heat: ' + (heat.status || 'N/A') + ' (warning only)');
  console.log('='.repeat(W));

  function printHeader() {
    console.log('  ' + 'MA'.padEnd(6) + 'GRP'.padEnd(8) +
      'GIA'.padStart(9) + 'SCORE'.padStart(7) +
      'CONF'.padStart(6) + 'CUMD'.padStart(10) +
      'BUY%'.padStart(6) + 'DIV'.padStart(5) + 'BST'.padStart(5));
    console.log('  ' + '-'.repeat(70));
  }

  function printRow(r) {
    const fp = r.fp || {};
    const sc = r.scored || {};
    const price = r.price ? Math.round(r.price).toLocaleString() : '---';
    const conf  = fp.conf !== null && fp.conf !== undefined ? fp.conf.toString() : '---';
    const cumD  = fp.cumDelta !== null && fp.cumDelta !== undefined ? fmtNum(fp.cumDelta) : '---';
    const buyP  = fp.buyPct !== null && fp.buyPct !== undefined ? fp.buyPct + '%' : '---';
    const div   = fp.divSignal !== null && fp.divSignal !== undefined ? (fp.divSignal === 1 ? 'YES' : 'no') : '---';
    const bst   = fp.maxBuyStack !== null && fp.maxBuyStack !== undefined ? fp.maxBuyStack.toString() : '---';
    const score = sc.pct !== null && sc.pct !== undefined ? sc.pct + '%' : '---';
    const grp   = GROUP_LABEL[r.group] || '';
    console.log('  ' + r.name.padEnd(6) + grp.padEnd(8) +
      price.padStart(9) + score.padStart(7) +
      conf.padStart(6) + cumD.padStart(10) +
      buyP.padStart(6) + div.padStart(5) + bst.padStart(5));
  }

  function printSection(label, items) {
    if (items.length === 0) return;
    console.log('\n' + label + ' (' + items.length + ' ma)');
    printHeader();
    for (const r of items) printRow(r);
    // Show table for BUY signals
    if (label.includes('BUY')) {
      console.log('');
      for (const r of items) {
        if (!r.tableRows || r.tableRows.length === 0) continue;
        console.log('  --- ' + r.name + ' Footprint Table ---');
        for (const row of r.tableRows) console.log('    ' + row);
      }
    }
  }

  printSection('>>> BUY SIGNALS', buy);
  printSection('>>> WATCH', watch);

  if (avoid.length > 0) {
    console.log('\n>>> AVOID (' + avoid.length + ' ma)');
    console.log('  ' + avoid.map(r => r.name + '(' + (r.scored?.pct ?? '?') + '%)').join(', '));
  }
  if (loai.length > 0) {
    console.log('\n>>> LOAI NGAY (' + loai.length + ' ma)');
    for (const r of loai) {
      const fp = r.fp || {};
      console.log('  ' + r.name + ': DIV+CumDelta neg | CumD=' + fmtNum(fp.cumDelta) + ' Conf=' + fp.conf);
    }
  }
  if (noData.length > 0) {
    console.log('\n>>> KHONG DU DU LIEU (' + noData.length + ' ma): ' + noData.map(r=>r.name).join(', '));
  }
  for (const warning of heat.warnings || []) console.log('  HEAT WARNING: ' + warning);
  for (const warning of sectorClusterWarnings) console.log('  SECTOR WARNING: ' + warning);

  console.log('\n  Criteria: [Conf>=60][CumD>0][Buy%>=55][NoDIV][BuyIMB>=1][P>MA20][MA20>100]');
  console.log('  Data source: TradingView H6 Footprint Aggressor v2 (CDP real-time)');
  console.log('='.repeat(W));
  process.exit(persistOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
