/**
 * ICT Fair Value Gap (FVG) + Order Block Strategy Backtest
 *
 * Strategy overview:
 *   A strong impulsive move leaves a price gap (FVG) between 3 candles.
 *   Price retraces into that gap — this is the entry trigger (institutional
 *   re-accumulation / re-distribution zone). Order Block (the last opposite-
 *   close candle before the impulse) adds a second structural confirmation.
 *
 * Entry requires:
 *   - Money flow trend (mandatory) — EMA 50/200 + Impulse MACD
 *   - Fair Value Gap (mandatory) — price currently inside a recent unfilled FVG
 *   - ≥ MIN_SIGNALS total score (includes the two mandatory above)
 *
 * Supporting signals:
 *   3. Order Block       — price at the OB candle that preceded the FVG impulse
 *   4. Change of Char.   — structural break (CHoCH) in entry direction
 *   5. WaveTrend         — WT crossover from oversold / overbought
 *   6. Volume Spike      — above-average volume on the FVG-creation candle
 *   7. POC proximity     — price near volume-profile Point of Control
 */

const TRADE_SIZE = 10;   // USD notional per trade
const WARMUP     = 210;  // bars before first entry (covers EMA-200)

const ASSETS = [
  { name: "BTC",    symbol: "BTCUSDT",  source: "binance", timeframes: ["1h", "4h", "1d"] },
  { name: "ETH",    symbol: "ETHUSDT",  source: "binance", timeframes: ["1h", "4h", "1d"] },
  { name: "SOL",    symbol: "SOLUSDT",  source: "binance", timeframes: ["4h", "1d"] },
  { name: "DOGE",   symbol: "DOGEUSDT", source: "binance", timeframes: ["4h", "1d"] },
  { name: "S&P500", symbol: "SPY",      source: "yahoo",   timeframes: ["1d"] },
  { name: "TSLA",   symbol: "TSLA",     source: "yahoo",   timeframes: ["1d"] },
  { name: "NVDA",   symbol: "NVDA",     source: "yahoo",   timeframes: ["1d"] },
];

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchBinance(symbol, interval, totalBars = 1000) {
  const limit = 1000;
  const pages = Math.ceil(totalBars / limit);
  let all = [];
  let endTime;

  for (let p = 0; p < pages; p++) {
    let url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${symbol} ${interval}: ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    const candles = data.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all     = [...candles, ...all];
    endTime = data[0][0] - 1;
  }

  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3y`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const json   = await res.json();
  const result = json.chart.result[0];
  const { timestamp, indicators: { quote: [q] } } = result;
  const candles = [];
  for (let i = 0; i < timestamp.length; i++) {
    if (q.close[i] == null) continue;
    candles.push({ time: timestamp[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return candles;
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

function emaArr(values, period) {
  const mult = 2 / (period + 1);
  const out  = new Array(values.length).fill(null);
  let sum = 0, n = 0, seeded = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (!seeded) {
      sum += v; n++;
      if (n === period) { out[i] = sum / period; seeded = true; }
    } else {
      out[i] = v * mult + out[i - 1] * (1 - mult);
    }
  }
  return out;
}

function smaArr(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j] ?? 0;
    out[i] = s / period;
  }
  return out;
}

function calcEMA(closes, period) {
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

function impulseMACDSignal(highs, lows, closes, len = 34, sig = 9) {
  const hlc3 = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const hi2  = emaArr(emaArr(highs, len).map(v => v ?? 0), len);
  const lo2  = emaArr(emaArr(lows,  len).map(v => v ?? 0), len);
  const mi2  = emaArr(emaArr(hlc3,  len).map(v => v ?? 0), len);
  const md   = mi2.map((m, i) => {
    if (!m || !hi2[i] || !lo2[i]) return 0;
    return m > hi2[i] ? m - hi2[i] : m < lo2[i] ? m - lo2[i] : 0;
  });
  const sigA = smaArr(md, sig);
  const last = closes.length - 1;
  const h    = md[last] - (sigA[last] ?? 0);
  return { bull: md[last] > 0 && h >= 0, bear: md[last] <= 0 || h < 0 };
}

// Signal 1: Money flow trend filter — MANDATORY
function moneyFlow(highs, lows, closes) {
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const macd   = impulseMACDSignal(highs, lows, closes);
  return { bull: ema50 > ema200 && macd.bull, bear: ema50 < ema200 || macd.bear };
}

// Signal 2: Fair Value Gap — MANDATORY
// Bullish FVG: highs[i-2] < lows[i]  → gap zone [highs[i-2], lows[i]]
//   Price retraces down into this zone → LONG entry
// Bearish FVG: lows[i-2] > highs[i]  → gap zone [highs[i], lows[i-2]]
//   Price retraces up into this zone  → SHORT entry
function fvgSig(highs, lows, closes, lb = 30) {
  const last  = closes.length - 1;
  const price = closes[last];
  let bullInZone = false, bearInZone = false;

  for (let i = last - 2; i >= Math.max(WARMUP, last - lb); i--) {
    if (!bullInZone) {
      const gapLow  = highs[i - 2];   // top of pre-impulse candle
      const gapHigh = lows[i];        // bottom of post-impulse candle
      if (gapHigh > gapLow && price >= gapLow && price <= gapHigh) {
        bullInZone = true;
      }
    }
    if (!bearInZone) {
      const gapHigh = lows[i - 2];    // bottom of pre-impulse candle
      const gapLow  = highs[i];       // top of post-impulse candle
      if (gapHigh > gapLow && price >= gapLow && price <= gapHigh) {
        bearInZone = true;
      }
    }
    if (bullInZone && bearInZone) break;
  }

  return { bull: bullInZone, bear: bearInZone };
}

// Signal 3: Order Block proximity
// Bullish OB: last bearish candle (close < open) before a bullish FVG-creating impulse
// Bearish OB: last bullish candle (close > open) before a bearish FVG-creating impulse
function orderBlockSig(highs, lows, opens, closes, lb = 30) {
  const last  = closes.length - 1;
  const price = closes[last];
  let bullOB = null, bearOB = null;

  for (let i = last - 2; i >= Math.max(WARMUP + 3, last - lb); i--) {
    if (!bullOB && highs[i - 2] < lows[i]) {
      // Bullish FVG found at i — search backward for last bearish OB candle
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (closes[j] < opens[j]) { bullOB = { low: lows[j], high: highs[j] }; break; }
      }
    }
    if (!bearOB && lows[i - 2] > highs[i]) {
      // Bearish FVG found at i — search backward for last bullish OB candle
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (closes[j] > opens[j]) { bearOB = { low: lows[j], high: highs[j] }; break; }
      }
    }
    if (bullOB && bearOB) break;
  }

  return {
    bull: bullOB ? (price >= bullOB.low && price <= bullOB.high) : false,
    bear: bearOB ? (price >= bearOB.low && price <= bearOB.high) : false,
  };
}

// Signal 4: Change of Character (CHoCH) — structural shift in entry direction
// Bull CHoCH: recent swing broke above a prior swing high (downtrend → uptrend flip)
// Bear CHoCH: recent swing broke below a prior swing low  (uptrend  → downtrend flip)
function chochSig(highs, lows, closes, swLen = 10, lb = 25) {
  const last = closes.length - 1;
  if (last < lb + swLen) return { bull: false, bear: false };
  const priorH  = Math.max(...highs.slice(last - lb - swLen, last - swLen));
  const priorL  = Math.min(...lows .slice(last - lb - swLen, last - swLen));
  const recentH = Math.max(...highs.slice(last - swLen, last));
  const recentL  = Math.min(...lows .slice(last - swLen, last));
  return {
    bull: recentH > priorH && closes[last] > recentH * 0.998,
    bear: recentL < priorL && closes[last] < recentL * 1.002,
  };
}

// Signal 5: WaveTrend crossover from oversold / overbought
function waveTrend(highs, lows, closes, n1 = 10, n2 = 21) {
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = emaArr(ap, n1);
  const d   = emaArr(ap.map((v, i) => esa[i] != null ? Math.abs(v - esa[i]) : 0), n1);
  const ci  = ap.map((v, i) =>
    esa[i] != null && d[i] && d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const tci  = emaArr(ci, n2);
  const wt2a = smaArr(tci.map(v => v ?? 0), 4);
  const last = closes.length - 1;
  const wt1  = tci[last] ?? 0, wt1p = tci[last - 1] ?? 0;
  const wt2  = wt2a[last] ?? 0, wt2p = wt2a[last - 1] ?? 0;
  return { bull: wt1p <= wt2p && wt1 > wt2 && wt2 < -33, bear: wt1p >= wt2p && wt1 < wt2 && wt2 > 33 };
}

// Signal 6: Volume spike — above-average volume confirms the FVG impulse is institutional
function volumeSpike(candles, lb = 20, mult = 1.5) {
  const last   = candles.length - 1;
  const avgVol = candles.slice(last - lb, last).reduce((s, c) => s + c.volume, 0) / lb;
  const c      = candles[last];
  return {
    bull: c.close > c.open && c.volume > avgVol * mult,
    bear: c.close < c.open && c.volume > avgVol * mult,
  };
}

// Signal 7: Volume Profile POC proximity
function pocSig(candles) {
  const slice = candles.slice(-100);
  const avgP  = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  const step  = Math.max(avgP * 0.001, 1e-8);
  const map   = new Map();
  for (const c of slice) {
    const b = Math.round(c.close / step);
    map.set(b, (map.get(b) || 0) + c.volume);
  }
  let maxVol = 0, pocBucket = 0;
  for (const [b, v] of map) { if (v > maxVol) { maxVol = v; pocBucket = b; } }
  const poc   = pocBucket * step;
  const price = candles[candles.length - 1].close;
  const pct   = Math.abs((price - poc) / poc) * 100;
  return { bull: price >= poc && pct < 1.5, bear: price <= poc && pct < 1.5 };
}

function scoreSignals(candles) {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const opens  = candles.map(c => c.open);
  const closes = candles.map(c => c.close);
  const mf    = moneyFlow(highs, lows, closes);
  const fvg   = fvgSig(highs, lows, closes);
  const ob    = orderBlockSig(highs, lows, opens, closes);
  const choch = chochSig(highs, lows, closes);
  const wt    = waveTrend(highs, lows, closes);
  const vol   = volumeSpike(candles);
  const poc   = pocSig(candles);
  const bull = [mf.bull, fvg.bull, ob.bull, choch.bull, wt.bull, vol.bull, poc.bull].filter(Boolean).length;
  const bear = [mf.bear, fvg.bear, ob.bear, choch.bear, wt.bear, vol.bear, poc.bear].filter(Boolean).length;
  return { bull, bear, fvgBull: fvg.bull, fvgBear: fvg.bear, trendBull: mf.bull, trendBear: mf.bear };
}

// ─── Simulation (same trailing stop logic as Frankie Candles v2) ──────────────

function simulate(candles, minSignals, stopPct, trailActivatePct, trailPct) {
  let position = null;
  const trades = [];

  for (let i = WARMUP; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const { high, low, close: price } = candles[i];
    const { bull, bear, fvgBull, fvgBear, trendBull, trendBear } = scoreSignals(slice);

    if (position) {
      const { direction: dir, entryPrice: ep } = position;

      if (dir === "LONG"  && high > position.peak) position.peak = high;
      if (dir === "SHORT" && low  < position.peak) position.peak = low;

      let stopLevel;
      if (dir === "LONG") {
        const trailOn = position.peak >= ep * (1 + trailActivatePct);
        stopLevel = trailOn
          ? Math.max(ep, position.peak * (1 - trailPct))
          : ep * (1 - stopPct);
      } else {
        const trailOn = position.peak <= ep * (1 - trailActivatePct);
        stopLevel = trailOn
          ? Math.min(ep, position.peak * (1 + trailPct))
          : ep * (1 + stopPct);
      }

      const stopHit = dir === "LONG" ? low <= stopLevel : high >= stopLevel;
      const flip    = dir === "LONG"
        ? (bear >= minSignals && bear > bull)
        : (bull >= minSignals && bull > bear);

      if (stopHit || flip) {
        const exitP   = stopHit ? stopLevel : price;
        const pnl     = dir === "LONG"
          ? (exitP - ep) * position.qty
          : (ep - exitP) * position.qty;
        const trailOn = dir === "LONG"
          ? position.peak >= ep * (1 + trailActivatePct)
          : position.peak <= ep * (1 - trailActivatePct);
        trades.push({ pnl, bars: i - position.entryIndex, reason: stopHit ? (trailOn ? "trail" : "stop") : "flip" });
        position = null;
      }
    }

    if (!position) {
      let go = null;
      if (trendBull && fvgBull && bull >= minSignals && bull > bear) go = "LONG";
      else if (trendBear && fvgBear && bear >= minSignals && bear > bull) go = "SHORT";
      if (go) position = { direction: go, entryPrice: price, qty: TRADE_SIZE / price, entryIndex: i, peak: price };
    }
  }

  if (position) {
    const pnl = position.direction === "LONG"
      ? (candles[candles.length - 1].close - position.entryPrice) * position.qty
      : (position.entryPrice - candles[candles.length - 1].close) * position.qty;
    trades.push({ pnl, bars: candles.length - 1 - position.entryIndex, reason: "end" });
  }

  if (!trades.length) return null;

  const wins = trades.filter(t => t.pnl > 0);
  const gW   = wins.reduce((s, t) => s + t.pnl, 0);
  const gL   = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  let peak = 0, run = 0, maxDD = 0;
  for (const t of trades) {
    run += t.pnl;
    if (run > peak) peak = run;
    if (peak - run > maxDD) maxDD = peak - run;
  }
  return {
    n: trades.length,
    winRate: (wins.length / trades.length) * 100,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    pf: gL === 0 ? Infinity : gW / gL,
    maxDD,
    avgBars: trades.reduce((s, t) => s + t.bars, 0) / trades.length,
  };
}

function bestCombo(candles) {
  const minSigRange    = [3, 4, 5];
  const stops          = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05];
  const trailActivates = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15];
  const trailPcts      = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10];

  let best55  = null;
  let bestAny = null;

  for (const ms of minSigRange) {
    for (const stop of stops) {
      for (const act of trailActivates) {
        if (act < stop) continue;
        for (const trail of trailPcts) {
          const r = simulate(candles, ms, stop, act, trail);
          if (!r || r.n < 5) continue;
          if (!bestAny || r.pf > bestAny.pf) bestAny = { ms, stop, act, trail, ...r };
          if (r.winRate >= 55) {
            if (!best55 || r.totalPnl > best55.totalPnl || (r.totalPnl === best55.totalPnl && r.pf > best55.pf)) {
              best55 = { ms, stop, act, trail, ...r };
            }
          }
        }
      }
    }
  }

  return best55 || bestAny;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const rows = [];

  for (const asset of ASSETS) {
    for (const tf of asset.timeframes) {
      const label = `${asset.name} ${tf.toUpperCase()}`;
      process.stdout.write(`Testing ${label.padEnd(14)}...`);
      try {
        let candles;
        if (asset.source === "binance") {
          const bars = tf === "1h" ? 3000 : 1000;
          candles = await fetchBinance(asset.symbol, tf, bars);
        } else {
          candles = await fetchYahoo(asset.symbol);
        }
        const from = new Date(candles[0].time).toISOString().slice(0, 10);
        const to   = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
        const r    = bestCombo(candles);
        if (!r) { console.log(" no trades"); continue; }
        const barsToHours = tf === "1h" ? 1 : tf === "4h" ? 4 : 24;
        rows.push({ label, from, to, ...r, barsToHours });
        const pnlStr = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2);
        console.log(` PF=${r.pf.toFixed(2)} WR=${r.winRate.toFixed(0)}% P&L=$${pnlStr} DD=$${r.maxDD.toFixed(2)} (ms=${r.ms} stop=${(r.stop*100).toFixed(1)}% act=${(r.act*100).toFixed(1)}% trail=${(r.trail*100).toFixed(1)}%)`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
      }
    }
  }

  rows.sort((a, b) => b.pf - a.pf);

  const W = 120;
  console.log("\n" + "═".repeat(W));
  console.log("  ICT FVG + ORDER BLOCK — 7 signals — WR≥55% optimised for MAX PROFIT, then PF");
  console.log("  Signals: MoneyFlow(mandatory) + FVG(mandatory) + OrderBlock + CHoCH + WaveTrend + VolumeSpike + POC");
  console.log("═".repeat(W));
  console.log("  Asset          Period                 Trades  WinRate   P&L       PF     MaxDD    AvgHold  MinSig Stop  Activate Trail");
  console.log("  " + "─".repeat(W - 2));
  for (const r of rows) {
    const period = `${r.from} → ${r.to}`;
    const pnl    = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2);
    const pf     = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(2).padStart(5);
    const hold   = `${(r.avgBars * r.barsToHours).toFixed(0)}h`;
    const wr     = r.winRate.toFixed(1).padStart(6);
    const ms     = String(r.ms).padStart(2);
    const stop   = `${(r.stop*100).toFixed(1)}%`;
    const act    = `${(r.act*100).toFixed(1)}%`;
    const trail  = `${(r.trail*100).toFixed(1)}%`;
    const wrFlag = r.winRate >= 55 ? " ✓" : "  ";
    console.log(`  ${r.label.padEnd(14)} ${period}  ${String(r.n).padStart(6)}  ${wr}%${wrFlag}  $${pnl.padStart(8)}  ${pf}  $${r.maxDD.toFixed(2).padStart(6)}  ${hold.padStart(7)}     ${ms}   ${stop.padEnd(5)} ${act.padEnd(8)} ${trail}`);
  }
  console.log("═".repeat(W));
  console.log("  ✓ = WR≥55% achieved");
  console.log("  MinSig = minimum total signal count required (includes mandatory MoneyFlow + FVG)");
  console.log("  All P&L based on $10 notional per trade, no fees\n");
}

run().catch(err => { console.error(err); process.exit(1); });
