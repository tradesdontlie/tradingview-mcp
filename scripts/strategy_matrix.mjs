/**
 * Strategy comparison matrix — neutral, both-directions backtest of every
 * standalone trigger strategy, every 2-strategy pair, and every (strategy /
 * pair) + non-standalone-filter combination, across 1m/5m/15m/1h/4h/1D over
 * ~6 months of BTC/ETH/BNB data.
 *
 * Design:
 *   - NEUTRAL simulation: both longs and shorts taken, fixed target/stop from
 *     each strategy's own trade plan, no leverage, no kill-zones, no spot
 *     long-only constraint, no daily/HTF bias. This isolates each strategy's
 *     raw edge so the comparison is apples-to-apples (NOT the live spot/futures
 *     bot models — those add account constraints that confound the comparison).
 *   - Per (symbol, timeframe) the 6 standalone detectors + the 2 numeric bias
 *     filters (VWAP, VPVR) are pre-computed ONCE per bar; the levels signal
 *     doubles as the third (directional) filter. All Step 1-4 configs are then
 *     assembled cheaply from that per-bar signal map.
 *   - Everything runs on a SINGLE timeframe at a time (divergence on 1m uses
 *     1m RSI, etc.) — no cross-TF mixing. Note this departs from the live bot,
 *     where divergence is 4H; here we honour the request to sweep every
 *     strategy across every timeframe. Curriculum TF scoping (divergence >=4H,
 *     CVD short-term) is flagged in the summary, not enforced.
 *
 * Filter semantics (Steps 3-4): a filter CONFIRMS a trade when it gives a
 * directional read matching the trade's side at the firing bar (VWAP/VPVR
 * bias == side; or a fresh same-side levels signal). A neutral/absent read
 * does NOT confirm -> the trade is skipped. This is the "confirmation layer"
 * reading (require agreement), stricter than the live bot's "only block
 * opposing" semantics.
 *
 * Metrics per config x timeframe (pooled across the 3 symbols):
 *   - win rate % = wins / (wins+losses)        (open trades excluded)
 *   - total trades = resolved (wins+losses)
 *   - profit factor = sum(+R) / sum(|-R|)       (R = realized move / risk dist)
 *   - max drawdown (R) = peak-to-trough of the time-ordered cumulative-R curve
 *   - plus net R and avg R per trade as context
 *
 * Output: strategy_matrix_results.csv (every row) + strategy_matrix_summary.md
 * (grouped, ranked by win%).
 */
import https from 'node:https';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, 'backtest_cache');

const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { scanForDivergence, scanForCVDDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { detectZones, findZoneRetests, buildZoneTradePlan } = await import('../src/core/levels.js');
const { scanForFibReaction, buildFibTradePlan } = await import('../src/core/fibonacci.js');
const { detectMarketStructure, buildStructureTradePlan } = await import('../src/core/market_structure.js');
const { scanForPinbarSetup, buildPinbarTradePlan } = await import('../src/core/pinbar.js');
const { classifyVWAPBias, classifyValueAreaBias } = await import('../src/core/volume_profile.js');

// ---- Config -----------------------------------------------------------------

const ALL_SYMBOLS    = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const ALL_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const SIX_MONTHS_MS  = 182 * 24 * 60 * 60 * 1000;
const WINDOW_SIZE    = 150;   // trailing bars of context for the detectors
const FRESHNESS_BARS = 2;     // a signal is "fresh" for this many bars after it confirms
const MAX_HOLD       = 100;   // bars to wait for target/stop before marking a trade 'open'
const RSI_PERIOD     = 14;
const CVD_WINDOW     = 14;

const STRATEGIES = ['sfp', 'divergence', 'cvd_divergence', 'fibonacci', 'market_structure', 'pinbar'];
const FILTERS    = ['levels', 'vwap', 'vpvr'];

// CLI args: --symbols=BTCUSDT,ETHUSDT  --timeframes=15m,1h  --refresh
const args = process.argv.slice(2);
const argVal = (name) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : null; };
const SYMBOLS    = (argVal('symbols')    || ALL_SYMBOLS.join(',')).split(',');
const TIMEFRAMES = (argVal('timeframes') || ALL_TIMEFRAMES.join(',')).split(',');
const REFRESH    = args.includes('--refresh');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Data fetching (mainnet public klines, no auth) + disk cache ------------

function fetchKlinesPage(symbol, interval, limit, endTime) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (endTime != null) params.set('endTime', String(endTime));
    https.get({
      hostname: 'api.binance.com',
      path: `/api/v3/klines?${params}`,
      agent: false,
      headers: { 'User-Agent': 'tradingview-mcp-matrix/1.0' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).map(k => ({
            open_time: k[0], open: Number(k[1]), high: Number(k[2]),
            low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
            close_time: k[6], taker_buy_volume: Number(k[9]),
          })));
        } catch (e) { reject(new Error(`Parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchHistoryRange(symbol, interval, startMs) {
  let all = [];
  let endTime;
  while (true) {
    const page = await fetchKlinesPage(symbol, interval, 1000, endTime);
    if (!page.length) break;
    all = [...page, ...all];
    const earliest = page[0].open_time;
    if (earliest <= startMs) break;
    endTime = earliest - 1;
    await sleep(40);
  }
  all.sort((a, b) => a.open_time - b.open_time);
  const now = Date.now();
  return all.filter(k => k.close_time <= now && k.open_time >= startMs);
}

async function loadBars(symbol, interval) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${symbol}_${interval}.json`);
  if (!REFRESH && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached) && cached.length) return cached;
    } catch { /* fall through to refetch */ }
  }
  const bars = await fetchHistoryRange(symbol, interval, Date.now() - SIX_MONTHS_MS);
  writeFileSync(cacheFile, JSON.stringify(bars));
  return bars;
}

// ---- Per-bar signal detectors (neutral: return whatever the strategy sees) --

function ctxFor(window) {
  const swingHighs = findSwingHighs(window, { lookback: 3 });
  const swingLows  = findSwingLows(window,  { lookback: 3 });
  if (!swingHighs.length || !swingLows.length) return null;
  return {
    swingHighs, swingLows,
    lastSwingHigh: swingHighs[swingHighs.length - 1],
    lastSwingLow:  swingLows[swingLows.length - 1],
    rangeHigh: Math.max(...window.map(k => k.high)),
    rangeLow:  Math.min(...window.map(k => k.low)),
    lastIndex: window.length - 1,
  };
}

function sigSFP(window, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const bearish = scanForSFP(window.slice(lastSwingHigh.index + 1), { level: lastSwingHigh.price, type: 'bearish' })
    .map(h => ({ ...h, index: h.index + lastSwingHigh.index + 1 }));
  const bullish = scanForSFP(window.slice(lastSwingLow.index + 1), { level: lastSwingLow.price, type: 'bullish' })
    .map(h => ({ ...h, index: h.index + lastSwingLow.index + 1 }));
  const candidates = [
    ...bearish.map(hit => ({ hit, type: 'bearish', target: lastSwingLow.price, alt: rangeLow })),
    ...bullish.map(hit => ({ hit, type: 'bullish', target: lastSwingHigh.price, alt: rangeHigh })),
  ].filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.hit.index - a.hit.index);
  const { hit, type, target, alt } = candidates[0];
  const plan = buildSFPTradePlan({ hit, type, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.bar.open_time, signalKey: `sfp:${type}:${hit.bar.open_time}` };
}

function sigDivergence(window, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const cands = [];
  for (const type of ['bullish', 'bearish']) {
    const r = scanForDivergence(window, { type, rsiPeriod: RSI_PERIOD });
    if (r.divergence) cands.push({ hit: r, type });
  }
  const fresh = cands.filter(c => lastIndex - c.hit.newer_swing.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.newer_swing.bar.open_time, signalKey: `divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}` };
}

function sigCVD(window, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const cands = [];
  for (const type of ['bullish', 'bearish']) {
    const r = scanForCVDDivergence(window, { type, cvdWindow: CVD_WINDOW });
    if (r.divergence) cands.push({ hit: r, type });
  }
  const fresh = cands.filter(c => lastIndex - c.hit.newer_swing.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.newer_swing.bar.open_time, signalKey: `cvd_divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}` };
}

function sigFibonacci(window, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const { direction, hits } = scanForFibReaction(window, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildFibTradePlan({ hit, direction, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.bar.open_time, signalKey: `fibonacci:${direction}:${hit.bar.open_time}` };
}

function sigStructure(window, ctx) {
  const { swingHighs, swingLows, lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(window, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;
  const fresh = choch.filter(c => lastIndex - c.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  const c = fresh[fresh.length - 1];
  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: c, trend, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: c.bar.open_time, signalKey: `market_structure:${trend}:${c.bar.open_time}` };
}

function sigPinbar(window, ctx) {
  const { swingHighs, swingLows, lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { hits } = scanForPinbarSetup(window, { swingHighs, swingLows });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = hit.direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = hit.direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildPinbarTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.bar.open_time, signalKey: `pinbar:${hit.direction}:${hit.biasIndex}:${hit.bar.open_time}` };
}

function sigLevels(window, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const zones = detectZones(window);
  const cands = [];
  for (const zone of zones) {
    const hits = findZoneRetests(window, zone);
    if (hits.length) cands.push({ zone, hit: hits[hits.length - 1], touchCount: hits.length });
  }
  const fresh = cands.filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.index - a.hit.index);
  const { zone, hit, touchCount } = fresh[0];
  const target = zone.type === 'support' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = zone.type === 'support' ? rangeHigh : rangeLow;
  const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: target, rangeLevel: alt });
  return { plan, confirmedAt: hit.bar.open_time, signalKey: `levels:${zone.type}:${zone.classification}:${hit.bar.open_time}`, hitKind: hit.kind, touchCount };
}

const DETECTORS = {
  sfp: sigSFP, divergence: sigDivergence, cvd_divergence: sigCVD,
  fibonacci: sigFibonacci, market_structure: sigStructure, pinbar: sigPinbar,
};

// ---- Outcome simulation + R -------------------------------------------------

function simulateOutcome(allBars, { entry, stop, target, side, startIndex }) {
  const isLong = side === 'long';
  for (let i = startIndex + 1; i < allBars.length && i <= startIndex + MAX_HOLD; i++) {
    const close = allBars[i].close;
    if (isLong) {
      if (close >= target) return { outcome: 'win',  exitPrice: close };
      if (close <= stop)   return { outcome: 'loss', exitPrice: close };
    } else {
      if (close <= target) return { outcome: 'win',  exitPrice: close };
      if (close >= stop)   return { outcome: 'loss', exitPrice: close };
    }
  }
  return { outcome: 'open', exitPrice: null };
}

// A trade = { resolved, R, win, entryTime }. Fixed-R model: a win banks the
// setup's planned reward:risk (exit AT the target, as a resting limit would —
// not at the overshooting close that breaches it, which would inflate R on
// volatile candles); a loss is -1R (exit at the stop). This keeps profit
// factor and drawdown meaningful and comparable across strategies/timeframes.
function makeTrade(allBars, plan, startIndex) {
  if (plan == null || plan.entry == null || plan.stop == null || plan.target == null) return null;
  const { side, entry, stop, target } = plan;
  if (side !== 'long' && side !== 'short') return null;
  const riskDist = Math.abs(entry - stop);
  if (!(riskDist > 0)) return null;
  const plannedRewardR = Math.abs(target - entry) / riskDist;
  const sim = simulateOutcome(allBars, { entry, stop, target, side, startIndex });
  const entryTime = allBars[startIndex].open_time;
  if (sim.outcome === 'open') return { resolved: false, R: 0, entryTime };
  const win = sim.outcome === 'win';
  return { resolved: true, R: win ? plannedRewardR : -1, win, entryTime };
}

// ---- Per (symbol, timeframe) signal pre-computation -------------------------

function precompute(symbol, tf, allBars) {
  const n = allBars.length;
  // signalsByBar[i] = { sfp?:{plan,confirmedAt,signalKey}, ... } for standalone strategies + levels
  const signalsByBar = new Array(n).fill(null);
  const vwapBias = new Array(n).fill(null);
  const vaBias   = new Array(n).fill(null);

  for (let i = WINDOW_SIZE; i < n; i++) {
    const window = allBars.slice(i - WINDOW_SIZE + 1, i + 1);
    const ctx = ctxFor(window);
    if (!ctx) continue;

    let bag = null;
    for (const strat of STRATEGIES) {
      let sig;
      try { sig = DETECTORS[strat](window, ctx); } catch { sig = null; }
      if (sig && sig.plan) { (bag ||= {})[strat] = { plan: sig.plan, confirmedAt: sig.confirmedAt, signalKey: sig.signalKey }; }
    }
    // levels: directional signal that doubles as the third filter
    let lev; try { lev = sigLevels(window, ctx); } catch { lev = null; }
    if (lev && lev.plan) { (bag ||= {}).levels = { plan: lev.plan, confirmedAt: lev.confirmedAt, signalKey: lev.signalKey }; }
    if (bag) signalsByBar[i] = bag;

    try { const b = classifyVWAPBias(window);      vwapBias[i] = b.bias; } catch { /* leave null */ }
    try { const b = classifyValueAreaBias(window); vaBias[i]   = b.bias; } catch { /* leave null */ }
  }
  return { signalsByBar, vwapBias, vaBias };
}

// Confirmation read for a filter at bar i, given a desired side.
function filterConfirms(pc, i, filter, side) {
  if (filter === 'vwap') return pc.vwapBias[i] === side;
  if (filter === 'vpvr') return pc.vaBias[i] === side;
  if (filter === 'levels') { const s = pc.signalsByBar[i]?.levels; return !!s && s.plan.side === side; }
  return false;
}

// ---- Config evaluation: walk bars, emit deduped trades ----------------------

function evalIndividual(allBars, pc, strat) {
  const trades = []; const seen = new Set();
  for (let i = 0; i < allBars.length; i++) {
    const sig = pc.signalsByBar[i]?.[strat];
    if (!sig || seen.has(sig.signalKey)) continue;
    seen.add(sig.signalKey);
    const t = makeTrade(allBars, sig.plan, i); if (t) trades.push(t);
  }
  return trades;
}

function evalPair(allBars, pc, a, b) {
  const trades = []; const seen = new Set();
  for (let i = 0; i < allBars.length; i++) {
    const sa = pc.signalsByBar[i]?.[a]; const sb = pc.signalsByBar[i]?.[b];
    if (!sa || !sb) continue;
    if (sa.plan.side !== sb.plan.side) continue;
    const key = [sa.signalKey, sb.signalKey].sort().join('+');
    if (seen.has(key)) continue;
    seen.add(key);
    const primary = sa.confirmedAt >= sb.confirmedAt ? sa : sb; // freshest plan, mirrors assessConfluence
    const t = makeTrade(allBars, primary.plan, i); if (t) trades.push(t);
  }
  return trades;
}

function evalFiltered(allBars, pc, strat, filter) {
  const trades = []; const seen = new Set();
  for (let i = 0; i < allBars.length; i++) {
    const sig = pc.signalsByBar[i]?.[strat];
    if (!sig || seen.has(sig.signalKey)) continue;
    if (!filterConfirms(pc, i, filter, sig.plan.side)) continue;
    seen.add(sig.signalKey);
    const t = makeTrade(allBars, sig.plan, i); if (t) trades.push(t);
  }
  return trades;
}

function evalPairFiltered(allBars, pc, a, b, filter) {
  const trades = []; const seen = new Set();
  for (let i = 0; i < allBars.length; i++) {
    const sa = pc.signalsByBar[i]?.[a]; const sb = pc.signalsByBar[i]?.[b];
    if (!sa || !sb || sa.plan.side !== sb.plan.side) continue;
    if (!filterConfirms(pc, i, filter, sa.plan.side)) continue;
    const key = [sa.signalKey, sb.signalKey].sort().join('+');
    if (seen.has(key)) continue;
    seen.add(key);
    const primary = sa.confirmedAt >= sb.confirmedAt ? sa : sb;
    const t = makeTrade(allBars, primary.plan, i); if (t) trades.push(t);
  }
  return trades;
}

// ---- Metrics over pooled trades ---------------------------------------------

function metrics(trades) {
  const resolved = trades.filter(t => t.resolved);
  const wins = resolved.filter(t => t.win).length;
  const losses = resolved.length - wins;
  const open = trades.length - resolved.length;
  let grossProfit = 0, grossLoss = 0, netR = 0;
  for (const t of resolved) { netR += t.R; if (t.R >= 0) grossProfit += t.R; else grossLoss += -t.R; }
  // max drawdown over the time-ordered cumulative-R curve (portfolio-style across symbols)
  const ordered = [...resolved].sort((x, y) => x.entryTime - y.entryTime);
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of ordered) { equity += t.R; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); }
  return {
    trades: resolved.length, wins, losses, open,
    winRate: resolved.length ? (wins / resolved.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null),
    maxDD, netR, avgR: resolved.length ? netR / resolved.length : null,
  };
}

// ---- Main -------------------------------------------------------------------

function uniquePairs(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  return out;
}

// accumulator: results[configKey] = { step, group, label, perTf: { tf: trades[] } }
const results = new Map();
function acc(step, group, label, tf, trades) {
  const key = `${step}|${label}`;
  if (!results.has(key)) results.set(key, { step, group, label, perTf: {} });
  const e = results.get(key);
  (e.perTf[tf] ||= []).push(...trades);
}

const PAIRS = uniquePairs(STRATEGIES);

console.log(`Strategy matrix — symbols=${SYMBOLS.join(',')} timeframes=${TIMEFRAMES.join(',')} window=~6mo`);
console.log(`Configs per TF: ${STRATEGIES.length} individual + ${PAIRS.length} pairs + ${STRATEGIES.length * FILTERS.length} filtered + ${PAIRS.length * FILTERS.length} filtered-pairs\n`);

for (const tf of TIMEFRAMES) {
  for (const symbol of SYMBOLS) {
    process.stdout.write(`[${tf}] ${symbol}: loading… `);
    const allBars = await loadBars(symbol, tf);
    if (allBars.length <= WINDOW_SIZE + 5) { console.log(`only ${allBars.length} bars — skipping`); continue; }
    process.stdout.write(`${allBars.length} bars, precomputing… `);
    const t0 = Date.now();
    const pc = precompute(symbol, tf, allBars);
    process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s, evaluating… `);

    for (const s of STRATEGIES)           acc(1, 'Individual',     s,                       tf, evalIndividual(allBars, pc, s));
    for (const [a, b] of PAIRS)           acc(2, 'Paired',         `${a}+${b}`,             tf, evalPair(allBars, pc, a, b));
    for (const s of STRATEGIES) for (const f of FILTERS) acc(3, 'Filtered',      `${s} | ${f}`,           tf, evalFiltered(allBars, pc, s, f));
    for (const [a, b] of PAIRS) for (const f of FILTERS) acc(4, 'Filtered Pairs', `${a}+${b} | ${f}`,     tf, evalPairFiltered(allBars, pc, a, b, f));

    console.log('done');
  }
}

// ---- Build rows + write outputs ---------------------------------------------

const rows = [];
for (const { step, group, label, perTf } of results.values()) {
  for (const tf of TIMEFRAMES) {
    const trades = perTf[tf]; if (!trades || !trades.length) continue;
    const m = metrics(trades);
    if (!m.trades) continue; // no resolved trades
    rows.push({ step, group, label, tf, ...m });
  }
}

const fmt = (v, d = 2) => v == null ? '' : (v === Infinity ? '∞' : Number(v).toFixed(d));
const csvLines = ['step,group,strategy,timeframe,win_rate_pct,total_trades,profit_factor,max_drawdown_R,net_R,avg_R,wins,losses,open'];
for (const r of rows) {
  csvLines.push([
    r.step, r.group, `"${r.label}"`, r.tf,
    fmt(r.winRate, 1), r.trades, fmt(r.profitFactor), fmt(r.maxDD), fmt(r.netR), fmt(r.avgR), r.wins, r.losses, r.open,
  ].join(','));
}
writeFileSync(join(ROOT, 'strategy_matrix_results.csv'), csvLines.join('\n'));

// Markdown summary: grouped, ranked by win% (min-trade highlights included)
const TF_ORDER = TIMEFRAMES;
function table(groupRows, { minTrades = 0 } = {}) {
  const filtered = groupRows.filter(r => r.trades >= minTrades);
  filtered.sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades));
  const lines = ['| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |',
                 '|---|---|---|---|---|---|---|---|---|'];
  filtered.forEach((r, idx) => {
    lines.push(`| ${idx + 1} | ${r.label} | ${r.tf} | ${fmt(r.winRate, 1)} | ${r.trades} | ${fmt(r.profitFactor)} | ${fmt(r.maxDD)} | ${fmt(r.netR)} | ${fmt(r.avgR)} |`);
  });
  return lines.join('\n');
}

const byGroup = (g) => rows.filter(r => r.group === g);
const md = [];
md.push('# Strategy Comparison Matrix\n');
md.push(`_Generated ${new Date().toISOString()} • symbols ${SYMBOLS.join(', ')} • timeframes ${TF_ORDER.join(', ')} • ~6 months • neutral both-directions simulation, pooled across symbols._\n`);
md.push('**Metrics:** win% and trades count resolved trades only (open trades excluded). R = realized move ÷ risk distance. Profit factor = Σ(+R)/Σ(|−R|). Max drawdown = deepest peak-to-trough of the time-ordered cumulative-R curve (portfolio-style across the 3 symbols). Net R = total R booked.\n');
md.push('**Caveats:** Single-timeframe — every strategy is run on each TF in isolation (no 4H/daily mixing like the live bot). The curriculum scopes RSI divergence to ≥4H and CVD to short-term, so their sub-15m rows are out-of-spec by design; rank with the trade count in mind. Low-trade rows (<20) are statistically noisy.\n');

for (const [step, group] of [[1, 'Individual'], [2, 'Paired'], [3, 'Filtered'], [4, 'Filtered Pairs']]) {
  const g = byGroup(group);
  md.push(`\n## Step ${step} — ${group} Strategies (ranked by win%)\n`);
  if (!g.length) { md.push('_No resolved trades._\n'); continue; }
  md.push(`### Headline — min 20 trades\n`);
  const hi = g.filter(r => r.trades >= 20);
  md.push(hi.length ? table(g, { minTrades: 20 }) : '_No configs with ≥20 resolved trades._');
  md.push(`\n\n<details><summary>Full table (all ${g.length} rows, any trade count)</summary>\n`);
  md.push('\n' + table(g) + '\n</details>\n');
}
writeFileSync(join(ROOT, 'strategy_matrix_summary.md'), md.join('\n'));

console.log(`\nWrote ${rows.length} result rows.`);
console.log('  → strategy_matrix_results.csv');
console.log('  → strategy_matrix_summary.md');
