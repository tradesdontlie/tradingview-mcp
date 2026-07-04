#!/usr/bin/env node
/**
 * Standalone autonomous multi-strategy scan -> confluence -> risk gate ->
 * spot-account execution pass.
 *
 * Run on a timer (Windows Task Scheduler) — each invocation does ONE pass:
 * scans BTC/ETH/BNB on a dual-timeframe basis:
 *
 *   15m (execution timeframe) — four independently-coded strategies:
 *     Swing Failure Pattern (close-based sweep confirmation),
 *     Key Levels/Zones (consolidation-range breakout -> support/resistance
 *     zone -> retest), Fibonacci golden-pocket reaction (retracement into
 *     the 0.618-0.66 zone with close-based rejection), Market Structure
 *     (BOS confirms trend, realigning CHoCH is the entry trigger).
 *
 *   4H (bias/confirmation timeframe) — two curriculum-specified HTF tools:
 *     RSI Divergence ("a minimum 4-hour timeframe is preferred" — Ch.10/11),
 *     run as a full confluence signal on 4H bars; and Pinbar Reversal Bias
 *     (Ch.3 is titled "HTF Bias and LTF Execution" — the pinbar establishes
 *     a directional bias on the higher timeframe, not an execution entry),
 *     applied as a pre-confluence direction filter: if a fresh 4H pinbar is
 *     present, only 15m/4H signals that agree with its direction are passed
 *     to the confluence gate.
 *
 * Requires CONFLUENCE: per the curriculum's repeated guidance that
 * complementary techniques produce more accurate setups ("adding further
 * confirmations leads to a more profitable setup"; SFP retests are "higher
 * conviction, not a lesser consolation entry"), a setup is only acted on
 * when 2+ strategies independently agree on direction. Disagreement or a
 * lone signal both result in standing down — no rule exists to force a call
 * from a single uncorroborated read, and inventing one would just be live
 * judgment wearing code's clothing.
 *
 * A confirmed confluence then runs through the deterministic Trading Trident
 * risk rules (caps, R:R/win-rate breakeven, capital-aware sizing), gets
 * translated into a spot-executable order — only if every rule passes and the
 * order is faithfully executable on a SPOT account (no shorting; bearish
 * signals require existing inventory to sell) — and is placed laddered
 * (Ch.1, "Laddering": multiple limit orders spread across a price range "to
 * lower the average entry price") across the trade's own [entry, stop] risk
 * envelope, falling back to a single market order when a ladder can't clear
 * exchange minimums.
 *
 * State is tracked in auto_trade_state.json (one entry per symbol, keyed on
 * the agreeing strategies + their confirming candles' open_times) so the
 * same confirmed confluence is never acted on twice across repeated polls.
 *
 * TESTNET ONLY — uses core/binance.js (testnet), never core/binance_live.js.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Minimal .env loader (KEY=VALUE per line, # comments) — no extra dependency.
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { getKlines, accountInfo, placeOrder, getOpenOrders } = await import('../src/core/binance.js');
const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { scanForDivergence, scanForCVDDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { detectZones, findZoneRetests, buildZoneTradePlan } = await import('../src/core/levels.js');
const { scanForFibReaction, buildFibTradePlan } = await import('../src/core/fibonacci.js');
const { detectMarketStructure, buildStructureTradePlan } = await import('../src/core/market_structure.js');
const { scanForPinbarSetup, buildPinbarTradePlan } = await import('../src/core/pinbar.js');
const { buildLadderOrders } = await import('../src/core/laddering.js');
const { assessConfluence } = await import('../src/core/confluence.js');
const { classifyVWAPBias, classifyValueAreaBias } = await import('../src/core/volume_profile.js');
const { evaluateTradeSetup, translateForAccount } = await import('../src/core/risk.js');
const { fetchTopVolumeSymbols } = await import('../src/core/top_volume.js');

const CORE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
let topVolumeSymbols = [];
try {
  topVolumeSymbols = await fetchTopVolumeSymbols(20);
} catch (e) {
  console.error(`fetchTopVolumeSymbols failed, falling back to core symbols only: ${e.message}`);
}
const SYMBOLS = [...new Set([...CORE_SYMBOLS, ...topVolumeSymbols])];
const INTERVAL         = '15m';
const INTERVAL_HTF     = '4h';   // Ch.10/11: divergence "minimum 4-hour timeframe"; Ch.3: pinbar is HTF bias
const INTERVAL_DAILY   = '1d';   // macro structural bias — daily BOS/CHoCH establishes the trend filters below
const RISK_PERCENT     = 1;      // bottom of the curriculum's 1-3% per-trade cap
const MAX_POSITION_PERCENT = 15; // ceiling on single-trade size as % of capital, independent of stop tightness
const HISTORICAL_WIN_RATE = 73;  // measured: 8W/11 resolved trades (2026-06-13), after enforcing a hard 1:1 reward:risk floor (RR<1 setups removed from the gate and backtest); avg R:R 1:5.07, total +17.1R / 11 trades
const FRESHNESS_BARS   = 2;      // 15m signals: act only on signals confirmed within the last N closed bars
const HTF_FRESHNESS_BARS = 3;    // 4H signals: slightly wider window (3 × 4H = 12h)
const LADDER_ORDERS    = 3;      // Ch.1's worked examples use 3 or 5 rungs — pick the smaller, conservative split
const RSI_PERIOD       = 14;     // curriculum default for divergence detection
const CVD_WINDOW       = 14;     // rolling-window size for CVD divergence (Ch.18) — same default as RSI_PERIOD

const STATE_PATH = join(ROOT, 'auto_trade_state.json');
const LOG_PATH = join(ROOT, 'auto_trade.log');
const EVENTS_PATH = join(ROOT, 'bot_events.jsonl');   // escalation feed read by the orchestrator agent
const LEDGER_PATH = join(ROOT, 'trade_ledger.jsonl');  // resolved-trade ledger read by the orchestrator agent and the trade journal

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + '\n');
}

// Append one structured escalation event for the orchestrator agent to consume.
// severity: 'info' | 'warn' | 'error'. Never throws — escalation must not break a scan.
function emitEvent(severity, type, fields = {}) {
  try {
    const rec = { ts: new Date().toISOString(), bot: 'spot', severity, type, ...fields };
    appendFileSync(EVENTS_PATH, JSON.stringify(rec) + '\n');
  } catch { /* escalation is best-effort */ }
}

// Append one trade-lifecycle record (phase 'open') for the trade journal. Never throws.
// Spot has no exchange-side SL/TP, so there is no automated 'close' phase — the
// journal generator leaves exit/win-loss columns blank for spot 'open' records
// until they're filled in manually or a close-resolution pass is added.
function appendLedger(record) {
  try {
    appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), bot: 'spot', ...record }) + '\n');
  } catch { /* ledger write is best-effort */ }
}

// ---- Orchestrator control plane ------------------------------------------
// The orchestrator agent writes orchestrator_config.json to enable/disable
// strategies and filters based on measured win% / expectancy. This bot reads
// the `spot` section once per pass and runs ONLY what's active — always clamped
// to the hard-coded validated universe below: config can NARROW behavior, never
// invent it (no new symbols, strategies, or filters). A missing or malformed
// file fails OPEN to all-active (current behavior), never into a degraded state.
const ORCH_CONFIG_PATH     = join(ROOT, 'orchestrator_config.json');
const VALIDATED_STRATEGIES = new Set(['sfp', 'divergence', 'cvd_divergence', 'levels', 'fibonacci', 'market_structure']);
const VALIDATED_FILTERS    = new Set(['pinbar_bias_4h', 'daily_structure', 'vwap_bias', 'value_area_bias']);

function loadOrchestratorConfig() {
  const failOpen = { active_strategies: new Set(VALIDATED_STRATEGIES), active_filters: {} };
  if (!existsSync(ORCH_CONFIG_PATH)) return failOpen;
  try {
    const cfg = JSON.parse(readFileSync(ORCH_CONFIG_PATH, 'utf8'));
    const section = cfg.spot ?? {};
    const declared = Array.isArray(section.active_strategies) ? section.active_strategies : null;
    // Clamp to the validated universe — config can only narrow, never extend.
    const active = declared
      ? new Set(declared.filter(s => VALIDATED_STRATEGIES.has(s)))
      : new Set(VALIDATED_STRATEGIES);
    if (active.size === 0) {
      log('orchestrator_config: spot.active_strategies empty after clamp — failing open to all strategies');
      emitEvent('warn', 'config_fail_open', { reason: 'spot.active_strategies empty after clamp' });
      return failOpen;
    }
    const active_filters = (section.active_filters && typeof section.active_filters === 'object') ? section.active_filters : {};
    return { active_strategies: active, active_filters };
  } catch (e) {
    log(`orchestrator_config: unreadable (${e.message}) — failing open to all strategies/filters`);
    emitEvent('warn', 'config_fail_open', { reason: `unreadable: ${e.message}` });
    return failOpen;
  }
}

// A filter runs unless the config explicitly disables it (fail-open). Filters
// outside the validated set can never be turned on from config.
function filterEnabled(orch, name) {
  if (!VALIDATED_FILTERS.has(name)) return false;
  const f = orch.active_filters?.[name];
  return f ? f.enabled !== false : true;
}

// Exchange LOT_SIZE/MIN_NOTIONAL filters are enforced server-side and reject
// any quantity that doesn't land on the symbol's step size or clear the min
// order value — fetch them once per pass so orders are placed at a valid precision.
async function getSymbolFilters(symbol) {
  const res = await fetch(`https://testnet.binance.vision/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  const filters = data.symbols[0].filters;
  const lot = filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    minNotional: Number(notional?.minNotional ?? 0),
    tickSize: Number(priceFilter?.tickSize ?? 0.01),
  };
}

function floorToStep(quantity, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const factor = 10 ** decimals;
  return Number((Math.floor(quantity * factor) / factor).toFixed(decimals));
}

function roundToTick(price, tick) {
  const decimals = Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));
  const factor = 10 ** decimals;
  return Number((Math.round(price * factor) / factor).toFixed(decimals));
}

// ---- Strategy detectors --------------------------------------------------
// Each returns a candidate signal in the common shape confluence_assess
// expects ({ strategy, plan, confirmedAt, signalKey, summary }), or null if
// that strategy found nothing fresh. Kept independent and side-effect-free —
// confluence is what decides whether either is acted on.

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

  // If both directions are fresh (rare), the most recently confirmed sweep wins.
  candidates.sort((a, b) => b.hit.index - a.hit.index);
  const { hit, type, target, alt } = candidates[0];
  const plan = buildSFPTradePlan({ hit, type, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'sfp',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `sfp:${type}:${hit.bar.open_time}`,
    summary: `${type} SFP (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
  };
}

// Runs on 4H bars — "a minimum 4-hour timeframe is preferred" (Ch.10/11).
// klines4h / ctx4h are the HTF series; entry/stop/target in the returned plan
// are 4H-level prices, but assessConfluence will pick the freshest signal's
// plan, so the 15m strategy's plan almost always wins the execution slot.
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
  return {
    strategy: 'divergence',
    plan,
    confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `4H ${hit.pattern} ${type} divergence (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

// Runs on 15m bars, unlike RSI divergence's 4H — Ch.18: "I limit myself to
// trading with CVD only on the short term" / "We limit CVD usage to short
// term trading". Otherwise identical pipeline to findFreshDivergenceSignal,
// just with scanForCVDDivergence + the 15m execution context.
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
  return {
    strategy: 'cvd_divergence',
    plan,
    confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `cvd_divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `15m ${hit.pattern} ${type} CVD divergence (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

// Ch.3 is "HTF Bias and LTF Execution" — the pinbar establishes directional
// bias on the 4H, not an execution entry. Returns {direction} or null.
// Applied as a pre-confluence filter: if present, opposing-direction 15m
// signals are discarded before confluence assessment.
function findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) {
  const { lastIndex } = ctx4h;
  const { hits } = scanForPinbarSetup(klines4h, { swingHighs: swingHighs4h, swingLows: swingLows4h });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > HTF_FRESHNESS_BARS) return null;
  return { direction: hit.direction };
}

// Daily structure bias — establishes macro trend direction from 50 daily bars
// using the same BOS/CHoCH market structure engine as the 15m signal.
// No freshness check needed: unlike the 4H pinbar (a recent event), the daily
// trend is the trend until a new BOS invalidates it. Returns {direction} or
// null if the daily structure is ranging/inconclusive (no filter applied then).
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

  // If multiple zones were retested fresh (rare), the most recent retest wins.
  fresh.sort((a, b) => b.hit.index - a.hit.index);
  const { zone, hit, touchCount } = fresh[0];
  // "Buy support zones, sell resistance zones" (Ch.8) -> support retest targets
  // the upside (last swing high / range high), resistance retest targets the
  // downside (last swing low / range low) — same target convention as the
  // other two strategies' "First Trouble Area" / range-level duality.
  const target = zone.type === 'support' ? lastSwingHigh.price : lastSwingLow.price;
  const alt = zone.type === 'support' ? rangeHigh : rangeLow;
  const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: target, rangeLevel: alt });
  return {
    strategy: 'levels',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `levels:${zone.type}:${zone.classification}:${hit.bar.open_time}`,
    summary: `${zone.classification} ${zone.type} zone retest [${zone.low}-${zone.high}] (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
    hitKind: hit.kind,
    touchCount,
  };
}

function findFreshFibSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  // Same-index swing points mean price is too compressed to anchor a fib swing —
  // no valid A→B measurement is possible, so skip rather than throwing.
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const { direction, hits } = scanForFibReaction(klines, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;

  // Bullish reaction (golden-pocket support) -> long, continuation toward the
  // swing high being retraced from; bearish (resistance) -> short, toward the
  // swing low — same opposite-side-target convention as the other strategies.
  const target = direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt = direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildFibTradePlan({ hit, direction, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'fibonacci',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `fibonacci:${direction}:${hit.bar.open_time}`,
    summary: `${direction} golden-pocket reaction (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findFreshStructureSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(klines, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;

  // Only a CHoCH that REALIGNS with the trend is the entry trigger — an
  // opposing one is merely "the first sign of weakness" (Ch.5).
  const realigning = choch.filter(c => c.direction === trend);
  if (!realigning.length) return null;
  const latest = realigning[realigning.length - 1];
  if (lastIndex - latest.index > FRESHNESS_BARS) return null;

  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: latest, trend, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'market_structure',
    plan,
    confirmedAt: latest.bar.open_time,
    signalKey: `market_structure:${trend}:choch${latest.sequenceNumber}:${latest.bar.open_time}`,
    summary: `${trend} BOS + realigning CHoCH#${latest.sequenceNumber} (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findFreshPinbarSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { hits } = scanForPinbarSetup(klines, { swingHighs, swingLows });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;

  const target = hit.direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt = hit.direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildPinbarTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'pinbar',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `pinbar:${hit.direction}:${hit.biasBar.open_time}:${hit.bar.open_time}`,
    summary: `${hit.direction} pinbar at swing extreme + level retest (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

const state = loadState();
const account = await accountInfo();
const balanceOf = (asset) => account.balances.find(b => b.asset === asset)?.free ?? 0;
const usdt = balanceOf('USDT');

log(`scan start — interval=${INTERVAL}/${INTERVAL_HTF} symbols=${SYMBOLS.join(',')} usdt_balance=${usdt.toFixed(2)}`);

const orch = loadOrchestratorConfig();
log(`orchestrator config — strategies: ${[...orch.active_strategies].join(',')} | filters: ${[...VALIDATED_FILTERS].map(f => `${f}=${filterEnabled(orch, f) ? 'on' : 'off'}`).join(' ')}`);

for (const symbol of SYMBOLS) {
  try {
    // Fetch both timeframes + open orders in parallel.
    // Open orders check: if a previous ladder is still sitting on the exchange,
    // adding a new one would stack entries at the same zone — skip until the
    // existing orders resolve (fill, cancel, or expire).
    const [{ klines: rawKlines }, { klines: rawKlines4h }, { klines: rawKlines1d }, { orders: openOrders }] = await Promise.all([
      getKlines({ symbol, interval: INTERVAL,       limit: 150 }),
      getKlines({ symbol, interval: INTERVAL_HTF,   limit: 100 }),
      getKlines({ symbol, interval: INTERVAL_DAILY, limit: 50  }),
      getOpenOrders({ symbol }),
    ]);

    if (openOrders.length > 0) {
      log(`${symbol}: ${openOrders.length} open order(s) still active (IDs: ${openOrders.map(o => o.order_id).join(', ')}) — skipping to avoid stacking entries`);
      continue;
    }

    const now = Date.now();
    const klines   = rawKlines.filter(k => k.close_time <= now);
    const klines4h = rawKlines4h.filter(k => k.close_time <= now);
    const klines1d = rawKlines1d.filter(k => k.close_time <= now);

    if (klines.length < 10) { log(`${symbol}: not enough closed 15m bars yet — skipping`); continue; }

    // 15m swing points + context (execution signals)
    const swingHighs = findSwingHighs(klines, { lookback: 3 });
    const swingLows  = findSwingLows(klines,  { lookback: 3 });
    if (!swingHighs.length || !swingLows.length) { log(`${symbol}: no 15m swing points established yet — skipping`); continue; }

    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastSwingLow  = swingLows[swingLows.length - 1];
    const rangeHigh = Math.max(...klines.map(k => k.high));
    const rangeLow  = Math.min(...klines.map(k => k.low));
    const lastIndex = klines.length - 1;
    const ctx = { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex };

    // 4H swing points + context (divergence signal + pinbar bias)
    const swingHighs4h = klines4h.length >= 10 ? findSwingHighs(klines4h, { lookback: 3 }) : [];
    const swingLows4h  = klines4h.length >= 10 ? findSwingLows(klines4h,  { lookback: 3 }) : [];
    const ctx4h = (swingHighs4h.length && swingLows4h.length) ? {
      lastSwingHigh: swingHighs4h[swingHighs4h.length - 1],
      lastSwingLow:  swingLows4h[swingLows4h.length - 1],
      rangeHigh: Math.max(...klines4h.map(k => k.high)),
      rangeLow:  Math.min(...klines4h.map(k => k.low)),
      lastIndex: klines4h.length - 1,
    } : null;

    // 15m execution signals (SFP, Levels, Fibonacci, Market Structure, CVD Divergence)
    const sfpSignal       = findFreshSFPSignal(klines, ctx);
    const levelsSignal    = findFreshLevelZoneSignal(klines, ctx);
    const fibSignal       = findFreshFibSignal(klines, ctx);
    const structureSignal = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
    const cvdDivergenceSignal = findFreshCVDDivergenceSignal(klines, ctx);

    // 4H signals (Divergence as full signal; Pinbar as direction-only bias filter)
    const divergenceSignal = ctx4h ? findFreshDivergenceSignal(klines4h, ctx4h) : null;
    const htfBias          = ctx4h ? findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) : null;

    // Apply HTF pinbar bias: discard any signal whose direction opposes the 4H pinbar read
    let signals = [sfpSignal, levelsSignal, fibSignal, structureSignal, divergenceSignal, cvdDivergenceSignal]
      .filter(Boolean)
      .filter(s => orch.active_strategies.has(s.strategy));   // orchestrator: run only active strategies
    if (htfBias && filterEnabled(orch, 'pinbar_bias_4h')) {
      const biasSide = htfBias.direction === 'bullish' ? 'long' : 'short';
      const before = signals.length;
      signals = signals.filter(s => s.plan.side === biasSide);
      if (signals.length < before)
        log(`${symbol}: 4H pinbar bias (${htfBias.direction}) filtered out ${before - signals.length} opposing signal(s)`);
    }

    // Apply daily structure bias: discard signals opposing the macro daily trend.
    // Exception: a divergence+levels pair pointing the same counter-trend direction
    // is exempt — the curriculum explicitly validates divergence at a key zone as a
    // high-conviction reversal regardless of the macro trend (Ch.6 + Ch.10/11).
    // All other counter-trend signals (lone SFP, fibonacci, etc.) are still removed.
    const dailyBias = findDailyStructureBias(klines1d);
    if (dailyBias && filterEnabled(orch, 'daily_structure')) {
      const biasSide  = dailyBias.direction === 'bullish' ? 'long' : 'short';
      const otherSide = biasSide === 'long' ? 'short' : 'long';
      const counterDiv    = signals.find(s => s.strategy === 'divergence' && s.plan.side === otherSide);
      const counterLevels = signals.find(s => s.strategy === 'levels'     && s.plan.side === otherSide);
      const exemptPair    = !!(counterDiv && counterLevels);
      const before = signals.length;
      signals = signals.filter(s =>
        s.plan.side === biasSide ||
        (exemptPair && (s.strategy === 'divergence' || s.strategy === 'levels') && s.plan.side === otherSide)
      );
      if (signals.length < before)
        log(`${symbol}: daily structure bias (${dailyBias.direction}) filtered out ${before - signals.length} opposing signal(s)${exemptPair ? ' — divergence+levels reversal pair exempted' : ''}`);
    }

    // Ch.17 VWAP hard rule: "above VWAP, don't short; below VWAP, don't long"
    // — evaluated on the 15m execution timeframe. Ch.17 explicitly carves out
    // 4H swing trades ("The rules don't apply if you are taking swing trades on
    // the 4H timeframe"), so the 4H RSI divergence signal is exempt — a 15m
    // VWAP read must not veto an HTF swing setup.
    const vwapBias = classifyVWAPBias(klines);
    if (vwapBias.bias && filterEnabled(orch, 'vwap_bias')) {
      const before = signals.length;
      signals = signals.filter(s => s.strategy === 'divergence' || s.plan.side === vwapBias.bias);
      if (signals.length < before)
        log(`${symbol}: VWAP bias (close ${vwapBias.close} vs vwap ${vwapBias.vwap.toFixed(2)}, bias=${vwapBias.bias}) filtered out ${before - signals.length} opposing signal(s)`);
    }

    // Ch.14 VPVR hard rule: "above VaH, look for shorts; below VaL, look for longs"
    // — value area computed over the same 15m visible range used for rangeHigh/rangeLow.
    // VPVR is "one of the best LTF tools to hand you a bias" (Ch.14) — a lower-TF
    // fair-value read, so it too exempts the 4H RSI divergence swing signal.
    const vaCfg = orch.active_filters?.value_area_bias ?? {};
    const vaOpts = {};
    if (Number.isInteger(vaCfg.bins)) vaOpts.bins = vaCfg.bins;
    if (typeof vaCfg.value_area_percent === 'number') vaOpts.valueAreaPercent = vaCfg.value_area_percent;
    const valueAreaBias = classifyValueAreaBias(klines, vaOpts);
    if (valueAreaBias.bias && filterEnabled(orch, 'value_area_bias')) {
      const before = signals.length;
      signals = signals.filter(s => s.strategy === 'divergence' || s.plan.side === valueAreaBias.bias);
      if (signals.length < before)
        log(`${symbol}: VPVR value-area bias (close ${valueAreaBias.close} ${valueAreaBias.position} VA [${valueAreaBias.val.toFixed(2)}-${valueAreaBias.vah.toFixed(2)}], bias=${valueAreaBias.bias}) filtered out ${before - signals.length} opposing signal(s)`);
    }

    if (!signals.length) { log(`${symbol}: no fresh signals from any strategy within the last ${FRESHNESS_BARS} closed bars`); continue; }

    const confluence = assessConfluence({ signals });
    if (!confluence.confluence) {
      log(`${symbol}: ${signals.map(s => `${s.strategy} -> ${s.summary}`).join(' | ')} — ${confluence.reason}`);
      continue;
    }

    const combinedKey = `confluence:${INTERVAL}:${confluence.agreeing_strategies.sort().join('+')}:` +
      signals.filter(s => confluence.agreeing_strategies.includes(s.strategy)).map(s => s.signalKey).sort().join(',');
    if (state[symbol]?.last_signal_key === combinedKey) {
      log(`${symbol}: confluence signal already processed (${combinedKey}) — skipping`);
      continue;
    }

    log(`${symbol}: CONFLUENCE — ${confluence.confidence} (${signals.map(s => `${s.strategy}: ${s.summary}`).join(' | ')})`);

    // Ch.6 same-role level entry rules:
    // First retest (S/R flip, hit.kind==='first'): any 2+ confluence is valid — the role
    // change itself is the confirmation. Same-role retests require additional gating:
    //   2nd touch: SFP must be in the agreeing set (market makers run stops first; we
    //              want to enter after the stop hunt, not before it — Ch.6).
    //   3rd+ touch: level is weakening; divergence confirmation required to evidence
    //               remaining momentum (MACD preferred by curriculum; RSI used here
    //               as the closest encoded proxy — Ch.6).
    if (levelsSignal && confluence.agreeing_strategies.includes('levels') && levelsSignal.hitKind === 'retest') {
      if (levelsSignal.touchCount >= 3) {
        if (!confluence.agreeing_strategies.includes('divergence')) {
          log(`${symbol}: levels zone has ${levelsSignal.touchCount} same-role touches — 3rd+ touch requires divergence confirmation (Ch.6), not present — standing down`);
          state[symbol] = { last_signal_key: combinedKey, outcome: 'insufficient_confirmation' };
          continue;
        }
      } else {
        if (!confluence.agreeing_strategies.includes('sfp')) {
          log(`${symbol}: levels is a same-role retest — SFP required by Ch.6 for non-flip retests, not present — standing down`);
          state[symbol] = { last_signal_key: combinedKey, outcome: 'insufficient_confirmation' };
          continue;
        }
      }
    }

    const plan = confluence.plan;
    let gate;
    try {
      gate = evaluateTradeSetup({
        capital: usdt, riskPercent: RISK_PERCENT, leverage: 1,
        entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side,
        historicalWinRate: HISTORICAL_WIN_RATE, availableCapital: usdt, maxPositionPercent: MAX_POSITION_PERCENT,
      });
    } catch (err) {
      // The agreeing strategy's plan can go stale between signal detection and
      // here (e.g. a swing-level target price has already passed) — riskRewardRatio()
      // correctly rejects entry/stop/target combos that don't make sense for `side`.
      // That's a "stand down this cycle", not a scan failure.
      log(`${symbol}: confluence setup found (entry ${plan.entry}, stop ${plan.stop}, target ${plan.target}) but is invalid — ${err.message} — standing down`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'gate_failed' };
      continue;
    }

    if (!gate.passes) {
      log(`${symbol}: confluence setup found (entry ${plan.entry}, stop ${plan.stop}) but FAILS the risk gate — ${gate.reasons.join('; ')}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'gate_failed' };
      continue;
    }

    const asset = symbol.replace('USDT', '');
    const exec = translateForAccount({ plan, accountType: 'spot', positionSizeUsd: gate.position_size, heldQuantity: balanceOf(asset) });

    if (!exec.executable) {
      log(`${symbol}: confluence setup passes the gate (entry ${plan.entry}, stop ${plan.stop}, R:R 1:${gate.reward_per_risk.toFixed(2)}) ` +
          `but is NOT executable on this spot account — ${exec.note}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'not_executable' };
      continue;
    }

    const filters = await getSymbolFilters(symbol);
    const quantity = floorToStep(exec.quantity, filters.stepSize);
    const notional = quantity * plan.entry;
    if (quantity < filters.minQty || notional < filters.minNotional) {
      log(`${symbol}: confluence signal is valid but the executable size (${quantity} ${asset} ≈ $${notional.toFixed(2)}) ` +
          `falls below the exchange minimum (minQty ${filters.minQty}, minNotional $${filters.minNotional}) — skipping`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'below_exchange_minimum' };
      continue;
    }

    // Laddering (Ch.1, 1.9.2): "distribute multiple buy/sell orders... across
    // a price range... to lower the average entry price" rather than placing
    // it all at one price. Our strategies confirm a single precise CLOSE-based
    // entry (no "not sure where exactly" zone to spread across like the
    // curriculum's worked example), so the only price range already on hand
    // — and the only one that doesn't require inventing a new parameter — is
    // the trade's own risk envelope: [entry, stop]. Price may keep drifting
    // toward the stop before turning in our favor; laddering limit orders
    // across that span catches it at progressively better prices without ever
    // placing an order beyond the level that would invalidate the idea.
    // Falls back to the single market order this bot has always used when the
    // ladder can't be built (zero-width entry==stop) or a rung's size can't
    // clear the exchange minimums (laddering a near-minimum position into
    // dust-sized rungs would just get every leg rejected).
    const ladderLow = Math.min(plan.entry, plan.stop);
    const ladderHigh = Math.max(plan.entry, plan.stop);
    let ladder = null;
    if (ladderHigh > ladderLow) {
      const built = buildLadderOrders({ side: exec.order_side.toLowerCase(), totalSize: quantity, priceLow: ladderLow, priceHigh: ladderHigh, numOrders: LADDER_ORDERS });
      const rungs = built.orders.map(o => ({ price: roundToTick(o.price, filters.tickSize), size: floorToStep(o.size, filters.stepSize) }));
      if (rungs.every(r => r.size >= filters.minQty && r.size * r.price >= filters.minNotional)) ladder = rungs;
    }

    // Commit dedup key before placing orders — prevents re-fire if a rung throws
    state[symbol] = { last_signal_key: combinedKey, outcome: 'executing', executed_at: new Date().toISOString() };
    saveState(state);

    if (ladder) {
      log(`${symbol}: EXECUTING ${exec.order_side} ${quantity} ${asset} laddered into ${ladder.length} limit orders ` +
          `across ${ladderLow}-${ladderHigh} (avg ~${(ladder.reduce((s, r) => s + r.price, 0) / ladder.length).toFixed(8)}) — ` +
          `${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed (${exec.note})`);

      const orders = [];
      for (const rung of ladder) {
        try {
          const order = await placeOrder({ symbol, side: exec.order_side, type: 'LIMIT', quantity: rung.size, price: rung.price });
          log(`${symbol}: order result — ${JSON.stringify(order)}`);
          orders.push(order);
        } catch (err) {
          log(`${symbol}: ladder rung FAILED (price ${rung.price}, qty ${rung.size}) — ${err.message}`);
          emitEvent('error', 'order_failed', { symbol, kind: 'ladder_rung', price: rung.price, qty: rung.size, message: err.message });
        }
      }
      state[symbol] = { ...state[symbol], outcome: 'executed', orders };
    } else {
      log(`${symbol}: EXECUTING ${exec.order_side} ${quantity} ${asset} @ ~${plan.entry} — ` +
          `${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed (${exec.note})`);

      const order = await placeOrder({ symbol, side: exec.order_side, type: 'MARKET', quantity });
      log(`${symbol}: order result — ${JSON.stringify(order)}`);
      state[symbol] = { ...state[symbol], outcome: 'executed', orders: [order] };
    }

    // Spot has no exchange-side exit, so win%/expectancy still comes from
    // run_backtest.mjs — but record the 'open' phase for the trade journal
    // (exit/win-loss columns are left blank for spot until resolved manually).
    const combo = confluence.agreeing_strategies.slice().sort().join('+');
    appendLedger({
      phase: 'open', id: combinedKey, symbol, combo, side: exec.order_side,
      entry: plan.entry, stop: plan.stop, target: plan.target, planned_rr: Number(gate.reward_per_risk.toFixed(2)), qty: quantity,
    });
    emitEvent('info', 'trade_executed', {
      symbol,
      combo,
      side: exec.order_side,
      entry: plan.entry,
      stop: plan.stop,
      planned_rr: Number(gate.reward_per_risk.toFixed(2)),
      qty: quantity,
      order_count: state[symbol].orders?.length ?? 0,
      signal_key: combinedKey,
    });
  } catch (err) {
    log(`${symbol}: ERROR — ${err.message}`);
    emitEvent('error', 'scan_error', { symbol, message: err.message });
  }
}

saveState(state);
log('scan complete');
