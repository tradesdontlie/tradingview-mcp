#!/usr/bin/env node
/**
 * Walk-forward backtesting harness — futures bot configuration.
 *
 * Mirrors auto_trade_futures.mjs exactly:
 *   - No daily bias filter (futures trades both directions)
 *   - Kill-zone filter: only bars within London Open (07-10 UTC) or NY Open (13-16 UTC)
 *   - 15m Pinbar wired as a 6th execution signal
 *   - 4H pinbar bias exemption for divergence+levels counter-trend pair
 *   - 4H divergence + 4H pinbar bias filter (same as spot)
 *   - Ch.6 same-role guard (same as spot)
 *
 * Fetches 4 pages × 1000 = 4000 15m bars (~40 days) to compensate for
 * kill-zone filtering reducing the effective sample (~9 active hours/day).
 *
 * Usage:
 *   node scripts/run_backtest_futures.mjs
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { scanForDivergence, scanForCVDDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { detectZones, findZoneRetests, buildZoneTradePlan } = await import('../src/core/levels.js');
const { scanForFibReaction, buildFibTradePlan } = await import('../src/core/fibonacci.js');
const { detectMarketStructure, buildStructureTradePlan } = await import('../src/core/market_structure.js');
const { scanForPinbarSetup, buildPinbarTradePlan } = await import('../src/core/pinbar.js');
const {
  findDoubleTopBottom, scanForNecklineBreak, buildDoubleTopBottomTradePlan,
  findHeadAndShoulders, buildHeadAndShouldersTradePlan,
  findTriangle, scanForTriangleBreakout, buildTriangleTradePlan,
  findFlagPennant, scanForFlagBreakout, buildFlagTradePlan,
} = await import('../src/core/chart_patterns.js');
const { assessConfluence } = await import('../src/core/confluence.js');
const { classifyVWAPBias, classifyValueAreaBias } = await import('../src/core/volume_profile.js');

const SYMBOLS          = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL         = '15m';
const INTERVAL_HTF     = '4h';
const WINDOW_SIZE      = 150;
const HTF_WINDOW_SIZE  = 100;
const FRESHNESS_BARS   = 2;
const HTF_FRESHNESS_BARS = 3;
const RSI_PERIOD       = 14;
const CVD_WINDOW       = 14;    // rolling-window size for CVD divergence — same as auto_trade_futures.mjs
const MAX_HOLD         = 100;
let PAGES              = 4;     // 4 × 1000 = 4000 bars ≈ 40 days (kill-zone filter needs larger sample; override with --days=N)
let HTF_PAGES          = 2;     // 4H pages of 1000 bars — scaled with --days to cover the 15m window
// Round-trip taker fee per trade, charged on entry and exit. Binance USDM
// futures standard taker is 0.05%/side; override with --fee=0.0002 (maker) etc.
let FEE_RATE           = 0.0005;
// Minimum stop distance as a fraction of entry price. Setups with a tighter
// stop are skipped — a sub-0.5% stop on a 15m chart gets wicked out on noise and
// makes fees an unrealistically large fraction of risk. Override with --min-stop=0.003.
let MIN_STOP_PCT       = 0.005;
// Kill zones — London Open and NY Open (UTC hours)
const KILL_ZONES = [
  { startUtc: 7,  endUtc: 10 },
  { startUtc: 13, endUtc: 16 },
];

// ---- Mainnet public klines (no auth) ----------------------------------------

// Stablecoin/tokenized-asset bases that trade nearly flat against USDT —
// excluded from top-volume selection since their "win rates" are noise.
const STABLE_BASES = new Set([
  'USDC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'XAUT', 'PAXG', 'USDP', 'EURI',
]);

// Top-N USDT pairs by 24h quote volume (mainnet ticker, no auth). Used when
// --top-volume=N is passed to expand the symbol universe beyond BTC/ETH/BNB.
function fetchTopVolumeSymbols(count) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.binance.com',
      path: '/api/v3/ticker/24hr',
      agent: false,
      headers: { 'User-Agent': 'tradingview-mcp-backtest/1.0' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const symbols = JSON.parse(data)
            .filter(d => d.symbol.endsWith('USDT'))
            .filter(d => !STABLE_BASES.has(d.symbol.slice(0, -4)))
            .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
            .slice(0, count)
            .map(d => d.symbol);
          resolve(symbols);
        } catch (e) { reject(new Error(`Parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function fetchKlinesPage(symbol, interval, limit, endTime) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (endTime != null) params.set('endTime', String(endTime));
    https.get({
      hostname: 'api.binance.com',
      path: `/api/v3/klines?${params}`,
      agent: false,
      headers: { 'User-Agent': 'tradingview-mcp-backtest/1.0' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).map(k => ({
            open_time: k[0], open: Number(k[1]), high: Number(k[2]),
            low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), close_time: k[6], taker_buy_volume: Number(k[9]),
          })));
        } catch (e) { reject(new Error(`Parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchHistory(symbol, interval, pages, limitPerPage = 1000) {
  let allBars = [];
  let endTime = undefined;
  for (let p = 0; p < pages; p++) {
    let page;
    for (let attempt = 1; ; attempt++) {
      try { page = await fetchKlinesPage(symbol, interval, limitPerPage, endTime); break; }
      catch (e) {
        if (attempt >= 5) throw e;
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    if (!page.length) break;
    allBars = [...page, ...allBars];
    endTime = page[0].open_time - 1;
  }
  allBars.sort((a, b) => a.open_time - b.open_time);
  const now = Date.now();
  return allBars.filter(k => k.close_time <= now);
}

// ---- Signal detectors (mirrors auto_trade_futures.mjs) ----------------------

function findFreshSFPSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const bearishHits = scanForSFP(klines.slice(lastSwingHigh.index + 1), { level: lastSwingHigh.price, type: 'bearish' })
    .map(h => ({ ...h, index: h.index + lastSwingHigh.index + 1 }));
  const bullishHits = scanForSFP(klines.slice(lastSwingLow.index + 1), { level: lastSwingLow.price, type: 'bullish' })
    .map(h => ({ ...h, index: h.index + lastSwingLow.index + 1 }));
  const candidates = [
    ...bearishHits.map(hit => ({ hit, type: 'bearish', target: lastSwingLow.price, alt: rangeLow })),
    ...bullishHits.map(hit => ({ hit, type: 'bullish', target: lastSwingHigh.price, alt: rangeHigh })),
  ].filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.hit.index - a.hit.index);
  const { hit, type, target, alt } = candidates[0];
  const plan = buildSFPTradePlan({ hit, type, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'sfp', plan, confirmedAt: hit.bar.open_time,
    signalKey: `sfp:${type}:${hit.bar.open_time}`,
    summary: `${type} SFP (${hit.kind})` };
}

function findFreshDivergenceSignal(klines4h, ctx4h) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx4h;
  const candidates = [];
  for (const type of ['bullish', 'bearish']) {
    const result = scanForDivergence(klines4h, { type, rsiPeriod: RSI_PERIOD });
    if (result.divergence) candidates.push({ hit: result, type });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.newer_swing.index <= HTF_FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'divergence', plan, confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `4H ${hit.pattern} ${type} divergence` };
}

// Runs on 15m bars — mirrors auto_trade_futures.mjs's findFreshCVDDivergenceSignal
function findFreshCVDDivergenceSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const candidates = [];
  for (const type of ['bullish', 'bearish']) {
    const result = scanForCVDDivergence(klines, { type, cvdWindow: CVD_WINDOW });
    if (result.divergence) candidates.push({ hit: result, type });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.newer_swing.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'cvd_divergence', plan, confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `cvd_divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `15m ${hit.pattern} ${type} CVD divergence` };
}

function findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) {
  const { lastIndex } = ctx4h;
  const { hits } = scanForPinbarSetup(klines4h, { swingHighs: swingHighs4h, swingLows: swingLows4h });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > HTF_FRESHNESS_BARS) return null;
  return { direction: hit.direction };
}

function findFreshLevelZoneSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const zones = detectZones(klines);
  const candidates = [];
  for (const zone of zones) {
    const hits = findZoneRetests(klines, zone);
    if (hits.length) candidates.push({ zone, hit: hits[hits.length - 1], touchCount: hits.length });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.index - a.hit.index);
  const { zone, hit, touchCount } = fresh[0];
  const target = zone.type === 'support' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = zone.type === 'support' ? rangeHigh : rangeLow;
  const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: target, rangeLevel: alt });
  return { strategy: 'levels', plan, confirmedAt: hit.bar.open_time,
    signalKey: `levels:${zone.type}:${zone.classification}:${hit.bar.open_time}`,
    summary: `${zone.classification} ${zone.type} zone retest [${zone.low}-${zone.high}] (${hit.kind})`,
    hitKind: hit.kind,
    touchCount,
  };
}

function findFreshFibSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const { direction, hits } = scanForFibReaction(klines, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildFibTradePlan({ hit, direction, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'fibonacci', plan, confirmedAt: hit.bar.open_time,
    signalKey: `fibonacci:${direction}:${hit.bar.open_time}`,
    summary: `${direction} golden-pocket reaction (${hit.kind})` };
}

function findFreshStructureSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(klines, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;
  const realigning = choch.filter(c => c.direction === trend);
  if (!realigning.length) return null;
  const latest = realigning[realigning.length - 1];
  if (lastIndex - latest.index > FRESHNESS_BARS) return null;
  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: latest, trend, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'market_structure', plan, confirmedAt: latest.bar.open_time,
    signalKey: `market_structure:${trend}:choch${latest.sequenceNumber}:${latest.bar.open_time}`,
    summary: `${trend} BOS + realigning CHoCH#${latest.sequenceNumber}` };
}

function findFreshPinbarSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { hits } = scanForPinbarSetup(klines, { swingHighs, swingLows });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = hit.direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = hit.direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildPinbarTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'pinbar', plan, confirmedAt: hit.bar.open_time,
    signalKey: `pinbar:${hit.direction}:${hit.biasBar.open_time}:${hit.bar.open_time}`,
    summary: `${hit.direction} pinbar at swing extreme` };
}

function buildChartPatternPlan({ pattern, breakout, rangeLevel }) {
  switch (pattern.type) {
    case 'double_top':
    case 'double_bottom':
      return buildDoubleTopBottomTradePlan({ pattern, breakout, rangeLevel });
    case 'head_and_shoulders':
    case 'inverse_head_and_shoulders':
      return buildHeadAndShouldersTradePlan({ pattern, breakout, rangeLevel });
    case 'ascending_triangle':
    case 'descending_triangle':
    case 'symmetrical_triangle':
      return buildTriangleTradePlan({ triangle: pattern, breakout, rangeLevel });
    case 'flag_pennant':
      return buildFlagTradePlan({ pattern, breakout, rangeLevel });
    default:
      throw new Error(`unknown chart pattern type: ${pattern.type}`);
  }
}

function findFreshChartPatternSignal(klines, ctx, swingHighs, swingLows) {
  const { rangeHigh, rangeLow, lastIndex } = ctx;
  const candidates = [];

  for (const pattern of findDoubleTopBottom(klines, { swingHighs, swingLows })) {
    const breakout = scanForNecklineBreak(klines, pattern);
    if (breakout) candidates.push({ pattern, breakout });
  }
  for (const pattern of findHeadAndShoulders(klines, { swingHighs, swingLows })) {
    const breakout = scanForNecklineBreak(klines, pattern);
    if (breakout) candidates.push({ pattern, breakout });
  }
  const triangle = findTriangle(klines, { swingHighs, swingLows });
  if (triangle) {
    const breakout = scanForTriangleBreakout(klines, triangle);
    if (breakout) candidates.push({ pattern: triangle, breakout });
  }
  const flag = findFlagPennant(klines);
  if (flag) {
    const breakout = scanForFlagBreakout(klines, flag);
    if (breakout) candidates.push({ pattern: flag, breakout });
  }

  const fresh = candidates.filter(c => lastIndex - c.breakout.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;

  fresh.sort((a, b) => b.breakout.index - a.breakout.index);
  const { pattern, breakout } = fresh[0];
  const alt = pattern.side === 'long' ? rangeHigh : rangeLow;
  const plan = buildChartPatternPlan({ pattern, breakout, rangeLevel: alt });
  return {
    strategy: 'chart_pattern',
    plan,
    confirmedAt: breakout.bar.open_time,
    signalKey: `chart_pattern:${pattern.type}:${breakout.bar.open_time}`,
    summary: `${pattern.type.replace(/_/g, ' ')} breakout`,
  };
}

// ---- Outcome simulation ------------------------------------------------------

function simulateOutcome(allBars, { entry, stop, target, side, startIndex }) {
  const isLong = side === 'long';
  for (let i = startIndex + 1; i < allBars.length && i <= startIndex + MAX_HOLD; i++) {
    const close = allBars[i].close;
    if (isLong) {
      if (close >= target) return { outcome: 'win',  exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
      if (close <= stop)   return { outcome: 'loss', exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
    } else {
      if (close <= target) return { outcome: 'win',  exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
      if (close >= stop)   return { outcome: 'loss', exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
    }
  }
  return { outcome: 'open', exitIndex: null, exitPrice: null, barsHeld: null };
}

// ---- Walk-forward engine -----------------------------------------------------

async function backtestSymbol(symbol) {
  process.stdout.write(`${symbol}: fetching history... `);
  const [allBars, allBars4h] = await Promise.all([
    fetchHistory(symbol, INTERVAL,     PAGES,     1000),
    fetchHistory(symbol, INTERVAL_HTF, HTF_PAGES, 1000),
  ]);
  console.log(`${allBars.length} × 15m, ${allBars4h.length} × 4H closed bars`);

  const trades = [];
  const seenKeys = new Set();

  for (let i = WINDOW_SIZE; i < allBars.length; i++) {
    const currentOpenTime = allBars[i].open_time;

    // Kill-zone filter — only evaluate bars inside London Open or NY Open
    const utcHour = new Date(currentOpenTime).getUTCHours();
    const inKillZone = KILL_ZONES.some(z => utcHour >= z.startUtc && utcHour < z.endUtc);
    if (!inKillZone) continue;

    const klines = allBars.slice(i - WINDOW_SIZE + 1, i + 1);
    const closedBars4h = allBars4h.filter(b => b.close_time < currentOpenTime);
    const klines4h = closedBars4h.slice(-HTF_WINDOW_SIZE);

    let signals;
    try {
      const swingHighs = findSwingHighs(klines, { lookback: 3 });
      const swingLows  = findSwingLows(klines,  { lookback: 3 });
      if (!swingHighs.length || !swingLows.length) continue;

      const lastSwingHigh = swingHighs[swingHighs.length - 1];
      const lastSwingLow  = swingLows[swingLows.length - 1];
      const rangeHigh = Math.max(...klines.map(k => k.high));
      const rangeLow  = Math.min(...klines.map(k => k.low));
      const lastIndex = klines.length - 1;
      const ctx = { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex };

      const swingHighs4h = klines4h.length >= 10 ? findSwingHighs(klines4h, { lookback: 3 }) : [];
      const swingLows4h  = klines4h.length >= 10 ? findSwingLows(klines4h,  { lookback: 3 }) : [];
      const ctx4h = (swingHighs4h.length && swingLows4h.length) ? {
        lastSwingHigh: swingHighs4h[swingHighs4h.length - 1],
        lastSwingLow:  swingLows4h[swingLows4h.length - 1],
        rangeHigh: Math.max(...klines4h.map(k => k.high)),
        rangeLow:  Math.min(...klines4h.map(k => k.low)),
        lastIndex: klines4h.length - 1,
      } : null;

      const sfpSig       = findFreshSFPSignal(klines, ctx);
      const levelsSig    = findFreshLevelZoneSignal(klines, ctx);
      const fibSig       = findFreshFibSignal(klines, ctx);
      const structureSig = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
      const pinbarSig    = findFreshPinbarSignal(klines, ctx, swingHighs, swingLows);
      const cvdDivSig    = findFreshCVDDivergenceSignal(klines, ctx);
      const chartPatternSig = findFreshChartPatternSignal(klines, ctx, swingHighs, swingLows);
      const divSig       = ctx4h ? findFreshDivergenceSignal(klines4h, ctx4h) : null;
      const htfBias      = ctx4h ? findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) : null;

      // 4H pinbar bias with divergence+levels exemption (mirrors futures bot)
      let candidates = [sfpSig, levelsSig, fibSig, structureSig, pinbarSig, divSig, cvdDivSig, chartPatternSig].filter(Boolean);
      if (htfBias) {
        const biasSide  = htfBias.direction === 'bullish' ? 'long' : 'short';
        const otherSide = biasSide === 'long' ? 'short' : 'long';
        const counterDiv    = candidates.find(s => s.strategy === 'divergence' && s.plan.side === otherSide);
        const counterLevels = candidates.find(s => s.strategy === 'levels'     && s.plan.side === otherSide);
        const exemptPair    = !!(counterDiv && counterLevels);
        candidates = candidates.filter(s =>
          s.plan.side === biasSide ||
          (exemptPair && (s.strategy === 'divergence' || s.strategy === 'levels') && s.plan.side === otherSide)
        );
      }
      // No daily bias filter — futures trades both directions

      // Ch.17 VWAP hard rule + Ch.14 VPVR Value Area rule — same as auto_trade_futures.mjs.
      // Both are LTF fair-value reads and exempt the 4H RSI divergence swing signal
      // (Ch.17: rules "don't apply if you are taking swing trades on the 4H timeframe").
      const vwapBias = classifyVWAPBias(klines);
      if (vwapBias.bias) candidates = candidates.filter(s => s.strategy === 'divergence' || s.plan.side === vwapBias.bias);
      const valueAreaBias = classifyValueAreaBias(klines);
      if (valueAreaBias.bias) candidates = candidates.filter(s => s.strategy === 'divergence' || s.plan.side === valueAreaBias.bias);

      signals = candidates;
    } catch { continue; }

    if (!signals.length) continue;
    const conf = assessConfluence({ signals });
    if (!conf.confluence) continue;

    // Ch.6 same-role guard
    const levelsSignal = signals.find(s => s.strategy === 'levels');
    if (levelsSignal && conf.agreeing_strategies.includes('levels') && levelsSignal.hitKind === 'retest') {
      if (levelsSignal.touchCount >= 3) {
        if (!conf.agreeing_strategies.includes('divergence')) continue;
      } else {
        if (!conf.agreeing_strategies.includes('sfp')) continue;
      }
    }

    const key = `${symbol}:${conf.agreeing_strategies.sort().join('+')}:` +
      signals.filter(s => conf.agreeing_strategies.includes(s.strategy))
             .map(s => s.signalKey).sort().join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const plan = conf.plan;
    if (Math.abs(plan.entry - plan.stop) / plan.entry < MIN_STOP_PCT) continue; // skip unrealistically tight stops
    const rr = Math.abs(plan.target - plan.entry) / Math.abs(plan.entry - plan.stop);
    if (rr < 1) continue; // hard 1:1 reward:risk floor — matches evaluateTradeSetup gate
    const sim = simulateOutcome(allBars, { entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side, startIndex: i });

    const risk = Math.abs(plan.entry - plan.stop);
    let grossR = null, netR = null, feeR = null;
    if (sim.outcome !== 'open' && sim.exitPrice != null && risk > 0) {
      grossR = (plan.side === 'long' ? sim.exitPrice - plan.entry : plan.entry - sim.exitPrice) / risk;
      feeR   = FEE_RATE * (plan.entry + sim.exitPrice) / risk;
      netR   = grossR - feeR;
    }

    trades.push({
      symbol,
      bar_time:   new Date(allBars[i].open_time).toISOString(),
      strategies: conf.agreeing_strategies.sort(),
      confidence: conf.confidence,
      side:       plan.side,
      entry:      plan.entry,
      stop:       plan.stop,
      target:     plan.target,
      rr:         Math.round(rr * 100) / 100,
      grossR:     grossR != null ? Math.round(grossR * 1000) / 1000 : null,
      feeR:       feeR   != null ? Math.round(feeR   * 1000) / 1000 : null,
      netR:       netR   != null ? Math.round(netR   * 1000) / 1000 : null,
      ...sim,
    });
  }

  return trades;
}

// ---- Summary stats -----------------------------------------------------------

function summarise(trades) {
  const resolved = trades.filter(t => t.outcome !== 'open');
  const wins     = resolved.filter(t => t.outcome === 'win');
  const losses   = resolved.filter(t => t.outcome === 'loss');
  const open     = trades.filter(t => t.outcome === 'open');
  const winRate  = resolved.length ? Math.round((wins.length / resolved.length) * 100) : null;
  const avgRR    = resolved.length
    ? Math.round(resolved.reduce((s, t) => s + t.rr, 0) / resolved.length * 100) / 100
    : null;
  const avgBars  = wins.concat(losses).filter(t => t.barsHeld != null).length
    ? Math.round(wins.concat(losses).filter(t => t.barsHeld != null)
        .reduce((s, t) => s + t.barsHeld, 0) / wins.concat(losses).filter(t => t.barsHeld != null).length)
    : null;

  const byCombination = {};
  for (const t of resolved) {
    const k = t.strategies.join('+');
    if (!byCombination[k]) byCombination[k] = { wins: 0, total: 0 };
    byCombination[k].total++;
    if (t.outcome === 'win') byCombination[k].wins++;
  }

  const withR    = resolved.filter(t => t.netR != null);
  const round2   = n => Math.round(n * 100) / 100;
  const mean     = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const grossExp = withR.length ? round2(mean(withR.map(t => t.grossR))) : null;
  const netExp   = withR.length ? round2(mean(withR.map(t => t.netR)))   : null;
  const totalNetR = withR.length ? round2(withR.reduce((s, t) => s + t.netR, 0)) : null;
  const avgFeeR  = withR.length ? round2(mean(withR.map(t => t.feeR)))    : null;
  const netWins  = withR.filter(t => t.netR > 0).length;
  const netWinRate = withR.length ? Math.round((netWins / withR.length) * 100) : null;
  const flippedByFees = withR.filter(t => t.grossR > 0 && t.netR <= 0).length;

  return { total: trades.length, wins: wins.length, losses: losses.length, open: open.length,
           winRate, avgRR, avgBars, byCombination,
           grossExp, netExp, totalNetR, avgFeeR, netWinRate, flippedByFees };
}

function printSummary(label, stats) {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${label}`);
  console.log(`${'─'.repeat(52)}`);
  console.log(`  Total trades:   ${stats.total}  (${stats.wins}W / ${stats.losses}L / ${stats.open} open)`);
  console.log(`  Win rate:       ${stats.winRate != null ? stats.winRate + '%' : 'n/a'} (gross, hit target before stop)`);
  console.log(`  Net win rate:   ${stats.netWinRate != null ? stats.netWinRate + '%' : 'n/a'} (trades net-positive after fees)`);
  console.log(`  Avg R:R setup:  ${stats.avgRR != null ? '1:' + stats.avgRR : 'n/a'}`);
  console.log(`  Avg bars held:  ${stats.avgBars != null ? stats.avgBars : 'n/a'}`);
  console.log(`  Expectancy:     ${stats.grossExp != null ? stats.grossExp + 'R gross' : 'n/a'} → ${stats.netExp != null ? stats.netExp + 'R net/trade' : 'n/a'} (fee drag ${stats.avgFeeR != null ? stats.avgFeeR + 'R' : 'n/a'})`);
  console.log(`  Total net R:    ${stats.totalNetR != null ? stats.totalNetR + 'R' : 'n/a'}  (${stats.flippedByFees ?? 0} gross wins flipped negative by fees)`);
  if (Object.keys(stats.byCombination).length) {
    console.log(`  By strategy combination:`);
    for (const [combo, s] of Object.entries(stats.byCombination)) {
      const wr = Math.round(s.wins / s.total * 100);
      console.log(`    ${combo.padEnd(38)} ${wr}%  (${s.wins}/${s.total})`);
    }
  }
}

// ---- Main -------------------------------------------------------------------

// --days=N overrides the lookback for both 15m (96 bars/day) and 4H (6 bars/day), 1000 bars/page.
const daysArg = process.argv.find(a => a.startsWith('--days='));
if (daysArg) {
  const days = Number(daysArg.split('=')[1]);
  if (Number.isFinite(days) && days > 0) {
    PAGES     = Math.max(1, Math.ceil(days * 96 / 1000));
    HTF_PAGES = Math.max(1, Math.ceil((days * 6 + HTF_WINDOW_SIZE) / 1000));
  }
}

// --fee=R overrides the round-trip taker fee rate per side (default 0.0005 = 0.05% USDM futures).
const feeArg = process.argv.find(a => a.startsWith('--fee='));
if (feeArg) {
  const f = Number(feeArg.split('=')[1]);
  if (Number.isFinite(f) && f >= 0) FEE_RATE = f;
}

// --min-stop=R overrides the minimum stop distance as a fraction of entry (0 to disable the floor).
const minStopArg = process.argv.find(a => a.startsWith('--min-stop='));
if (minStopArg) {
  const m = Number(minStopArg.split('=')[1]);
  if (Number.isFinite(m) && m >= 0) MIN_STOP_PCT = m;
}

// --symbols=A,B,C overrides the symbol universe with an explicit list (e.g. a watchlist).
const symbolsArg = process.argv.find(a => a.startsWith('--symbols='));
const explicitSymbols = symbolsArg
  ? symbolsArg.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : null;

const topVolumeArg = process.argv.find(a => a.startsWith('--top-volume='));
const topVolumeCount = topVolumeArg ? Number(topVolumeArg.split('=')[1]) : null;
const symbols = explicitSymbols
  ? explicitSymbols
  : topVolumeCount
    ? await fetchTopVolumeSymbols(topVolumeCount)
    : SYMBOLS;

console.log(`\nFutures Backtest — ${symbols.join(', ')} — ${INTERVAL} — ${PAGES * 1000} bars each (~${Math.round(PAGES * 1000 / 96)} days)`);
console.log(`Kill zones: London Open 07-10 UTC, NY Open 13-16 UTC\n`);

const allTrades = [];
for (const symbol of symbols) {
  const trades = await backtestSymbol(symbol);
  const stats  = summarise(trades);
  printSummary(symbol, stats);
  allTrades.push(...trades);
}

const overall = summarise(allTrades);
printSummary('OVERALL', overall);

const outPath = join(ROOT, 'backtest_futures_results.json');
writeFileSync(outPath, JSON.stringify({ run_at: new Date().toISOString(), summary: overall, trades: allTrades }, null, 2));
console.log(`\nFull trade log written to: backtest_futures_results.json\n`);

if (overall.winRate != null) {
  console.log(`>>> Suggested HISTORICAL_WIN_RATE (futures) = ${overall.winRate}`);
  console.log(`    (replace the placeholder in scripts/auto_trade_futures.mjs)\n`);
}
