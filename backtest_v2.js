/**
 * Frankie Candles v2 Backtest
 *
 * Changes vs v1:
 *   1. Fixed Fibonacci: full golden pocket zone (0.618–0.786 retracement), not a single 0.786 point
 *   2. Added WaveTrend momentum divergence as 7th signal
 *   3. Added 1H timeframe for BTC/ETH via paginated Binance fetch
 *   4. Optimises for WR ≥ 55% (v1 used 50%)
 *
 * Entry requires:
 *   - Money flow trend (mandatory)
 *   - SFP / liquidity sweep (mandatory)
 *   - ≥ MIN_SIGNALS total bull/bear score (including the two mandatory)
 */

const TRADE_SIZE = 10;   // USD notional per trade
const WARMUP     = 210;  // bars consumed before first entry (covers EMA-200)

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

// Fetch up to `totalBars` candles by paging backwards from the present.
async function fetchBinance(symbol, interval, totalBars = 1000) {
  const limit   = 1000;
  const pages   = Math.ceil(totalBars / limit);
  let all       = [];
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
    endTime = data[0][0] - 1;  // page back before earliest candle we have
  }

  // Deduplicate & sort ascending
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

// Signal 1: Money flow trend filter (EMA 50/200 + Impulse MACD) — MANDATORY
function moneyFlow(highs, lows, closes) {
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const macd   = impulseMACDSignal(highs, lows, closes);
  return { bull: ema50 > ema200 && macd.bull, bear: ema50 < ema200 || macd.bear };
}

// Signal 2: VWAP proximity
function vwapSig(candles) {
  const last    = candles[candles.length - 1];
  const midnight = new Date(last.time); midnight.setUTCHours(0, 0, 0, 0);
  const sess    = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return { bull: false, bear: false };
  const cumTPV  = sess.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol  = sess.reduce((s, c) => s + c.volume, 0);
  const vwap    = cumVol ? cumTPV / cumVol : null;
  if (!vwap) return { bull: false, bear: false };
  const price = last.close;
  const pct   = Math.abs((price - vwap) / vwap) * 100;
  return { bull: price < vwap && pct < 2, bear: price > vwap && pct < 2 };
}

// Signal 3: Volume Profile POC proximity
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

// Signal 4: WaveTrend crossover from oversold/overbought
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

// Signal 5: SFP — liquidity sweep with close back inside (MANDATORY for entry)
function liqSweep(highs, lows, closes, swLen = 10) {
  const last = closes.length - 1;
  const swL  = Math.min(...lows.slice(-swLen - 1, -1));
  const swH  = Math.max(...highs.slice(-swLen - 1, -1));
  return { bull: lows[last] < swL && closes[last] > swL, bear: highs[last] > swH && closes[last] < swH };
}

// Signal 6: Fibonacci golden pocket (0.618–0.786 RETRACEMENT zone) — FIXED
// For longs (pullback in uptrend): price between swL+0.214×range and swL+0.382×range
// For shorts (bounce in downtrend): price between swH-0.382×range and swH-0.214×range
function fibGoldenPocket(highs, lows, closes, lb = 50) {
  const swH   = Math.max(...highs.slice(-lb));
  const swL   = Math.min(...lows.slice(-lb));
  const price = closes[closes.length - 1];
  const range = swH - swL;
  if (range === 0) return { bull: false, bear: false };
  return {
    bull: price >= swL + range * 0.214 && price <= swL + range * 0.382,
    bear: price >= swH - range * 0.382 && price <= swH - range * 0.214,
  };
}

// Signal 7: WaveTrend momentum divergence (bullish: price lower low, WT higher low)
function momentumDiv(highs, lows, closes, n1 = 10, n2 = 21, lb = 15) {
  if (closes.length < lb + n2 + 5) return { bull: false, bear: false };
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = emaArr(ap, n1);
  const d   = emaArr(ap.map((v, i) => esa[i] != null ? Math.abs(v - esa[i]) : 0), n1);
  const ci  = ap.map((v, i) =>
    esa[i] != null && d[i] && d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const wt1 = emaArr(ci, n2);
  const last = closes.length - 1;
  const prev = last - lb;
  const wtNow  = wt1[last] ?? 0;
  const wtPrev = wt1[prev] ?? 0;
  const pNow   = closes[last];
  const pPrev  = closes[prev];
  return {
    bull: pNow < pPrev && wtNow > wtPrev && wtNow < 0,   // price lower low, WT higher low (oversold)
    bear: pNow > pPrev && wtNow < wtPrev && wtNow > 0,   // price higher high, WT lower high (overbought)
  };
}

function scoreSignals(candles) {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const mf  = moneyFlow(highs, lows, closes);
  const vw  = vwapSig(candles);
  const poc = pocSig(candles);
  const wt  = waveTrend(highs, lows, closes);
  const liq = liqSweep(highs, lows, closes);
  const fib = fibGoldenPocket(highs, lows, closes);
  const div = momentumDiv(highs, lows, closes);
  const bull = [mf.bull, vw.bull, poc.bull, wt.bull, liq.bull, fib.bull, div.bull].filter(Boolean).length;
  const bear = [mf.bear, vw.bear, poc.bear, wt.bear, liq.bear, fib.bear, div.bear].filter(Boolean).length;
  return { bull, bear, liqBull: liq.bull, liqBear: liq.bear, trendBull: mf.bull, trendBear: mf.bear };
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function simulate(candles, minSignals, stopPct, trailActivatePct, trailPct) {
  let position = null;
  const trades = [];

  for (let i = WARMUP; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const { high, low, close: price } = candles[i];
    const { bull, bear, liqBull, liqBear, trendBull, trendBear } = scoreSignals(slice);

    if (position) {
      const { direction: dir, entryPrice: ep, qty } = position;

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
        const exitP = stopHit ? stopLevel : price;
        const pnl   = dir === "LONG" ? (exitP - ep) * qty : (ep - exitP) * qty;
        const trailOn = dir === "LONG"
          ? position.peak >= ep * (1 + trailActivatePct)
          : position.peak <= ep * (1 - trailActivatePct);
        trades.push({ pnl, bars: i - position.entryIndex, reason: stopHit ? (trailOn ? "trail" : "stop") : "flip" });
        position = null;
      }
    }

    if (!position) {
      // Mandatory: trend + SFP. Then total score must reach minSignals.
      let go = null;
      if (trendBull && liqBull && bull >= minSignals && bull > bear) go = "LONG";
      else if (trendBear && liqBear && bear >= minSignals && bear > bull) go = "SHORT";
      if (go) position = { direction: go, entryPrice: price, qty: TRADE_SIZE / price, entryIndex: i, peak: price };
    }
  }

  // Close any open position at last bar
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

// Find best combo: WR ≥ 55% + maximum total P&L.
// Tiebreak on profit factor. Falls back to highest PF if nothing meets WR target.
function bestCombo(candles) {
  const minSigRange    = [3, 4, 5];
  const stops          = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05];
  const trailActivates = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15];
  const trailPcts      = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10];

  let best55  = null;  // best by total P&L with WR ≥ 55%
  let bestAny = null;  // overall best PF (fallback)

  for (const ms of minSigRange) {
    for (const stop of stops) {
      for (const act of trailActivates) {
        if (act < stop) continue;
        for (const trail of trailPcts) {
          const r = simulate(candles, ms, stop, act, trail);
          if (!r || r.n < 5) continue;
          if (!bestAny || r.pf > bestAny.pf) bestAny = { ms, stop, act, trail, ...r };
          if (r.winRate >= 55) {
            // Maximise total P&L; break ties with PF
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
          // 1H needs more history to be meaningful; 4H/1D single page is fine
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
        rows.push({ label, from, to, candles: candles.length, ...r, barsToHours });
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
  console.log("  FRANKIE CANDLES v2 — 7 signals — WR≥55% optimised for MAX PROFIT, then PF");
  console.log("  Signals: MoneyFlow(mandatory) + SFP(mandatory) + VWAP + POC + WaveTrend + FibGoldenPocket(fixed) + MomDiv");
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
  console.log("  MinSig = minimum total signal count required (includes mandatory MoneyFlow + SFP)");
  console.log("  All P&L based on $10 notional per trade, no fees\n");
}

run().catch(err => { console.error(err); process.exit(1); });
