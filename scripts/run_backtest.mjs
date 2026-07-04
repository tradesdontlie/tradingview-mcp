#!/usr/bin/env node
/**
 * Walk-forward backtesting harness — measures the real win rate of the
 * dual-timeframe confluence system so HISTORICAL_WIN_RATE in auto_trade.mjs
 * can be replaced with a measured number instead of a placeholder.
 *
 * Methodology:
 *   For each symbol, fetch ~2000 closed 15m bars AND ~500 closed 4H bars
 *   from the Binance MAINNET public API (no auth required). Walk forward
 *   bar by bar from bar 150 onward. At each 15m bar, also build a trailing
 *   100-bar 4H window of bars whose close_time precedes the current 15m
 *   bar's open_time (time-aligned, no lookahead). Run signals exactly as
 *   the live bot does: 15m execution signals (SFP, Levels, Fibonacci,
 *   Market Structure); 4H divergence signal; 4H pinbar as a direction
 *   filter. Simulate outcomes close-based; cap at 100 bars.
 *
 *   The risk gate is deliberately skipped — we are measuring raw signal
 *   quality, not the post-filtered rate.
 *
 * Output:
 *   Console summary per symbol and overall.
 *   backtest_results.json written to the repo root.
 *
 * Usage:
 *   node scripts/run_backtest.mjs
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
const { assessConfluence } = await import('../src/core/confluence.js');
const { classifyVWAPBias, classifyValueAreaBias } = await import('../src/core/volume_profile.js');

const SYMBOLS          = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL         = '15m';
const INTERVAL_HTF     = '4h';
const WINDOW_SIZE      = 150;   // trailing 15m window
const HTF_WINDOW_SIZE  = 100;   // trailing 4H window
const FRESHNESS_BARS   = 2;     // 15m freshness — same as auto_trade.mjs
const HTF_FRESHNESS_BARS = 3;   // 4H freshness — same as auto_trade.mjs
const RSI_PERIOD       = 14;
const CVD_WINDOW       = 14;    // rolling-window size for CVD divergence — same as auto_trade.mjs
const MAX_HOLD         = 100;   // 15m bars before marking a trade 'open'
let PAGES              = 2;     // 2 × 1000 = 2000 15m bars ≈ 20 days (override with --days=N)
let HTF_PAGES          = 1;     // 4H pages of 1000 bars — scaled with --days to cover the 15m window
const DAILY_WINDOW_SIZE = 50;   // trailing daily window — ~50 trading days of macro context
let DAILY_PAGES        = 1;     // daily pages of 1000 bars — scaled with --days
// Round-trip taker fee per trade, charged on entry and exit. Binance spot
// standard taker is 0.10%/side; override with --fee=0.00075 (BNB discount) etc.
let FEE_RATE           = 0.001;
// Minimum stop distance as a fraction of entry price. Setups with a tighter
// stop are skipped — a sub-0.5% stop on a 15m chart gets wicked out on noise and
// makes fees an unrealistically large fraction of risk. Override with --min-stop=0.003.
let MIN_STOP_PCT       = 0.005;

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

// ---- Signal detectors (identical logic to auto_trade.mjs) -------------------

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
    summary: `${type} SFP (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})` };
}

// Runs on 4H bars — mirrors auto_trade.mjs's findFreshDivergenceSignal
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
    summary: `4H ${hit.pattern} ${type} divergence (entry ${plan.entry}, stop ${plan.stop})` };
}

// Runs on 15m bars — mirrors auto_trade.mjs's findFreshCVDDivergenceSignal
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
    summary: `15m ${hit.pattern} ${type} CVD divergence (entry ${plan.entry}, stop ${plan.stop})` };
}

// Returns {direction} or null — 4H pinbar as a bias filter, not a signal
function findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) {
  const { lastIndex } = ctx4h;
  const { hits } = scanForPinbarSetup(klines4h, { swingHighs: swingHighs4h, swingLows: swingLows4h });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > HTF_FRESHNESS_BARS) return null;
  return { direction: hit.direction };
}

// Returns {direction} or null — daily BOS/CHoCH establishes macro trend bias
function findDailyStructureBias(klines1d) {
  if (klines1d.length < 10) return null;
  const swingHighs1d = findSwingHighs(klines1d, { lookback: 3 });
  const swingLows1d  = findSwingLows(klines1d,  { lookback: 3 });
  if (!swingHighs1d.length || !swingLows1d.length) return null;
  const { trend } = detectMarketStructure(klines1d, { swingHighs: swingHighs1d, swingLows: swingLows1d });
  if (!trend) return null;
  return { direction: trend };
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
    summary: `${direction} golden-pocket reaction (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})` };
}

function findFreshStructureSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(klines, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;
  const fresh = choch.filter(c => lastIndex - c.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  const c = fresh[fresh.length - 1];
  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: c, trend, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'market_structure', plan, confirmedAt: c.bar.open_time,
    signalKey: `market_structure:${trend}:${c.bar.open_time}`,
    summary: `${trend} CHoCH entry (entry ${plan.entry}, stop ${plan.stop})` };
}

// Pinbar is now HTF bias only — see findHTFPinbarBias above

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

// ---- Walk-forward engine ------------------------------------------------------

async function backtestSymbol(symbol) {
  process.stdout.write(`${symbol}: fetching history... `);
  const [allBars, allBars4h, allBars1d] = await Promise.all([
    fetchHistory(symbol, INTERVAL,     PAGES,       1000),
    fetchHistory(symbol, INTERVAL_HTF, HTF_PAGES,   1000),
    fetchHistory(symbol, '1d',         DAILY_PAGES, 1000),
  ]);
  console.log(`${allBars.length} × 15m, ${allBars4h.length} × 4H, ${allBars1d.length} × 1D closed bars`);

  const trades = [];
  const seenKeys = new Set();

  for (let i = WINDOW_SIZE; i < allBars.length; i++) {
    const currentOpenTime = allBars[i].open_time;

    // 15m window
    const klines = allBars.slice(i - WINDOW_SIZE + 1, i + 1);

    // 4H window: bars whose close_time is strictly before this 15m bar's open_time
    // (no lookahead — only closed 4H bars available at the time of this 15m bar)
    const closedBars4h = allBars4h.filter(b => b.close_time < currentOpenTime);
    const klines4h = closedBars4h.slice(-HTF_WINDOW_SIZE);

    // Daily window: same no-lookahead alignment
    const closedBars1d = allBars1d.filter(b => b.close_time < currentOpenTime);
    const klines1d = closedBars1d.slice(-DAILY_WINDOW_SIZE);

    let signals;
    try {
      // 15m context
      const swingHighs = findSwingHighs(klines, { lookback: 3 });
      const swingLows  = findSwingLows(klines,  { lookback: 3 });
      if (!swingHighs.length || !swingLows.length) continue;

      const lastSwingHigh = swingHighs[swingHighs.length - 1];
      const lastSwingLow  = swingLows[swingLows.length - 1];
      const rangeHigh = Math.max(...klines.map(k => k.high));
      const rangeLow  = Math.min(...klines.map(k => k.low));
      const lastIndex = klines.length - 1;
      const ctx = { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex };

      // 4H context (if enough bars)
      const swingHighs4h = klines4h.length >= 10 ? findSwingHighs(klines4h, { lookback: 3 }) : [];
      const swingLows4h  = klines4h.length >= 10 ? findSwingLows(klines4h,  { lookback: 3 }) : [];
      const ctx4h = (swingHighs4h.length && swingLows4h.length) ? {
        lastSwingHigh: swingHighs4h[swingHighs4h.length - 1],
        lastSwingLow:  swingLows4h[swingLows4h.length - 1],
        rangeHigh: Math.max(...klines4h.map(k => k.high)),
        rangeLow:  Math.min(...klines4h.map(k => k.low)),
        lastIndex: klines4h.length - 1,
      } : null;

      // 15m execution signals
      const sfpSig       = findFreshSFPSignal(klines, ctx);
      const levelsSig    = findFreshLevelZoneSignal(klines, ctx);
      const fibSig       = findFreshFibSignal(klines, ctx);
      const structureSig = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
      const cvdDivSig    = findFreshCVDDivergenceSignal(klines, ctx);

      // 4H signals
      const divSig    = ctx4h ? findFreshDivergenceSignal(klines4h, ctx4h) : null;
      const htfBias   = ctx4h ? findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) : null;

      // Apply HTF pinbar direction filter, then daily structure bias
      let candidates = [sfpSig, levelsSig, fibSig, structureSig, divSig, cvdDivSig].filter(Boolean);
      if (htfBias) {
        const biasSide = htfBias.direction === 'bullish' ? 'long' : 'short';
        candidates = candidates.filter(s => s.plan.side === biasSide);
      }
      const dailyBias = findDailyStructureBias(klines1d);
      if (dailyBias) {
        const biasSide  = dailyBias.direction === 'bullish' ? 'long' : 'short';
        const otherSide = biasSide === 'long' ? 'short' : 'long';
        const counterDiv    = candidates.find(s => s.strategy === 'divergence' && s.plan.side === otherSide);
        const counterLevels = candidates.find(s => s.strategy === 'levels'     && s.plan.side === otherSide);
        const exemptPair    = !!(counterDiv && counterLevels);
        candidates = candidates.filter(s =>
          s.plan.side === biasSide ||
          (exemptPair && (s.strategy === 'divergence' || s.strategy === 'levels') && s.plan.side === otherSide)
        );
      }
      // Ch.17 VWAP hard rule + Ch.14 VPVR Value Area rule — same as auto_trade.mjs.
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

    // Ch.6 same-role guard — mirrors auto_trade.mjs exactly
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

    // Realized R off the actual exit close, then subtract a round-trip taker fee
    // (entry + exit) expressed in R. Fees can drag a thin gross win net-negative.
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
      feeR:       feeR != null ? Math.round(feeR * 1000) / 1000 : null,
      netR:       netR != null ? Math.round(netR * 1000) / 1000 : null,
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

  // Fee-adjusted economics (net R per trade after round-trip taker fees).
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

  // Break down by strategy combination
  const byCombination = {};
  for (const t of resolved) {
    const k = t.strategies.join('+');
    if (!byCombination[k]) byCombination[k] = { wins: 0, total: 0 };
    byCombination[k].total++;
    if (t.outcome === 'win') byCombination[k].wins++;
  }

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

// --days=N overrides the lookback window. Scale ALL three timeframes so the
// 4H and daily bias layers still cover the full 15m walk-forward range
// (otherwise older 15m bars lose their HTF/daily context). 1000 bars/page.
//   15m: 96 bars/day | 4H: 6 bars/day (+HTF_WINDOW_SIZE) | 1D: 1 bar/day (+DAILY_WINDOW_SIZE)
const daysArg = process.argv.find(a => a.startsWith('--days='));
if (daysArg) {
  const days = Number(daysArg.split('=')[1]);
  if (Number.isFinite(days) && days > 0) {
    PAGES       = Math.max(1, Math.ceil(days * 96 / 1000));
    HTF_PAGES   = Math.max(1, Math.ceil((days * 6 + HTF_WINDOW_SIZE) / 1000));
    DAILY_PAGES = Math.max(1, Math.ceil((days + DAILY_WINDOW_SIZE) / 1000));
  }
}

// --fee=R overrides the per-side taker fee (e.g. 0.00075 for BNB discount, 0 to disable).
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

console.log(`\nBacktest — ${symbols.join(', ')} — ${INTERVAL} — ${PAGES * 1000} bars each (~${Math.round(PAGES * 1000 / 96)} days)\n`);

const allTrades = [];
for (const symbol of symbols) {
  const trades = await backtestSymbol(symbol);
  const stats  = summarise(trades);
  printSummary(symbol, stats);
  allTrades.push(...trades);
}

const overall = summarise(allTrades);
printSummary('OVERALL', overall);

const outPath = join(ROOT, 'backtest_results.json');
writeFileSync(outPath, JSON.stringify({ run_at: new Date().toISOString(), summary: overall, trades: allTrades }, null, 2));
console.log(`\nFull trade log written to: backtest_results.json\n`);

if (overall.winRate != null) {
  console.log(`>>> Suggested HISTORICAL_WIN_RATE = ${overall.winRate}`);
  console.log(`    (replace the placeholder in scripts/auto_trade.mjs line ~80)\n`);
}
