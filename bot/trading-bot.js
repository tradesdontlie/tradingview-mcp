#!/usr/bin/env node
/**
 * TradingView MCP — Advanced Trading Bot
 *
 * Reads live chart data via CDP and runs a multi-indicator signal engine.
 * Supports paper trading via TradingView's built-in replay mode.
 *
 * Usage:
 *   node bot/trading-bot.js                      # use chart's current symbol/timeframe
 *   node bot/trading-bot.js --symbol ES1!        # override symbol
 *   node bot/trading-bot.js --tf 5               # override timeframe (minutes)
 *   node bot/trading-bot.js --interval 30        # poll every 30 seconds (default)
 *   node bot/trading-bot.js --paper              # enable replay paper trading
 *   node bot/trading-bot.js --threshold 55       # signal confidence threshold 0-100 (default 55)
 *   node bot/trading-bot.js --risk 1.5           # risk % per trade (default 1)
 *   node bot/trading-bot.js --rr 2               # reward:risk ratio target (default 2)
 *   node bot/trading-bot.js --once               # run one scan then exit
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as replay from '../src/core/replay.js';
import * as drawing from '../src/core/drawing.js';
import { disconnect } from '../src/connection.js';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const CONFIG = {
  symbol:        args['--symbol']    ?? null,
  timeframe:     args['--tf']        ?? null,
  intervalSec:   Number(args['--interval']  ?? 30),
  threshold:     Number(args['--threshold'] ?? 55),
  riskPct:       Number(args['--risk']      ?? 1),
  rewardRisk:    Number(args['--rr']        ?? 2),
  paperTrade:    '--paper' in args,
  once:          '--once'  in args,
  maxPositions:  1,
  atrMultiplier: 1.5,  // stop distance = ATR × this
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i]] = argv[i + 1]?.startsWith('--') ? true : (argv[i + 1] ?? true);
      if (out[argv[i]] !== true) i++;
    }
  }
  return out;
}

// ─── Terminal colors ───────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
};

// ─── Logger ────────────────────────────────────────────────────────────────────

const log = {
  _ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); },
  info(msg)  { console.log(`${C.dim}${this._ts()}${C.reset} ${C.cyan}ℹ${C.reset}  ${msg}`); },
  ok(msg)    { console.log(`${C.dim}${this._ts()}${C.reset} ${C.green}✓${C.reset}  ${msg}`); },
  warn(msg)  { console.log(`${C.dim}${this._ts()}${C.reset} ${C.yellow}⚠${C.reset}  ${msg}`); },
  error(msg) { console.log(`${C.dim}${this._ts()}${C.reset} ${C.red}✗${C.reset}  ${msg}`); },
  signal(direction, score, reason) {
    const arrow = direction === 'LONG' ? `${C.bgGreen}${C.bold} LONG ` : `${C.bgRed}${C.bold} SHORT `;
    console.log(`\n${C.dim}${this._ts()}${C.reset} ${arrow}${C.reset} ${C.bold}score=${score}${C.reset}  ${C.dim}${reason}${C.reset}\n`);
  },
  header(title) {
    const line = '─'.repeat(60);
    console.log(`\n${C.cyan}${line}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
    console.log(`${C.cyan}${line}${C.reset}`);
  },
  row(label, value, color = C.white) {
    const pad = 22;
    console.log(`  ${C.dim}${label.padEnd(pad)}${C.reset}${color}${value}${C.reset}`);
  },
};

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  position:   null,   // { side: 'LONG'|'SHORT', entry: number, stop: number, target: number, size: number, bar: number }
  barCount:   0,
  lastSignal: null,
  trades:     [],     // completed paper trades
  equity:     10000,  // starting paper equity
  scanCount:  0,
};

// ─── Market Reader ─────────────────────────────────────────────────────────────

async function readMarket() {
  const [chartState, quote, ohlcv, studies] = await Promise.all([
    chart.getState(),
    data.getQuote(),
    data.getOhlcv({ count: 50, summary: false }),
    data.getStudyValues(),
  ]);

  const pineLines  = await safeCall(() => data.getPineLines({}),  { studies: [] });
  const pineLabels = await safeCall(() => data.getPineLabels({}), { studies: [] });

  return { chartState, quote, ohlcv, studies, pineLines, pineLabels };
}

async function safeCall(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

// ─── Indicator Parser ──────────────────────────────────────────────────────────

function parseStudies(studyData) {
  const out = {};
  if (!studyData?.success || !studyData.studies) return out;

  for (const study of studyData.studies) {
    const name = (study.name || '').toLowerCase();
    const vals  = study.values || {};

    if (/rsi/.test(name)) {
      const v = firstNumeric(vals);
      if (v !== null) out.rsi = v;
    }
    if (/macd/.test(name)) {
      out.macd        = findValue(vals, ['MACD', 'macd', 'Value']);
      out.macdSignal  = findValue(vals, ['Signal', 'signal', 'Sig']);
      out.macdHist    = findValue(vals, ['Histogram', 'hist', 'Diff']);
    }
    if (/bollinger|bb bands/.test(name)) {
      out.bbUpper = findValue(vals, ['Upper', 'upper', 'UB']);
      out.bbMiddle= findValue(vals, ['Basis', 'Middle', 'middle', 'MB']);
      out.bbLower = findValue(vals, ['Lower', 'lower', 'LB']);
    }
    if (/ema.*200|200.*ema/.test(name)) out.ema200 = firstNumeric(vals);
    if (/ema.*50|50.*ema/.test(name))  out.ema50  = firstNumeric(vals);
    if (/ema.*20|20.*ema/.test(name))  out.ema20  = firstNumeric(vals);
    if (/sma.*200|200.*sma/.test(name)) out.sma200 = firstNumeric(vals);
    if (/atr/.test(name)) out.atr = firstNumeric(vals);
    if (/stoch/.test(name)) {
      out.stochK = findValue(vals, ['%K', 'K', 'Stoch']);
      out.stochD = findValue(vals, ['%D', 'D', 'Signal']);
    }
    if (/cci/.test(name)) out.cci = firstNumeric(vals);
    if (/williams|%r/.test(name)) out.williamsR = firstNumeric(vals);
    if (/volume/.test(name) && /ma|avg/.test(name)) out.volMa = firstNumeric(vals);
  }
  return out;
}

function firstNumeric(obj) {
  for (const v of Object.values(obj)) {
    const n = parseFloat(String(v).replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findValue(obj, keys) {
  for (const k of keys) {
    for (const [ok, ov] of Object.entries(obj)) {
      if (ok.toLowerCase().includes(k.toLowerCase())) {
        const n = parseFloat(String(ov).replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

// ─── Key Level Extractor ───────────────────────────────────────────────────────

function extractKeyLevels(pineLines, pineLabels, price) {
  const levels = [];

  // getPineLines returns { studies: [{ name, horizontal_levels: number[] }] }
  for (const study of pineLines?.studies ?? []) {
    for (const lvl of study.horizontal_levels ?? []) {
      if (typeof lvl === 'number') {
        levels.push({ price: lvl, source: study.name, type: 'line' });
      }
    }
  }

  // getPineLabels returns { studies: [{ name, labels: [{ text, price }] }] }
  for (const study of pineLabels?.studies ?? []) {
    for (const label of study.labels ?? []) {
      if (typeof label.price === 'number') {
        const text = (label.text || '').toLowerCase();
        const type = /support|low|floor|bid/.test(text) ? 'support'
                   : /resist|high|ceil|offer|ask/.test(text) ? 'resistance'
                   : 'level';
        levels.push({ price: label.price, text: label.text, source: study.name, type });
      }
    }
  }

  levels.sort((a, b) => a.price - b.price);

  const nearRange  = price * 0.003; // within 0.3%
  const support    = levels.filter(l => l.price < price).slice(-3);   // up to 3 below
  const resistance = levels.filter(l => l.price > price).slice(0, 3); // up to 3 above
  const nearSupport    = support.filter(l => price - l.price < nearRange);
  const nearResistance = resistance.filter(l => l.price - price < nearRange);

  return { support, resistance, nearSupport, nearResistance, all: levels };
}

// ─── Price Action Analyzer ─────────────────────────────────────────────────────

function analyzePriceAction(bars) {
  if (!bars || bars.length < 3) return {};

  const recent = bars.slice(-5);
  const last   = recent[recent.length - 1];
  const prev   = recent[recent.length - 2];
  const body   = last.close - last.open;
  const prevBody = prev.close - prev.open;
  const range  = last.high - last.low;

  let pattern = null;
  let patternScore = 0;

  // Bullish engulfing
  if (prevBody < 0 && body > 0 && Math.abs(body) > Math.abs(prevBody) * 1.1) {
    pattern = 'bullish_engulfing';
    patternScore = 15;
  }
  // Bearish engulfing
  else if (prevBody > 0 && body < 0 && Math.abs(body) > Math.abs(prevBody) * 1.1) {
    pattern = 'bearish_engulfing';
    patternScore = -15;
  }
  // Hammer (bullish)
  else if (body > 0 && range > 0 &&
           (last.open - last.low) > body * 2 &&
           (last.high - last.close) < body * 0.5) {
    pattern = 'hammer';
    patternScore = 10;
  }
  // Shooting star (bearish)
  else if (body < 0 && range > 0 &&
           (last.high - last.open) > Math.abs(body) * 2 &&
           (last.close - last.low) < Math.abs(body) * 0.5) {
    pattern = 'shooting_star';
    patternScore = -10;
  }
  // Doji
  else if (Math.abs(body) < range * 0.1) {
    pattern = 'doji';
    patternScore = 0;
  }

  // Short-term momentum: count up vs down bars in last 5
  const upBars   = recent.filter(b => b.close > b.open).length;
  const downBars = recent.length - upBars;
  const momentum = upBars > downBars ? (upBars - downBars) * 3 : -(downBars - upBars) * 3;

  // Volume surge
  const avgVol = recent.slice(0, -1).reduce((s, b) => s + b.volume, 0) / (recent.length - 1);
  const volSurge = last.volume > avgVol * 1.5;

  return { pattern, patternScore, momentum, volSurge, lastBar: last, upBars, downBars };
}

// ─── Signal Engine ─────────────────────────────────────────────────────────────
//
// Returns a score from -100 (max bearish) to +100 (max bullish).
// Each factor contributes proportionally to its weight.
// |score| >= CONFIG.threshold triggers a signal.

function scoreSignal(price, indicators, keyLevels, priceAction) {
  let score  = 0;
  const factors = [];

  // ── RSI ──────────────────────────────────────────────────────────────────────
  if (indicators.rsi !== null && indicators.rsi !== undefined) {
    const rsi = indicators.rsi;
    let rsiFactor = 0;
    if (rsi < 30)      { rsiFactor = 20;  factors.push(`RSI oversold(${rsi.toFixed(1)})+20`); }
    else if (rsi < 40) { rsiFactor = 8;   factors.push(`RSI low(${rsi.toFixed(1)})+8`); }
    else if (rsi > 70) { rsiFactor = -20; factors.push(`RSI overbought(${rsi.toFixed(1)})-20`); }
    else if (rsi > 60) { rsiFactor = -8;  factors.push(`RSI high(${rsi.toFixed(1)})-8`); }
    else               { factors.push(`RSI neutral(${rsi.toFixed(1)})`); }
    score += rsiFactor;
  }

  // ── MACD ─────────────────────────────────────────────────────────────────────
  if (indicators.macd !== null && indicators.macdSignal !== null &&
      indicators.macd !== undefined && indicators.macdSignal !== undefined) {
    const diff = indicators.macd - indicators.macdSignal;
    if (diff > 0) { score += 18; factors.push(`MACD bullish cross+18`); }
    else          { score -= 18; factors.push(`MACD bearish cross-18`); }

    // Histogram momentum
    if (indicators.macdHist !== null && indicators.macdHist !== undefined) {
      const prevHist = indicators.macdHist;
      if (prevHist > 0 && diff > 0)  { score += 5; factors.push(`MACD hist expanding+5`); }
      if (prevHist < 0 && diff < 0)  { score -= 5; factors.push(`MACD hist expanding-5`); }
    }
  }

  // ── Bollinger Bands ───────────────────────────────────────────────────────────
  if (indicators.bbUpper && indicators.bbLower && indicators.bbMiddle) {
    const bbRange = indicators.bbUpper - indicators.bbLower;
    const pctB    = (price - indicators.bbLower) / (bbRange || 1);
    if (pctB < 0.05)      { score += 15; factors.push(`BB below lower+15`); }
    else if (pctB < 0.2)  { score += 7;  factors.push(`BB near lower+7`); }
    else if (pctB > 0.95) { score -= 15; factors.push(`BB above upper-15`); }
    else if (pctB > 0.8)  { score -= 7;  factors.push(`BB near upper-7`); }
    else                  { factors.push(`BB mid zone(${(pctB*100).toFixed(0)}%)`); }
  }

  // ── Moving Average Trend ──────────────────────────────────────────────────────
  const ema = indicators.ema200 ?? indicators.sma200 ?? indicators.ema50;
  if (ema) {
    const trend = (price - ema) / ema * 100;  // % above/below MA
    if (trend > 0.1)       { score += 20; factors.push(`Price>${ema > indicators.ema50 ? 'EMA200' : 'EMA50'}+20`); }
    else if (trend > 0)    { score += 8;  factors.push(`Price just above MA+8`); }
    else if (trend < -0.1) { score -= 20; factors.push(`Price<MA-20`); }
    else                   { score -= 8;  factors.push(`Price just below MA-8`); }
  }

  // Short MA cross (EMA20 vs EMA50)
  if (indicators.ema20 && indicators.ema50) {
    if (indicators.ema20 > indicators.ema50) { score += 8; factors.push(`EMA20>EMA50+8`); }
    else                                      { score -= 8; factors.push(`EMA20<EMA50-8`); }
  }

  // ── Stochastic ────────────────────────────────────────────────────────────────
  if (indicators.stochK !== null && indicators.stochK !== undefined) {
    const k = indicators.stochK;
    if (k < 20)      { score += 10; factors.push(`Stoch oversold+10`); }
    else if (k > 80) { score -= 10; factors.push(`Stoch overbought-10`); }
  }

  // ── CCI / Williams %R ─────────────────────────────────────────────────────────
  if (indicators.cci !== null && indicators.cci !== undefined) {
    if (indicators.cci < -100) { score += 8; factors.push(`CCI oversold+8`); }
    if (indicators.cci > 100)  { score -= 8; factors.push(`CCI overbought-8`); }
  }
  if (indicators.williamsR !== null && indicators.williamsR !== undefined) {
    if (indicators.williamsR < -80) { score += 8; factors.push(`WR oversold+8`); }
    if (indicators.williamsR > -20) { score -= 8; factors.push(`WR overbought-8`); }
  }

  // ── Key Levels ────────────────────────────────────────────────────────────────
  if (keyLevels.nearSupport.length > 0) {
    score += 15; factors.push(`Near support lvl+15`);
  }
  if (keyLevels.nearResistance.length > 0) {
    score -= 15; factors.push(`Near resistance lvl-15`);
  }

  // ── Price Action ──────────────────────────────────────────────────────────────
  if (priceAction.patternScore !== 0) {
    score += priceAction.patternScore;
    factors.push(`${priceAction.pattern}${priceAction.patternScore > 0 ? '+' : ''}${priceAction.patternScore}`);
  }
  if (priceAction.momentum !== 0) {
    score += priceAction.momentum;
    factors.push(`momentum${priceAction.momentum > 0 ? '+' : ''}${priceAction.momentum}`);
  }
  if (priceAction.volSurge) {
    const volBoost = score > 0 ? 5 : -5;
    score += volBoost;
    factors.push(`vol_surge${volBoost > 0 ? '+' : ''}${volBoost}`);
  }

  // Clamp to [-100, 100]
  score = Math.max(-100, Math.min(100, Math.round(score)));

  const direction = score >= CONFIG.threshold ? 'LONG'
                  : score <= -CONFIG.threshold ? 'SHORT'
                  : 'NEUTRAL';

  return { score, direction, factors };
}

// ─── Risk Manager ──────────────────────────────────────────────────────────────

function calculateRisk(price, direction, indicators, ohlcvSummary) {
  const atr = indicators.atr ?? estimateAtr(ohlcvSummary, price);
  const stopDist   = atr * CONFIG.atrMultiplier;
  const targetDist = stopDist * CONFIG.rewardRisk;

  const stop   = direction === 'LONG' ? price - stopDist : price + stopDist;
  const target = direction === 'LONG' ? price + targetDist : price - targetDist;

  const riskAmount = state.equity * (CONFIG.riskPct / 100);
  const size       = Math.floor(riskAmount / stopDist);

  return {
    stop:   +stop.toFixed(4),
    target: +target.toFixed(4),
    size:   Math.max(1, size),
    atr:    +atr.toFixed(4),
    stopDist:   +stopDist.toFixed(4),
    targetDist: +targetDist.toFixed(4),
    riskAmount: +riskAmount.toFixed(2),
    rr:         CONFIG.rewardRisk,
  };
}

function estimateAtr(summary, price) {
  if (!summary) return price * 0.005; // 0.5% fallback
  const range = summary.range ?? (price * 0.01);
  return range / 3; // rough ATR from period range ÷ 3
}

// ─── Position Manager ──────────────────────────────────────────────────────────

function checkExit(price) {
  if (!state.position) return null;
  const { side, stop, target } = state.position;

  if (side === 'LONG') {
    if (price <= stop)  return { reason: 'STOP_LOSS',   pnl: price - state.position.entry };
    if (price >= target) return { reason: 'TAKE_PROFIT', pnl: price - state.position.entry };
  } else {
    if (price >= stop)  return { reason: 'STOP_LOSS',   pnl: state.position.entry - price };
    if (price <= target) return { reason: 'TAKE_PROFIT', pnl: state.position.entry - price };
  }
  return null;
}

function openPosition(price, direction, risk) {
  state.position = {
    side:   direction,
    entry:  price,
    stop:   risk.stop,
    target: risk.target,
    size:   risk.size,
    atr:    risk.atr,
    openedAt: new Date(),
    bar:    state.barCount,
  };
  state.lastSignal = direction;
}

function closePosition(price, reason) {
  if (!state.position) return;
  const { entry, size, side } = state.position;
  const pnl = side === 'LONG'
    ? (price - entry) * size
    : (entry - price) * size;
  const pnlPct = ((pnl / (entry * size)) * 100).toFixed(2);

  state.equity += pnl;
  state.trades.push({
    side, entry, exit: price, size, pnl: +pnl.toFixed(2),
    pnlPct: +pnlPct, reason,
    duration: Math.round((Date.now() - state.position.openedAt) / 1000 / 60) + 'm',
  });

  const color = pnl >= 0 ? C.green : C.red;
  log.ok(`Position closed: ${C.bold}${reason}${C.reset} | P&L: ${color}${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct}%)${C.reset} | Equity: $${state.equity.toFixed(2)}`);
  state.position = null;
}

// ─── Display ───────────────────────────────────────────────────────────────────

function displayStatus(market, signal, risk) {
  const { chartState, quote } = market;
  const price = quote.last ?? quote.close;

  log.header(`Scan #${state.scanCount} — ${chartState.symbol} ${chartState.resolution}m`);

  log.row('Price',      `${price}`, C.bold + C.white);
  log.row('Change',     `${quote.change_pct ?? 'n/a'}`, C.white);
  log.row('Volume',     `${(quote.volume ?? 0).toLocaleString()}`, C.dim);
  log.row('Indicators', `${market.studies?.study_count ?? 0} on chart`, C.dim);

  const scoreColor = signal.score > 0 ? C.green : signal.score < 0 ? C.red : C.yellow;
  log.row('Signal',     `${signal.direction} (score ${signal.score > 0 ? '+' : ''}${signal.score})`, scoreColor + C.bold);

  if (signal.factors.length > 0) {
    const factorsLine = signal.factors.slice(0, 6).join('  ');
    log.row('Factors', factorsLine, C.dim);
  }

  if (state.position) {
    const { side, entry, stop, target, size } = state.position;
    const unrealizedPnl = (side === 'LONG' ? price - entry : entry - price) * size;
    const pnlColor = unrealizedPnl >= 0 ? C.green : C.red;
    log.row('Position', `${side} @ ${entry} × ${size}`, C.bold);
    log.row('  Stop/Target', `${stop} / ${target}`, C.dim);
    log.row('  Unrealized', `${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}`, pnlColor);
  } else {
    log.row('Position', 'Flat', C.dim);
    if (risk) log.row('  Next risk', `stop=${risk.stop}  target=${risk.target}  size=${risk.size}`, C.dim);
  }

  log.row('Paper equity', `$${state.equity.toFixed(2)}`, C.cyan);
  log.row('Trades',       `${state.trades.length} completed`, C.dim);

  const winners = state.trades.filter(t => t.pnl > 0).length;
  if (state.trades.length > 0) {
    const winRate = ((winners / state.trades.length) * 100).toFixed(1);
    const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
    log.row('Win rate', `${winRate}% (${winners}/${state.trades.length})`, C.white);
    log.row('Total P&L', `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? C.green : C.red);
  }
}

// ─── Main Scan ─────────────────────────────────────────────────────────────────

async function runScan() {
  state.scanCount++;

  let market;
  try {
    market = await readMarket();
  } catch (err) {
    log.error(`Market read failed: ${err.message}`);
    return;
  }

  const { quote, ohlcv, studies } = market;
  const price = quote.last ?? quote.close;
  if (!price) { log.warn('No price available — is the chart loaded?'); return; }

  const bars       = ohlcv?.bars ?? [];
  const indicators = parseStudies(studies);
  const keyLevels  = extractKeyLevels(market.pineLines, market.pineLabels, price);
  const priceAction = analyzePriceAction(bars);
  const signal     = scoreSignal(price, indicators, keyLevels, priceAction);

  const ohlcvSummary = bars.length > 0 ? {
    range: Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low)),
  } : null;

  state.barCount = bars.length;

  // ── Check exits ──────────────────────────────────────────────────────────────
  const exitSignal = checkExit(price);
  if (exitSignal) {
    closePosition(price, exitSignal.reason);
  }

  // ── Entry logic ──────────────────────────────────────────────────────────────
  let risk = null;
  const canEnter = !state.position && signal.direction !== 'NEUTRAL';
  const notSameDirection = signal.direction !== state.lastSignal;

  if (canEnter && notSameDirection) {
    risk = calculateRisk(price, signal.direction, indicators, ohlcvSummary);

    log.signal(signal.direction, signal.score, signal.factors.slice(0, 4).join('  '));
    log.info(`Entry: ${price}  Stop: ${risk.stop}  Target: ${risk.target}  Size: ${risk.size}  ATR: ${risk.atr}`);

    if (CONFIG.paperTrade) {
      openPosition(price, signal.direction, risk);
      try {
        await drawing.drawShape({
          shape: 'horizontal_line',
          point: { time: Math.floor(Date.now() / 1000), price },
          overrides: { linecolor: signal.direction === 'LONG' ? '#00ff88' : '#ff4444', linewidth: 2 },
          text: `${signal.direction} ${price} (score ${signal.score})`,
        });
        await drawing.drawShape({
          shape: 'horizontal_line',
          point: { time: Math.floor(Date.now() / 1000), price: risk.stop },
          overrides: { linecolor: '#ff4444', linewidth: 1, linestyle: 2 },
          text: `Stop ${risk.stop}`,
        });
        await drawing.drawShape({
          shape: 'horizontal_line',
          point: { time: Math.floor(Date.now() / 1000), price: risk.target },
          overrides: { linecolor: '#00ff88', linewidth: 1, linestyle: 2 },
          text: `Target ${risk.target}`,
        });
      } catch (drawErr) {
        log.warn(`Could not draw levels: ${drawErr.message}`);
      }
    }
  }

  displayStatus(market, signal, risk);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  log.header('TradingView Trading Bot — Starting');
  log.info(`Threshold: ${CONFIG.threshold}  Risk: ${CONFIG.riskPct}%  R:R: ${CONFIG.rewardRisk}  Paper: ${CONFIG.paperTrade}`);

  if (CONFIG.symbol) {
    log.info(`Setting symbol: ${CONFIG.symbol}`);
    await chart.setSymbol({ symbol: CONFIG.symbol });
    await new Promise(r => setTimeout(r, 1500));
  }
  if (CONFIG.timeframe) {
    log.info(`Setting timeframe: ${CONFIG.timeframe}`);
    await chart.setTimeframe({ timeframe: CONFIG.timeframe });
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

async function main() {
  process.on('SIGINT', async () => {
    console.log('\n');
    log.info('Shutting down…');
    if (state.position) {
      log.warn('Open position left unclosed. Review manually.');
    }
    if (state.trades.length > 0) {
      const total = state.trades.reduce((s, t) => s + t.pnl, 0);
      const wins  = state.trades.filter(t => t.pnl > 0).length;
      log.info(`Session summary: ${state.trades.length} trades | Win rate: ${((wins/state.trades.length)*100).toFixed(1)}% | P&L: ${total >= 0 ? '+' : ''}$${total.toFixed(2)}`);
    }
    await disconnect();
    process.exit(0);
  });

  try {
    await setup();
  } catch (err) {
    log.error(`Setup failed: ${err.message}`);
    log.warn('Make sure TradingView is running with CDP on port 9222.');
    log.warn('Launch it: node src/cli/index.js launch  OR  run scripts/launch_tv_debug_mac.sh');
    process.exit(1);
  }

  if (CONFIG.once) {
    await runScan();
    await disconnect();
    return;
  }

  log.info(`Polling every ${CONFIG.intervalSec}s — Ctrl+C to stop`);
  await runScan();

  setInterval(async () => {
    try { await runScan(); }
    catch (err) { log.error(`Scan error: ${err.message}`); }
  }, CONFIG.intervalSec * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
