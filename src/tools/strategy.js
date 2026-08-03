import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as dataCore from '../core/data.js';
import * as drawCore from '../core/drawing.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'strategy_state.json');

let state = {
  phase: 'WAITING_FOR_SWEEP',
  bias: 'NEUTRAL',
  setup: {
    sweepPrice: null,
    dealingHigh: null,
    dealingLow: null,
    fvgTop: null,
    fvgBottom: null,
    obHigh: null,
    obLow: null,
    fib618: null,
    fib786: null,
    zoneTop: null,
    zoneBottom: null,
  },
  trade: {
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    beActive: false,
  },
  lastBarTime: 0,
};

function loadState() {
  try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function ema(bars, period) {
  if (bars.length < period) return null;
  const k = 2 / (period + 1);
  let result = bars.slice(0, period).reduce((s, b) => s + b.close, 0) / period;
  for (let i = period; i < bars.length; i++) result = (bars[i].close - result) * k + result;
  return result;
}

function rsi(bars, period = 14) {
  if (bars.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function vwapCalc(bars) {
  if (!bars?.length) return null;
  let cumV = 0, cumPV = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * (b.volume || 0);
    cumV += (b.volume || 0);
  }
  return cumV > 0 ? cumPV / cumV : null;
}

function swingHighsLows(bars) {
  const highs = [], lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const c = bars[i];
    if (c.high > bars[i-1].high && c.high > bars[i-2].high && c.high > bars[i+1].high && c.high > bars[i+2].high)
      highs.push({ price: c.high, time: c.time });
    if (c.low < bars[i-1].low && c.low < bars[i-2].low && c.low < bars[i+1].low && c.low < bars[i+2].low)
      lows.push({ price: c.low, time: c.time });
  }
  return { highs: highs.slice(-10), lows: lows.slice(-10) };
}

async function drawStatusLabel(text, yPosition, timePosition) {
  // 1. Wipe ALL drawings from the chart (ensures only one label exists)
  await drawCore.clearAll().catch(() => {});
  // 2. Draw the single status label
  const overrides = JSON.stringify({ textcolor: '#ffffff', bgcolor: '#000000cc', fontsize: 13 });
  const point = { time: timePosition, price: yPosition };
  const res = await drawCore.drawShape({ shape: 'text', point, overrides, text });
  return res?.id;
}

function rsiWasOversold(bars, period = 14) {
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    const val = rsi(bars.slice(0, i + 1), period);
    if (val !== null && val <= 30) return true;
  }
  return false;
}
function rsiWasOverbought(bars, period = 14) {
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    const val = rsi(bars.slice(0, i + 1), period);
    if (val !== null && val >= 70) return true;
  }
  return false;
}

export function registerStrategyTool(server) {
  server.tool('strategy_run', 'Run the full ICT SMC + Fibonacci hybrid strategy. Clean single label always.', {}, async () => {
    try {
      loadState();

      const dailyResult = await dataCore.getOhlcv({ count: 250, summary: false });
      const dailyBars = dailyResult?.bars || [];
      if (!dailyBars.length) return jsonResult({ error: 'No daily data' });

      const execResult = await dataCore.getOhlcv({ count: 200, summary: false });
      const execBars = execResult?.bars || [];
      if (!execBars.length) return jsonResult({ error: 'No execution data' });

      const lastBar = execBars[execBars.length - 1];
      if (lastBar.time <= state.lastBarTime && state.phase !== 'TRADE_ACTIVE') {
        return jsonResult({ message: 'No new bar', phase: state.phase, bias: state.bias });
      }
      state.lastBarTime = lastBar.time;

      const dailyCloses = dailyBars.map(b => b.close);
      const dailyEma200 = ema(dailyBars, 200);
      const lastDailyClose = dailyCloses[dailyCloses.length - 1];
      if (dailyEma200 === null) return jsonResult({ error: 'Not enough daily data for EMA' });

      if (lastDailyClose > dailyEma200 * 1.002) state.bias = 'BULLISH';
      else if (lastDailyClose < dailyEma200 * 0.998) state.bias = 'BEARISH';
      else state.bias = 'NEUTRAL';

      const a = atr(execBars, 14);
      if (!a) return jsonResult({ error: 'ATR error' });

      if (state.bias === 'NEUTRAL') {
        await drawStatusLabel('NEUTRAL — no trades', lastBar.high + 0.5 * a, lastBar.time);
        saveState();
        return jsonResult({ message: 'Neutral bias', bias: state.bias });
      }

      const currentRsi = rsi(execBars, 14);
      const vwap = vwapCalc(execBars.slice(-50));
      const swings = swingHighsLows(execBars);

      let newPhase = state.phase;
      let infoText = '';
      const labelY = lastBar.high + 0.5 * a;

      if (state.phase === 'WAITING_FOR_SWEEP') {
        if (state.bias === 'BULLISH') {
          const lastLow = swings.lows[swings.lows.length - 1];
          if (!lastLow) return jsonResult({ error: 'No swing low' });
          infoText = `${state.bias} | WAIT SWEEP | Swing ${lastLow.price.toFixed(5)}`;
          const recent5 = execBars.slice(-5);
          const brokeBelow = recent5.some(b => b.low < lastLow.price);
          const closedAbove = lastBar.close > lastLow.price;
          if (brokeBelow && closedAbove) {
            const sweepPrice = Math.min(...recent5.map(b => b.low));
            state.setup.sweepPrice = sweepPrice;
            state.setup.dealingLow = sweepPrice;
            newPhase = 'WAITING_FOR_MSS';
            infoText = `${state.bias} | SWEEP ${sweepPrice.toFixed(5)}`;
          }
        } else {
          const lastHigh = swings.highs[swings.highs.length - 1];
          if (!lastHigh) return jsonResult({ error: 'No swing high' });
          infoText = `${state.bias} | WAIT SWEEP | Swing ${lastHigh.price.toFixed(5)}`;
          const recent5 = execBars.slice(-5);
          const brokeAbove = recent5.some(b => b.high > lastHigh.price);
          const closedBelow = lastBar.close < lastHigh.price;
          if (brokeAbove && closedBelow) {
            const sweepPrice = Math.max(...recent5.map(b => b.high));
            state.setup.sweepPrice = sweepPrice;
            state.setup.dealingHigh = sweepPrice;
            newPhase = 'WAITING_FOR_MSS';
            infoText = `${state.bias} | SWEEP ${sweepPrice.toFixed(5)}`;
          }
        }
      }

      if (state.phase === 'WAITING_FOR_MSS') {
        if (state.bias === 'BULLISH') {
          const highsBefore = swings.highs.filter(h => h.price > (state.setup.sweepPrice || 0) && h.time < lastBar.time);
          const lastSwingHigh = highsBefore[highsBefore.length - 1];
          if (lastSwingHigh && lastBar.close > lastSwingHigh.price && (lastBar.high - lastBar.low) > 2.0 * a) {
            state.setup.dealingHigh = lastBar.high;
            newPhase = 'WAITING_FOR_PD_ARRAYS';
            infoText = `${state.bias} | MSS ${lastBar.high.toFixed(5)}`;
          } else {
            infoText = `${state.bias} | WAIT MSS`;
          }
        } else {
          const lowsBefore = swings.lows.filter(l => l.price < (state.setup.sweepPrice || Infinity) && l.time < lastBar.time);
          const lastSwingLow = lowsBefore[lowsBefore.length - 1];
          if (lastSwingLow && lastBar.close < lastSwingLow.price && (lastBar.high - lastBar.low) > 2.0 * a) {
            state.setup.dealingLow = lastBar.low;
            newPhase = 'WAITING_FOR_PD_ARRAYS';
            infoText = `${state.bias} | MSS ${lastBar.low.toFixed(5)}`;
          } else {
            infoText = `${state.bias} | WAIT MSS`;
          }
        }
      }

      if (state.phase === 'WAITING_FOR_PD_ARRAYS') {
        const dispIdx = execBars.length - 1;
        if (dispIdx >= 2) {
          const c1 = execBars[dispIdx - 2], c3 = execBars[dispIdx];
          if (state.bias === 'BULLISH') {
            if (c3.low > c1.high && (c3.low - c1.high) >= 0.5 * a) {
              state.setup.fvgTop = c3.low; state.setup.fvgBottom = c1.high;
            }
          } else {
            if (c3.high < c1.low && (c1.low - c3.high) >= 0.5 * a) {
              state.setup.fvgTop = c1.low; state.setup.fvgBottom = c3.high;
            }
          }
          for (let i = dispIdx - 1; i >= Math.max(0, dispIdx - 15); i--) {
            const candle = execBars[i];
            const body = Math.abs(candle.close - candle.open), range = candle.high - candle.low;
            if (range > 0 && body / range >= 0.2) {
              if (state.bias === 'BULLISH' && candle.close < candle.open) {
                state.setup.obHigh = candle.high; state.setup.obLow = candle.low; break;
              } else if (state.bias === 'BEARISH' && candle.close > candle.open) {
                state.setup.obHigh = candle.high; state.setup.obLow = candle.low; break;
              }
            }
          }
          const dLow = state.bias === 'BULLISH' ? state.setup.dealingLow : state.setup.dealingLow;
          const dHigh = state.bias === 'BULLISH' ? state.setup.dealingHigh : state.setup.dealingHigh;
          if (dLow !== null && dHigh !== null) {
            state.setup.fib618 = dLow + (dHigh - dLow) * 0.618;
            state.setup.fib786 = dLow + (dHigh - dLow) * 0.786;
          }
          if (state.setup.fvgTop && state.setup.obHigh && state.setup.fib618) {
            if (state.bias === 'BULLISH') {
              state.setup.zoneTop = Math.min(state.setup.obHigh, state.setup.fvgTop);
              state.setup.zoneBottom = Math.max(state.setup.obLow, state.setup.fib618);
            } else {
              state.setup.zoneTop = Math.max(state.setup.obLow, state.setup.fib618);
              state.setup.zoneBottom = Math.min(state.setup.obHigh, state.setup.fvgBottom);
            }
            if (state.setup.zoneTop > state.setup.zoneBottom &&
                state.setup.zoneTop <= state.setup.fib786 &&
                state.setup.zoneBottom >= state.setup.fib618 &&
                (state.setup.zoneTop - state.setup.zoneBottom) <= 0.4 * a) {
              newPhase = 'WAITING_FOR_RETRACEMENT';
              infoText = `${state.bias} | ZONE ${state.setup.zoneBottom.toFixed(5)}-${state.setup.zoneTop.toFixed(5)}`;
            } else {
              newPhase = 'WAITING_FOR_SWEEP';
              infoText = `${state.bias} | INVALID`;
            }
          }
        }
      }

      if (state.phase === 'WAITING_FOR_RETRACEMENT' || state.phase === 'CONFIRMED') {
        const inZone = (state.bias === 'BULLISH' && lastBar.low <= state.setup.zoneTop && lastBar.high >= state.setup.zoneBottom) ||
                       (state.bias === 'BEARISH' && lastBar.high >= state.setup.zoneBottom && lastBar.low <= state.setup.zoneTop);
        if (inZone) {
          const rsiOk = (state.bias === 'BULLISH' && currentRsi > 40 && rsiWasOversold(execBars)) ||
                        (state.bias === 'BEARISH' && currentRsi < 60 && rsiWasOverbought(execBars));
          const vwapOk = vwap && Math.abs((state.bias === 'BULLISH' ? lastBar.low : lastBar.high) - vwap) / lastBar.close <= 0.001;
          if (rsiOk && vwapOk && ((state.bias === 'BULLISH' && lastBar.close > lastBar.open) || (state.bias === 'BEARISH' && lastBar.close < lastBar.open))) {
            state.trade.entry = lastBar.close;
            state.trade.sl = Math.min(state.setup.sweepPrice - a, state.setup.fib786 - 0.5 * a);
            state.trade.tp1 = state.setup.dealingHigh;
            state.trade.tp2 = state.setup.dealingLow + (state.setup.dealingHigh - state.setup.dealingLow) * 1.272;
            newPhase = 'TRADE_ACTIVE';
            infoText = `${state.bias} | ENTRY ${state.trade.entry.toFixed(5)} | SL ${state.trade.sl.toFixed(5)} | TP1 ${state.trade.tp1.toFixed(5)}`;
          }
        }
      }

      if (state.phase === 'TRADE_ACTIVE') {
        if (!state.trade.beActive && lastBar.high >= state.trade.tp1) {
          state.trade.beActive = true;
          infoText = `${state.bias} | BE ACTIVE | Move SL to ${state.trade.entry.toFixed(5)}`;
        }
        if (lastBar.low <= state.trade.sl || lastBar.high >= state.trade.tp2) {
          await drawStatusLabel('', 0, 0); // clear everything (text empty won't draw)
          newPhase = 'WAITING_FOR_SWEEP';
          state.trade = { entry: null, sl: null, tp1: null, tp2: null, beActive: false };
          infoText = `${state.bias} | CLOSED`;
        }
      }

      // Draw fresh label – this wipes all previous drawings first
      await drawStatusLabel(infoText, labelY, lastBar.time);

      state.phase = newPhase;
      saveState();

      return jsonResult({ success: true, phase: state.phase, bias: state.bias });
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
