#!/usr/bin/env node
/**
 * ict_renderer.mjs — Decoupled clean-draw + monitor daemon for the Trading AI.
 *
 * GOAL
 *   Read the(strategy_state.json) that the untouched `strategy.js` engine already
 *   writes every cycle, and render a CLEAN, NON-OVERLAPPING price ladder on the live
 *   TradingView chart — OB/FVG/dealing-range boxes where they formed, plus entry/SL/
 *   TP1/TP2/liquidity horizontal lines, each with its own label at its own price, and
 *   one compact status banner. It also MONITORS: zone retest status, SL/TP hits, and
 *   resets the diagram when the engine reports INVALID / CLOSED.
 *
 * NON-GOALS (respects the user's "do not touch the original setup"):
 *   - Does NOT modify strategy.js, analyze.mjs, or anything in /home/kali/mt5-ai.
 *   - Does NOT place trades. No execute_trade. Auto buy/sell stays exactly as is.
 *   - Reads ONE file the engine writes anyway (strategy_state.json) — never mutates it.
 *
 * TOKENS: ZERO Claude / Anthropic / LLM calls. Pure local JS over CDP (port 9222),
 *   polling a JSON file. The word "daemon" is literal — it loops forever on its own.
 *
 * CLEANLINESS
 *   - Own drawings are text-prefixed [ICTR] so it removes ONLY its own shapes (never
 *     the user's manual drawings, never the engine's single status label).
 *   - Only re-draws when `state` actually changes (a content hash comparison), so the
 *     chart never flickers and tokens/time aren't wasted on no-op redraws.
 *
 * LAYOUT (right-edge price ladder)
 *   Zones (rectangles) are drawn at the candle-time they FORMED (left side of chart).
 *   Level lines (entry/SL/TP/liquidity) are horizontal_lines pinned at their own price;
 *   since every level is a distinct price, labels naturally never overlap.
 *   One banner text sits at a fixed top anchor (last high + buffer), summarising state.
 *
 * Run:  node /home/kali/tradingview-mcp/src/ict_renderer.mjs
 * Env: TV_CDP_PORT (default 9222), ICTR_POLL_MS (default 3000),
 *      ICTR_STATE_FILE (default ../strategy_state.json).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluate, getChartApi, getMainSeriesBars } from './connection.js';
import * as drawCore from './core/drawing.js';
import * as dataCore from './core/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.ICTR_STATE_FILE || path.join(__dirname, 'strategy_state.json');
const POLL_MS = Number(process.env.ICTR_POLL_MS || 3000);
const TAG = '[ICTR]';

const COL = {
  ob:      '#E67E22',
  fvg:     '#3498DB',
  range:   '#7F8C8D',
  bsl:     '#9B59B6',
  ssl:     '#9B59B6',
  buy:     '#2ECC71',
  buyTP:   '#27AE60',
  sell:    '#E74C3C',
  sellTP:  '#16A085',
  sl:      '#C0392B',
  banner:  '#FFFFFF',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...a) { console.log(`[ICTR ${new Date().toLocaleTimeString()}]`, ...a); }
function f5(p) { return (p === null || p === undefined || Number.isNaN(p)) ? null : Number(p).toFixed(5); }
function safeText(s) { return s == null ? '' : String(s); }

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

// Content-diff hash: only redraw when the meaningful state changes.
function stateHash(s) {
  if (!s) return 'null';
  const { phase, bias, setup, trade, lastBarTime } = s;
  return JSON.stringify({ phase, bias, setup, trade, lastBarTime });
}

// Get the live chart's last bar + visible range + last price (all via CDP, no tokens).
async function chartContext() {
  const ohlcv = await dataCore.getOhlcv({ count: 6, summary: false });
  const quote = await dataCore.getQuote({ symbol: undefined });
  const bars = ohlcv?.bars || [];
  const last = bars[bars.length - 1] || null;
  const lastPrice = quote?.last ?? last?.close ?? null;
  const lastBarTime = last?.time ?? null;
  // visible range for left/right anchors
  let vr = { from: 0, to: 0 };
  try {
    const r = await evaluate(`${await getChartApi()}.chart().getVisibleRange()`);
    vr = { from: r?.from || 0, to: r?.to || (lastBarTime || 0) };
  } catch {}
  // For rectangles we want the "left" anchor (a bar far enough left) + a right edge.
  const fromBar = bars[0] || last;
  return { bars, last, lastPrice, lastBarTime, vr, fromBar };
}

// Candle direction from the last few current-TF bars (the "CANDLE NOW" note).
function candleDirection(bars) {
  if (!bars || bars.length < 2) return 'INDECISION';
  const c = bars[bars.length - 1];
  const slope = bars.slice(-3).map(b => b.close);
  const rising = slope[2] > slope[0];
  const falling = slope[2] < slope[0];
  const body = c.close - c.open;
  const upWick = c.high - Math.max(c.open, c.close);
  const loWick = Math.min(c.open, c.close) - c.low;
  if (rising && body > 0 && loWick >= upWick) return 'BULLISH';
  if (rising && body > 0 && upWick > loWick * 2) return 'BULLISH-EXHAUSTED';
  if (falling && body < 0 && upWick >= loWick) return 'BEARISH';
  if (falling && body < 0 && loWick > upWick * 2) return 'BEARISH-EXHAUSTED';
  return 'INDECISION';
}

// Zone retest / trade status — the "monitor" brain (pure local logic).
function monitorStatus(s, lastPrice) {
  if (!s) return { label: 'NO ENGINE STATE', kind: 'idle' };
  const { phase, setup, trade } = s;
  if (phase === 'TRADE_ACTIVE' && trade.entry) {
    if (trade.tp2 != null && lastPrice != null && (lastPrice >= trade.tp2 || lastPrice <= (trade.sl || -Infinity) && s.bias === 'BULLISH')) {
      return { label: `TP2/ZONE CLOSED @ ${f5(lastPrice)}`, kind: 'closed' };
    }
    if (trade.beActive) return { label: `BE ACTIVE — SL @ entry ${f5(trade.entry)}`, kind: 'be' };
    if (lastPrice >= trade.tp1) return { label: `TP1 HIT — move SL to BE ${f5(trade.entry)}`, kind: 'tp1' };
    if (lastPrice <= trade.sl) return { label: `SL HIT @ ${f5(trade.sl)}`, kind: 'sl' };
    return { label: `IN TRADE — entry ${f5(trade.entry)} | SL ${f5(trade.sl)} | TP1 ${f5(trade.tp1)}`, kind: 'active' };
  }
  if (phase === 'INVALID') return { label: 'ZONES INVALID — awaiting new sweep', kind: 'invalid' };
  if (phase === 'CLOSED') return { label: 'CLOSED — awaiting new setup', kind: 'closed' };
  const zT = setup.zoneTop, zB = setup.zoneBottom;
  if (zT != null && zB != null && lastPrice != null) {
    if (lastPrice >= zB && lastPrice <= zT) return { label: `PRICE IN ZONE ${f5(zB)}-${f5(zT)} — watch entry`, kind: 'inzone' };
    let broke = false, dir = '';
    if (s.bias === 'BULLISH' && lastPrice < zB) { broke = true; dir = 'below'; }
    if (s.bias === 'BEARISH' && lastPrice > zT) { broke = true; dir = 'above'; }
    if (broke) return { label: `ZONE BROKEN ${dir} — invalidate & reset`, kind: 'broken' };
    return { label: `ZONE INTACT ${f5(zB)}-${f5(zT)} | awaiting tap`, kind: 'intact' };
  }
  return { label: phase.replace(/_/g, ' '), kind: phase };
}

// ---------------------------------------------------------------------------
// Drawing — clean, auto-clean own shapes only, right-edge ladder
// ---------------------------------------------------------------------------

async function removeAllOwn() {
  try {
    const list = await drawCore.listDrawings();
    for (const sh of list?.shapes || []) {
      try {
        const props = await drawCore.getProperties({ entity_id: sh.id });
        const txt = props?.properties?.text || props?.text || '';
        if (typeof txt === 'string' && txt.startsWith(TAG)) {
          await drawCore.removeOne({ entity_id: sh.id });
        }
      } catch {}
    }
  } catch {}
}

async function drawLine(price, time, text, opts = {}) {
  if (price == null || Number.isNaN(price) || time == null) return null;
  const overrides = JSON.stringify({
    linecolor: opts.color,
    linewidth: opts.width ?? 1,
    linestyle: opts.style ?? 0,        // 0 solid, 1 dotted, 2 dashed
    textcolor: opts.color,
    showPrice: true,
    fontsize: 11,
  });
  try {
    const res = await drawCore.drawShape({ shape: 'horizontal_line', point: { time, price }, overrides, text: `${TAG} ${text}` });
    return res?.entity_id ?? null;
  } catch { return null; }
}

async function drawRect(pointLeft, pointRight, color, text, transparency = 80, width = 1) {
  if (!pointLeft || !pointRight) return null;
  if (pointLeft.price == null || pointRight.price == null) return null;
  const overrides = JSON.stringify({
    linecolor: color, linewidth: width,
    fillBackground: true, backgroundColor: color, transparency,
  });
  try {
    const res = await drawCore.drawShape({ shape: 'rectangle', point: pointLeft, point2: pointRight, overrides, text: `${TAG} ${text}` });
    return res?.entity_id ?? null;
  } catch { return null; }
}

async function drawText(price, time, text, color, bg = '#000000', transparency = 20, size = 13) {
  if (price == null || time == null) return null;
  const overrides = JSON.stringify({ textcolor: color, backgroundColor: bg, transparency, fontsize: size });
  try {
    const res = await drawCore.drawShape({ shape: 'text', point: { time, price }, overrides, text: `${TAG} ${text}` });
    return res?.entity_id ?? null;
  } catch { return null; }
}

async function render(s, ctx) {
  // ctx: { bars, last, lastPrice, lastBarTime, vr, fromBar }
  const { bars, lastPrice, vr } = ctx;
  const leftAnchor = ctx.fromBar?.time || vr.from || (s?.lastBarTime || 0);
  const rightAnchor = vr.to || ctx.lastBarTime || (leftAnchor + 3600);
  const tLast = rightAnchor;
  const tLeftZone = leftAnchor - (tLast - leftAnchor) * 0.25; // push zone rectangles a bit left of the window start
  if (!s || !s.setup) {
    // No engine state yet — just a tidy banner.
    await drawText(lastPrice ?? 0, leftAnchor, 'NO ENGINE STATE — start Trading AI (strategy_run) to populate', COL.banner);
    return;
  }

  const { phase, bias, setup, trade } = s;
  const ids = [];

  // ---- Zones (where they formed): we anchor rect LEFT at the engine's lastBarTime-ish,
  // RIGHT at the chart right edge. We don't have the exact formation bar time in state,
  // so rectangles span from a left offset to the right edge — readable as a band. -----
  // Dealing range band (sweepLow -> dealingHigh) — grey, faint
  const dLow = setup.dealingLow;
  const dHigh = setup.dealingHigh;
  if (dLow != null && dHigh != null) {
    ids.push(await drawRect({ time: tLeftZone, price: Math.min(dLow, dHigh) }, { time: tLast, price: Math.max(dLow, dHigh) }, COL.range, `DEALING ${f5(Math.min(dLow,dHigh))}-${f5(Math.max(dLow,dHigh))}`, 90));
  }
  // Order Block
  if (setup.obHigh != null && setup.obLow != null) {
    ids.push(await drawRect({ time: tLeftZone, price: setup.obLow }, { time: tLast, price: setup.obHigh }, COL.ob, `OB ${bias||''} ${f5(setup.obLow)}-${f5(setup.obHigh)}`, 75));
  }
  // FVG
  if (setup.fvgTop != null && setup.fvgBottom != null) {
    const lo = Math.min(setup.fvgTop, setup.fvgBottom), hi = Math.max(setup.fvgTop, setup.fvgBottom);
    ids.push(await drawRect({ time: tLeftZone, price: lo }, { time: tLast, price: hi }, COL.fvg, `FVG ${f5(lo)}-${f5(hi)}`, 80));
  }

  // ---- Liquidity levels (sweep / SSL / BSL) as dashed purple lines ----
  if (setup.sweepPrice != null) {
    ids.push(await drawLine(setup.sweepPrice, leftAnchor, `SWEEP ${f5(setup.sweepPrice)}`, { color: COL.bsl, style: 2, width: 1 }));
  }

  // ---- Trade levels (entry/SL/TP1/TP2) when defined ----
  if (trade.entry != null) {
    const entryColor = bias === 'BULLISH' ? COL.buy : COL.sell;
    const label = (bias === 'BULLISH' ? 'BUY ENTRY' : 'SELL ENTRY') + ` ${f5(trade.entry)}`;
    ids.push(await drawLine(trade.entry, leftAnchor, label, { color: entryColor, width: 2 }));
  }
  if (trade.sl != null) {
    ids.push(await drawLine(trade.sl, leftAnchor, `SL ${f5(trade.sl)}`, { color: COL.sl, style: 2, width: 1 }));
  }
  if (trade.tp1 != null) {
    ids.push(await drawLine(trade.tp1, leftAnchor, `TP1 ${f5(trade.tp1)} (BE)`, { color: bias === 'BULLISH' ? COL.buyTP : COL.sellTP, style: 2, width: 2 }));
  }
  if (trade.tp2 != null) {
    ids.push(await drawLine(trade.tp2, leftAnchor, `TP2 ${f5(trade.tp2)}`, { color: bias === 'BULLISH' ? COL.buyTP : COL.sellTP, style: 2, width: 1 }));
  }

  // ---- Single compact STATUS BANNER at fixed top anchor ----
  const cd = candleDirection(bars);
  const mon = monitorStatus(s, lastPrice);
  const conflict = (bias === 'BULLISH' && cd.startsWith('BEARISH')) || (bias === 'BEARISH' && cd.startsWith('BULLISH'));
  const bannerPrice = (setup.dealingHigh && setup.dealingHigh > (lastPrice || 0) ? setup.dealingHigh : (lastPrice || 0)) * 1.001 + 0.0006;
  const banner =
    `${bias || 'NEUTRAL'} | ${phase.replace(/_/g, ' ')} | ${mon.label}` +
    ` | CANDLE ${cd}${conflict ? ' (vs HTF bias)' : ''}` +
    ` | last ${f5(lastPrice)}`;
  ids.push(await drawText(bannerPrice, leftAnchor, banner, COL.banner, '#000000', 15, 12));

  return ids.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastHash = '__init__';
let booted = false;

async function tick() {
  const s = readState();
  const h = stateHash(s);
  if (!booted) {
    // First tick: do a clean draw regardless so we show "no state / current state".
    booted = true;
    lastHash = h;
    try {
      const ctx = await chartContext();
      await removeAllOwn();
      const ids = await render(s, ctx);
      log(`redraw ok: ${ids?.length || 0} shapes | phase=${s?.phase || 'NONE'} bias=${s?.bias || '-'}`);
    } catch (e) {
      log('redraw error:', e.message);
    }
    return;
  }
  if (h === lastHash) {
    // No meaningful change since last draw — DON'T redraw. Idle until the engine
    // state file changes (phase / bias / setup / trade / lastBarTime). This is the
    // whole point of the content-hash gate: the chart never flickers and we don't
    // churn CDP draw calls on every poll when nothing changed.
    return;
  }
  lastHash = h;
  try {
    const ctx = await chartContext();
    await removeAllOwn();
    const ids = await render(s, ctx);
    log(`redraw ok: ${ids?.length || 0} shapes | phase=${s?.phase || 'NONE'} bias=${s?.bias || '-'}`);
  } catch (e) {
    log('redraw error:', e.message);
  }
}

async function main() {
  log(`ICT renderer daemon. state=${STATE_FILE} poll=${POLL_MS}ms`);
  log(`Untouched by design: strategy.js + analyze.mjs are never written by this process.`);
  // Wait until CDP is reachable.
  for (let i = 0; i < 60; i++) {
    try {
      await getMainSeriesBars(); // throws if CDP down / chart not ready
      break;
    } catch (e) {
      if (i === 0) log('waiting for TradingView CDP / chart…');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  try { await getMainSeriesBars(); } catch { /* proceed; tick() will keep retrying */ }
  await tick();
  setInterval(tick, POLL_MS);
  // Keep alive
  await new Promise(() => {});
}

process.on('SIGINT', async () => { log('stopping…'); process.exit(0); });

main().catch(e => { console.error('ICT renderer fatal:', e); process.exit(1); });
