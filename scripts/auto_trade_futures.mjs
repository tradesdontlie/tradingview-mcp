#!/usr/bin/env node
/**
 * Autonomous futures trading bot — parallel to auto_trade.mjs (spot).
 *
 * Runs the identical dual-timeframe signal detection and confluence gate as the
 * spot bot, but executes on Binance USD-M Futures Testnet:
 *   - 2x ISOLATED leverage (curriculum cap is 5x; 2x is the conservative start)
 *   - Native short orders — no inventory constraint
 *   - Exchange-side STOP_MARKET + TAKE_PROFIT_MARKET orders placed at entry
 *     time so the position is self-managed even if the bot misses a scan
 *
 * Requires separate futures testnet credentials (register at testnet.binancefuture.com):
 *   BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET
 *
 * State is tracked in auto_trade_futures_state.json — completely independent
 * of the spot bot's state file so the two accounts don't interfere.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

const { getKlines, accountInfo, placeOrder, getPositions, setLeverage, setMarginType } =
  await import('../src/core/binance_futures.js');
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
const INTERVAL          = '15m';
const INTERVAL_HTF      = '4h';
const LEVERAGE          = 2;       // curriculum cap is 5x; 2x is the conservative starting point
const MARGIN_TYPE       = 'ISOLATED';
const RISK_PERCENT      = 1;
const MAX_POSITION_PERCENT = 15; // ceiling on single-trade notional as % of capital, independent of stop tightness
const HISTORICAL_WIN_RATE = 52;  // measured: 12W/23 resolved trades (2026-06-13), after enforcing a hard 1:1 reward:risk floor (RR<1 setups removed from the gate and backtest) on top of the pinbar dedup and chart_pattern target fixes. Win rate is lower than the old 61% but expectancy is far higher (avg R:R 1:6.6, total +101.6R / 23 trades)
const FRESHNESS_BARS    = 2;
const HTF_FRESHNESS_BARS = 3;
const LADDER_ORDERS     = 3;
const RSI_PERIOD        = 14;
const CVD_WINDOW        = 14;    // rolling-window size for CVD divergence (Ch.18) — same default as RSI_PERIOD
// Curriculum kill zones — institutional liquidity windows where clean moves form.
// Outside these windows the bot stands down to avoid low-liquidity chop.
const KILL_ZONES = [
  { name: 'London Open', startUtc: 7,  endUtc: 10 },
  { name: 'NY Open',     startUtc: 13, endUtc: 16 },
];

const STATE_PATH = join(ROOT, 'auto_trade_futures_state.json');
const LOG_PATH   = join(ROOT, 'auto_trade_futures.log');
const EVENTS_PATH = join(ROOT, 'bot_events.jsonl');    // escalation feed read by the orchestrator agent
const LEDGER_PATH = join(ROOT, 'trade_ledger.jsonl');  // resolved-trade ledger read by the orchestrator agent

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

// Append one structured escalation event for the orchestrator agent. Never throws.
function emitEvent(severity, type, fields = {}) {
  try {
    const rec = { ts: new Date().toISOString(), bot: 'futures', severity, type, ...fields };
    appendFileSync(EVENTS_PATH, JSON.stringify(rec) + '\n');
  } catch { /* escalation is best-effort */ }
}
// Append one trade-lifecycle record (phase 'open' | 'close') for the orchestrator. Never throws.
function appendLedger(record) {
  try {
    appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), bot: 'futures', ...record }) + '\n');
  } catch { /* best-effort */ }
}

// ---- Orchestrator control plane ------------------------------------------
// The orchestrator agent writes orchestrator_config.json to enable/disable
// strategies and filters based on measured win% / expectancy. This bot reads
// the `futures` section once per pass and runs ONLY what's active — always
// clamped to the hard-coded validated universe below: config can NARROW
// behavior, never invent it. The kill-zone window is a fixed curriculum
// constraint and is intentionally NOT agent-controllable. Futures has no
// daily_structure filter (it shorts freely). A missing or malformed file fails
// OPEN to all-active (current behavior), never into a degraded state.
const ORCH_CONFIG_PATH     = join(ROOT, 'orchestrator_config.json');
const VALIDATED_STRATEGIES = new Set(['sfp', 'divergence', 'cvd_divergence', 'levels', 'fibonacci', 'market_structure', 'pinbar', 'chart_pattern']);
const VALIDATED_FILTERS    = new Set(['pinbar_bias_4h', 'vwap_bias', 'value_area_bias']);

function loadOrchestratorConfig() {
  const failOpen = { active_strategies: new Set(VALIDATED_STRATEGIES), active_filters: {} };
  if (!existsSync(ORCH_CONFIG_PATH)) return failOpen;
  try {
    const cfg = JSON.parse(readFileSync(ORCH_CONFIG_PATH, 'utf8'));
    const section = cfg.futures ?? {};
    const declared = Array.isArray(section.active_strategies) ? section.active_strategies : null;
    // Clamp to the validated universe — config can only narrow, never extend.
    const active = declared
      ? new Set(declared.filter(s => VALIDATED_STRATEGIES.has(s)))
      : new Set(VALIDATED_STRATEGIES);
    if (active.size === 0) {
      log('orchestrator_config: futures.active_strategies empty after clamp — failing open to all strategies');
      emitEvent('warn', 'config_fail_open', { reason: 'futures.active_strategies empty after clamp' });
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

async function getSymbolFilters(symbol) {
  const res = await fetch(`https://testnet.binancefuture.com/fapi/v1/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  const filters = data.symbols[0].filters;
  const lot = filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = filters.find(f => f.filterType === 'MIN_NOTIONAL');
  const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    minNotional: Number(notional?.notional ?? notional?.minNotional ?? 0),
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
  return {
    strategy: 'sfp',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `sfp:${type}:${hit.bar.open_time}`,
    summary: `${type} SFP (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
  };
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
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const { direction, hits } = scanForFibReaction(klines, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = direction === 'bullish' ? rangeHigh : rangeLow;
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

  const realigning = choch.filter(c => c.direction === trend);
  if (!realigning.length) return null;
  const latest = realigning[realigning.length - 1];
  if (lastIndex - latest.index > FRESHNESS_BARS) return null;

  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: latest, trend, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'market_structure',
    plan,
    confirmedAt: latest.bar.open_time,
    signalKey: `market_structure:${trend}:choch${latest.sequenceNumber}:${latest.bar.open_time}`,
    summary: `${trend} BOS + realigning CHoCH#${latest.sequenceNumber} (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) {
  const { lastIndex } = ctx4h;
  const { hits } = scanForPinbarSetup(klines4h, { swingHighs: swingHighs4h, swingLows: swingLows4h });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > HTF_FRESHNESS_BARS) return null;
  return { direction: hit.direction };
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
  return {
    strategy: 'pinbar',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `pinbar:${hit.direction}:${hit.biasBar.open_time}:${hit.bar.open_time}`,
    summary: `${hit.direction} pinbar at swing extreme + level retest (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

// Classic chart patterns (Double Top/Bottom, H&S/Inverse H&S, Triangles,
// Flag/Pennant) — see src/core/chart_patterns.js. Not from the PDF curriculum;
// the 8th execution strategy, encoded with the same close-based-confirmation
// + measured-move-target conventions as the other seven.
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
    summary: `${pattern.type.replace(/_/g, ' ')} breakout (entry ${plan.entry}, stop ${plan.stop})`,
  };
}


// ---- Main scan --------------------------------------------------------------

const state = loadState();

let info;
try {
  info = await accountInfo();
} catch (err) {
  log(`FATAL: cannot fetch futures account — ${err.message}`);
  log('Ensure BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET are set and the futures testnet is accessible.');
  process.exit(1);
}

const usdt = info.balances.find(b => b.asset === 'USDT')?.free ?? 0;
log(`scan start — interval=${INTERVAL}/${INTERVAL_HTF} leverage=${LEVERAGE}x margin=${MARGIN_TYPE} symbols=${SYMBOLS.join(',')} usdt_balance=${usdt}`);

const utcHour = new Date().getUTCHours();
const activeSession = KILL_ZONES.find(z => utcHour >= z.startUtc && utcHour < z.endUtc);
if (!activeSession) {
  log(`outside kill zones (UTC ${utcHour}:xx) — London Open 07-10, NY Open 13-16 — no trades this scan`);
  log('scan complete');
  process.exit(0);
}
log(`${activeSession.name} kill zone active — proceeding`);

const orch = loadOrchestratorConfig();
log(`orchestrator config — strategies: ${[...orch.active_strategies].join(',')} | filters: ${[...VALIDATED_FILTERS].map(f => `${f}=${filterEnabled(orch, f) ? 'on' : 'off'}`).join(' ')}`);

for (const symbol of SYMBOLS) {
  try {
    // Check for an open position first — don't re-enter while one is live
    const { positions } = await getPositions(symbol);
    const openPos = positions.find(p => p.symbol === symbol);

    if (openPos) {
      log(`${symbol}: open ${openPos.side} position (qty ${openPos.quantity} @ ${openPos.entry_price}, PnL ${openPos.unrealized_pnl.toFixed(2)} USDT) — skipping new entries`);
      continue;
    }

    // Position gone but state still says open/executing — SL/TP was hit or manually closed.
    // Resolve win/loss by scanning 15m bars since entry for the first SL/TP touch.
    // SL/TP are STOP_MARKET/TAKE_PROFIT_MARKET (trigger on a wick touch), so a high/low
    // touch is the correct trigger test. Fixed-R outcome, matching the backtest model:
    // win = planned R:R, loss = -1R. A single bar spanning both levels is booked as a
    // loss (conservative stop-first assumption). No first touch found => 'manual'.
    if (state[symbol]?.outcome === 'open' || state[symbol]?.outcome === 'executing') {
      const st = state[symbol];
      let exitReason = 'manual', win = null, realizedR = null;
      try {
        const { klines: rk } = await getKlines({ symbol, interval: INTERVAL, limit: 150 });
        const since = st.executed_at ? Date.parse(st.executed_at) : 0;
        const isLong = st.position_side === 'long';
        for (const b of rk) {
          if (b.open_time < since) continue;
          const hitSL = isLong ? b.low <= st.sl_price : b.high >= st.sl_price;
          const hitTP = isLong ? b.high >= st.tp_price : b.low <= st.tp_price;
          if (hitSL) { exitReason = 'sl'; win = false; break; }
          if (hitTP) { exitReason = 'tp'; win = true; break; }
        }
        realizedR = win === true ? (st.planned_rr ?? null) : win === false ? -1 : null;
      } catch (e) {
        emitEvent('warn', 'ledger_resolution_failed', { symbol, message: e.message });
      }
      log(`${symbol}: position closed (${exitReason}${win === null ? '' : win ? ' — WIN' : ' — LOSS'}) — ready for next setup`);
      appendLedger({
        phase: 'close', id: st.last_signal_key ?? null, symbol,
        combo: st.combo ?? null, side: st.position_side ?? null,
        entry: st.entry_price ?? null, stop: st.sl_price ?? null, target: st.tp_price ?? null,
        qty: st.qty ?? null, planned_rr: st.planned_rr ?? null,
        exit_reason: exitReason, win, realized_r: realizedR,
        opened_at: st.executed_at ?? null, closed_at: new Date().toISOString(),
      });
      emitEvent('info', 'trade_close', { symbol, combo: st.combo ?? null, exit_reason: exitReason, win, realized_r: realizedR });
      state[symbol] = { ...st, outcome: 'closed', closed_at: new Date().toISOString(), exit_reason: exitReason, win, realized_r: realizedR };
    }

    // Fetch klines — futures trades both directions so no daily bias filter;
    // only 15m execution TF and 4H for divergence + pinbar bias are needed.
    const [{ klines: rawKlines }, { klines: rawKlines4h }] = await Promise.all([
      getKlines({ symbol, interval: INTERVAL,     limit: 150 }),
      getKlines({ symbol, interval: INTERVAL_HTF, limit: 100 }),
    ]);

    // Drop the still-forming bar (last bar is incomplete)
    const klines   = rawKlines.slice(0, -1);
    const klines4h = rawKlines4h.slice(0, -1);

    const swingHighs = findSwingHighs(klines,  { lookback: 3 });
    const swingLows  = findSwingLows(klines,   { lookback: 3 });
    if (!swingHighs.length || !swingLows.length) { log(`${symbol}: insufficient swing points — skipping`); continue; }

    const ctx = {
      lastSwingHigh: swingHighs[swingHighs.length - 1],
      lastSwingLow:  swingLows[swingLows.length - 1],
      rangeHigh: Math.max(...klines.map(k => k.high)),
      rangeLow:  Math.min(...klines.map(k => k.low)),
      lastIndex: klines.length - 1,
    };

    const swingHighs4h = klines4h.length >= 10 ? findSwingHighs(klines4h, { lookback: 3 }) : [];
    const swingLows4h  = klines4h.length >= 10 ? findSwingLows(klines4h,  { lookback: 3 }) : [];
    const ctx4h = (swingHighs4h.length && swingLows4h.length) ? {
      lastSwingHigh: swingHighs4h[swingHighs4h.length - 1],
      lastSwingLow:  swingLows4h[swingLows4h.length - 1],
      rangeHigh: Math.max(...klines4h.map(k => k.high)),
      rangeLow:  Math.min(...klines4h.map(k => k.low)),
      lastIndex: klines4h.length - 1,
    } : null;

    const sfpSignal        = findFreshSFPSignal(klines, ctx);
    const levelsSignal     = findFreshLevelZoneSignal(klines, ctx);
    const fibSignal        = findFreshFibSignal(klines, ctx);
    const structureSignal  = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
    const pinbarSignal     = findFreshPinbarSignal(klines, ctx, swingHighs, swingLows);
    const cvdDivergenceSignal = findFreshCVDDivergenceSignal(klines, ctx);
    const divergenceSignal = ctx4h ? findFreshDivergenceSignal(klines4h, ctx4h) : null;
    const htfBias          = ctx4h ? findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) : null;
    const chartPatternSignal = findFreshChartPatternSignal(klines, ctx, swingHighs, swingLows);

    let signals = [sfpSignal, levelsSignal, fibSignal, structureSignal, pinbarSignal, divergenceSignal, cvdDivergenceSignal, chartPatternSignal]
      .filter(Boolean)
      .filter(s => orch.active_strategies.has(s.strategy));   // orchestrator: run only active strategies

    // 4H pinbar bias — filter opposing signals, with divergence+levels exemption.
    // Same logic as the spot bot's daily bias exemption: a divergence+levels pair
    // pointing counter to the 4H pinbar is a high-conviction reversal (Ch.6 + Ch.10/11)
    // and should not be blocked on a futures account where both directions are valid.
    if (htfBias && filterEnabled(orch, 'pinbar_bias_4h')) {
      const biasSide  = htfBias.direction === 'bullish' ? 'long' : 'short';
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
        log(`${symbol}: 4H pinbar bias (${htfBias.direction}) filtered out ${before - signals.length} opposing signal(s)${exemptPair ? ' — divergence+levels reversal pair exempted' : ''}`);
    }

    // No daily bias filter — futures trades both directions freely.

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

    if (!signals.length) { log(`${symbol}: no fresh signals`); continue; }

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

    // Ch.6 same-role level entry rules (identical to spot bot):
    // 2nd same-role touch → SFP required; 3rd+ touch → divergence required.
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

    // availableCapital = usdt * LEVERAGE: the notional position size is capped at
    // what 2x leverage on our available margin can control
    let gate;
    try {
      gate = evaluateTradeSetup({
        capital: usdt, riskPercent: RISK_PERCENT, leverage: LEVERAGE,
        entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side,
        historicalWinRate: HISTORICAL_WIN_RATE, availableCapital: usdt * LEVERAGE, maxPositionPercent: MAX_POSITION_PERCENT,
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

    const exec = translateForAccount({ plan, accountType: 'futures', positionSizeUsd: gate.position_size });

    if (!exec.executable) {
      log(`${symbol}: not executable — ${exec.note}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'not_executable' };
      continue;
    }

    const filters = await getSymbolFilters(symbol);
    const quantity = floorToStep(exec.quantity, filters.stepSize);
    const notional = quantity * plan.entry;
    if (quantity < filters.minQty || notional < filters.minNotional) {
      log(`${symbol}: executable size (${quantity} ≈ $${notional.toFixed(2)}) below exchange minimum — skipping`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'below_exchange_minimum' };
      continue;
    }

    // Build price ladder across [entry, stop] range — same mechanic as spot bot
    const ladderLow  = Math.min(plan.entry, plan.stop);
    const ladderHigh = Math.max(plan.entry, plan.stop);
    let ladder = null;
    if (ladderHigh > ladderLow) {
      const built = buildLadderOrders({ side: exec.order_side.toLowerCase(), totalSize: quantity, priceLow: ladderLow, priceHigh: ladderHigh, numOrders: LADDER_ORDERS });
      const rungs = built.orders.map(o => ({ price: roundToTick(o.price, filters.tickSize), size: floorToStep(o.size, filters.stepSize) }));
      if (rungs.every(r => r.size >= filters.minQty && r.size * r.price >= filters.minNotional)) ladder = rungs;
    }

    // SL/TP sides are always opposite to the entry side
    const closeSide = plan.side === 'short' ? 'BUY' : 'SELL';
    const slPrice   = roundToTick(plan.stop,   filters.tickSize);
    const tpPrice   = roundToTick(plan.target, filters.tickSize);

    // Idempotent — Binance ignores if already set correctly
    await setLeverage({ symbol, leverage: LEVERAGE });
    await setMarginType({ symbol, marginType: MARGIN_TYPE });

    // Commit dedup key before placing orders — prevents re-fire if execution throws
    const combo = confluence.agreeing_strategies.slice().sort().join('+');
    const plannedRr = Number(gate.reward_per_risk.toFixed(2));
    state[symbol] = {
      last_signal_key: combinedKey,
      outcome: 'executing',
      position_side: plan.side,
      entry_price: plan.entry,
      sl_price: slPrice,
      tp_price: tpPrice,
      combo,                       // recorded so the close phase can book the ledger
      planned_rr: plannedRr,       // win R = planned R:R; loss = -1R (fixed-R model)
      qty: quantity,                // recorded for the trade journal's position-size column
      executed_at: new Date().toISOString(),
    };
    saveState(state);

    // Ledger: open phase. The close phase is booked when the position is later
    // detected gone (top of the loop), pairing on `id` = last_signal_key.
    appendLedger({
      phase: 'open', id: combinedKey, symbol, combo, side: plan.side,
      entry: plan.entry, stop: slPrice, target: tpPrice, planned_rr: plannedRr, qty: quantity,
    });
    emitEvent('info', 'trade_open', { symbol, combo, side: plan.side, entry: plan.entry, planned_rr: plannedRr });

    // Place entry ladder
    const entryOrders = [];
    if (ladder) {
      const avgPrice = (ladder.reduce((s, r) => s + r.price, 0) / ladder.length).toFixed(8);
      log(`${symbol}: EXECUTING ${exec.order_side.toUpperCase()} ${quantity} (${LEVERAGE}x) laddered into ${ladder.length} limit orders across ${ladderLow}-${ladderHigh} (avg ~${avgPrice}) — ${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed`);
      for (const rung of ladder) {
        try {
          const order = await placeOrder({ symbol, side: exec.order_side.toUpperCase(), type: 'LIMIT', quantity: rung.size, price: rung.price });
          log(`${symbol}: entry order — ${JSON.stringify(order)}`);
          entryOrders.push(order);
        } catch (err) {
          log(`${symbol}: entry rung FAILED (price ${rung.price}, qty ${rung.size}) — ${err.message}`);
          emitEvent('error', 'order_failed', { symbol, kind: 'ladder_rung', price: rung.price, qty: rung.size, message: err.message });
        }
      }
    } else {
      log(`${symbol}: EXECUTING ${exec.order_side.toUpperCase()} ${quantity} (${LEVERAGE}x) @ ~${plan.entry} — ${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed`);
      try {
        const order = await placeOrder({ symbol, side: exec.order_side.toUpperCase(), type: 'MARKET', quantity });
        log(`${symbol}: entry order — ${JSON.stringify(order)}`);
        entryOrders.push(order);
      } catch (err) {
        log(`${symbol}: entry order FAILED — ${err.message}`);
        emitEvent('error', 'order_failed', { symbol, kind: 'market_entry', message: err.message });
      }
    }

    // Place SL and TP — closePosition: true so they close whatever fills, regardless of which rungs filled
    let slOrderId = null;
    let tpOrderId = null;

    try {
      const slOrder = await placeOrder({ symbol, side: closeSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: true });
      log(`${symbol}: SL order placed — stopPrice ${slPrice} (${JSON.stringify(slOrder)})`);
      slOrderId = slOrder.order_id;
    } catch (err) {
      log(`${symbol}: SL order FAILED — ${err.message}`);
    }

    try {
      const tpOrder = await placeOrder({ symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: true });
      log(`${symbol}: TP order placed — stopPrice ${tpPrice} (${JSON.stringify(tpOrder)})`);
      tpOrderId = tpOrder.order_id;
    } catch (err) {
      log(`${symbol}: TP order FAILED — ${err.message}`);
    }

    state[symbol] = {
      ...state[symbol],
      outcome: 'open',
      entry_orders: entryOrders,
      sl_order_id: slOrderId,
      tp_order_id: tpOrderId,
    };

  } catch (err) {
    log(`${symbol}: ERROR — ${err.message}`);
    emitEvent('error', 'scan_error', { symbol, message: err.message });
  }
}

saveState(state);
log('scan complete');
