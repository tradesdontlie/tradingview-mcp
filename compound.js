/**
 * Frankie Candles v2 — Compound Growth Simulation
 * "If I started with $1000, how much would I have?"
 *
 * Uses optimal params from backtest_v2.js: ms=3, stop=0.5%, act=0.5%, trail=0.5%
 * Focuses on the daily timeframe (best performer).
 * Position sizing: ALLOC % of current account per trade (no leverage).
 */

const START   = 1000;
const WARMUP  = 210;
const PARAMS  = { ms: 3, stop: 0.005, act: 0.005, trail: 0.005 };
const TRADE_SIZE = 10;  // used internally; compound sim scales from this

const ASSETS = [
  { name: "BTC",  symbol: "BTCUSDT",  source: "binance" },
  { name: "ETH",  symbol: "ETHUSDT",  source: "binance" },
  { name: "SOL",  symbol: "SOLUSDT",  source: "binance" },
  { name: "DOGE", symbol: "DOGEUSDT", source: "binance" },
  { name: "TSLA", symbol: "TSLA",     source: "yahoo"   },
  { name: "NVDA", symbol: "NVDA",     source: "yahoo"   },
];

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchBinance(symbol, interval = "1d") {
  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol}: ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3y`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const json   = await res.json();
  const result = json.chart.result[0];
  const { timestamp, indicators: { quote: [q] } } = result;
  return timestamp.map((t, i) => ({
    time: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i],
    close: q.close[i], volume: q.volume[i] || 0,
  })).filter(c => c.close != null);
}

// ─── Indicators (identical to backtest_v2.js) ────────────────────────────────

function emaArr(values, period) {
  const mult = 2 / (period + 1);
  const out  = new Array(values.length).fill(null);
  let sum = 0, n = 0, seeded = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (!seeded) { sum += v; n++; if (n === period) { out[i] = sum / period; seeded = true; } }
    else { out[i] = v * mult + out[i - 1] * (1 - mult); }
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

function moneyFlow(highs, lows, closes) {
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const macd   = impulseMACDSignal(highs, lows, closes);
  return { bull: ema50 > ema200 && macd.bull, bear: ema50 < ema200 || macd.bear };
}

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

function pocSig(candles) {
  const slice = candles.slice(-100);
  const avgP  = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  const step  = Math.max(avgP * 0.001, 1e-8);
  const map   = new Map();
  for (const c of slice) { const b = Math.round(c.close / step); map.set(b, (map.get(b) || 0) + c.volume); }
  let maxVol = 0, pocBucket = 0;
  for (const [b, v] of map) { if (v > maxVol) { maxVol = v; pocBucket = b; } }
  const poc   = pocBucket * step;
  const price = candles[candles.length - 1].close;
  const pct   = Math.abs((price - poc) / poc) * 100;
  return { bull: price >= poc && pct < 1.5, bear: price <= poc && pct < 1.5 };
}

function waveTrend(highs, lows, closes, n1 = 10, n2 = 21) {
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = emaArr(ap, n1);
  const d   = emaArr(ap.map((v, i) => esa[i] != null ? Math.abs(v - esa[i]) : 0), n1);
  const ci  = ap.map((v, i) =>
    esa[i] != null && d[i] && d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const tci  = emaArr(ci, n2);
  const wt2a = smaArr(tci.map(v => v ?? 0), 4);
  const last = closes.length - 1;
  const wt1 = tci[last] ?? 0, wt1p = tci[last - 1] ?? 0;
  const wt2 = wt2a[last] ?? 0, wt2p = wt2a[last - 1] ?? 0;
  return { bull: wt1p <= wt2p && wt1 > wt2 && wt2 < -33, bear: wt1p >= wt2p && wt1 < wt2 && wt2 > 33 };
}

function liqSweep(highs, lows, closes, swLen = 10) {
  const last = closes.length - 1;
  const swL  = Math.min(...lows.slice(-swLen - 1, -1));
  const swH  = Math.max(...highs.slice(-swLen - 1, -1));
  return { bull: lows[last] < swL && closes[last] > swL, bear: highs[last] > swH && closes[last] < swH };
}

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

function momentumDiv(highs, lows, closes, n1 = 10, n2 = 21, lb = 15) {
  if (closes.length < lb + n2 + 5) return { bull: false, bear: false };
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = emaArr(ap, n1);
  const d   = emaArr(ap.map((v, i) => esa[i] != null ? Math.abs(v - esa[i]) : 0), n1);
  const ci  = ap.map((v, i) =>
    esa[i] != null && d[i] && d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const wt1 = emaArr(ci, n2);
  const last = closes.length - 1, prev = last - lb;
  const wtNow = wt1[last] ?? 0, wtPrev = wt1[prev] ?? 0;
  return {
    bull: closes[last] < closes[prev] && wtNow > wtPrev && wtNow < 0,
    bear: closes[last] > closes[prev] && wtNow < wtPrev && wtNow > 0,
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

// ─── Simulate — returns individual trades ─────────────────────────────────────

function simulateTrades(candles, { ms, stop, act, trail }) {
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
        const trailOn = position.peak >= ep * (1 + act);
        stopLevel = trailOn ? Math.max(ep, position.peak * (1 - trail)) : ep * (1 - stop);
      } else {
        const trailOn = position.peak <= ep * (1 - act);
        stopLevel = trailOn ? Math.min(ep, position.peak * (1 + trail)) : ep * (1 + stop);
      }

      const stopHit = dir === "LONG" ? low <= stopLevel : high >= stopLevel;
      const flip    = dir === "LONG" ? (bear >= ms && bear > bull) : (bull >= ms && bull > bear);

      if (stopHit || flip) {
        const exitP = stopHit ? stopLevel : price;
        const pnl   = dir === "LONG" ? (exitP - ep) * qty : (ep - exitP) * qty;
        trades.push({ pnl, entryPrice: ep, exitPrice: exitP, direction: dir, date: new Date(candles[i].time).toISOString().slice(0,10) });
        position = null;
      }
    }

    if (!position) {
      let go = null;
      if (trendBull && liqBull && bull >= ms && bull > bear) go = "LONG";
      else if (trendBear && liqBear && bear >= ms && bear > bull) go = "SHORT";
      if (go) position = { direction: go, entryPrice: price, qty: TRADE_SIZE / price, entryIndex: i, peak: price };
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    const pnl  = position.direction === "LONG"
      ? (last.close - position.entryPrice) * position.qty
      : (position.entryPrice - last.close) * position.qty;
    trades.push({ pnl, entryPrice: position.entryPrice, exitPrice: last.close, direction: position.direction, date: new Date(last.time).toISOString().slice(0,10) });
  }

  return trades;
}

// ─── Compound growth calculator ───────────────────────────────────────────────

function compoundGrowth(trades, startCapital, alloc) {
  let account  = startCapital;
  let peak     = startCapital;
  let maxDD    = 0;

  for (const t of trades) {
    const notional = alloc * account;           // position size = alloc% of current account
    const scale    = notional / TRADE_SIZE;     // scale from the $10 sim
    account += t.pnl * scale;
    if (account > peak) peak = account;
    if (peak - account > maxDD) maxDD = peak - account;
  }

  return { finalAccount: account, maxDD };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const allocs = [0.25, 0.50, 1.00];  // 25%, 50%, 100% of account per trade (spot trading)

  console.log(`\nStarting capital: $${START.toLocaleString()}`);
  console.log(`Strategy: Daily, MinSig=3, Stop=0.5%, Trail Activate=0.5%, Trail=0.5%`);
  console.log(`Position sizing: fixed % of current account per trade (no leverage)\n`);

  const rows = [];

  for (const asset of ASSETS) {
    process.stdout.write(`${asset.name.padEnd(5)}...`);
    try {
      const candles = asset.source === "binance"
        ? await fetchBinance(asset.symbol)
        : await fetchYahoo(asset.symbol);

      const from   = new Date(candles[0].time).toISOString().slice(0, 10);
      const to     = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
      const years  = (candles[candles.length - 1].time - candles[WARMUP].time) / (365.25 * 24 * 3600 * 1000);
      const trades = simulateTrades(candles, PARAMS);

      if (!trades.length) { console.log(" no trades"); continue; }

      const wins    = trades.filter(t => t.pnl > 0).length;
      const winRate = (wins / trades.length * 100).toFixed(0);

      const results = allocs.map(alloc => {
        const { finalAccount, maxDD } = compoundGrowth(trades, START, alloc);
        const totalReturn = ((finalAccount - START) / START * 100);
        const annualised  = (Math.pow(finalAccount / START, 1 / years) - 1) * 100;
        return { alloc, finalAccount, totalReturn, annualised, maxDD };
      });

      console.log(` ${trades.length} trades, WR=${winRate}%, period=${from} → ${to}`);
      rows.push({ asset: asset.name, from, to, years, trades: trades.length, winRate, results });
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  // ─── Print table ──────────────────────────────────────────────────────────

  const W = 110;
  console.log("\n" + "═".repeat(W));
  console.log("  COMPOUND GROWTH — Starting $1,000 — Daily Frankie Candles Strategy");
  console.log("═".repeat(W));

  for (const alloc of allocs) {
    const pct = (alloc * 100).toFixed(0);
    console.log(`\n  ── ${pct}% of account per trade ──────────────────────────────────────────────────────────`);
    console.log(`  ${"Asset".padEnd(7)} ${"Period".padEnd(24)} Trades  WR    Final $      Return    Annual    MaxDD`);
    console.log("  " + "─".repeat(W - 4));

    for (const r of rows) {
      const res = r.results.find(x => x.alloc === alloc);
      const final  = `$${res.finalAccount.toFixed(0).padStart(7)}`;
      const ret    = `${res.totalReturn >= 0 ? "+" : ""}${res.totalReturn.toFixed(0)}%`.padStart(8);
      const ann    = `${res.annualised >= 0 ? "+" : ""}${res.annualised.toFixed(0)}%/yr`.padStart(10);
      const dd     = `$${res.maxDD.toFixed(0)}`.padStart(7);
      console.log(`  ${r.asset.padEnd(7)} ${r.from} → ${r.to}    ${String(r.trades).padStart(4)}  ${String(r.winRate).padStart(3)}%  ${final}  ${ret}  ${ann}  ${dd}`);
    }
  }

  console.log("\n" + "═".repeat(W));
  console.log("  Notes:");
  console.log("  • 25%/trade = conservative spot. 50%/trade = moderate spot. 100%/trade = all-in spot.");
  console.log("  • MaxDD = largest peak-to-trough drawdown in dollar terms (on the compounded account).");
  console.log("  • No trading fees included. Real returns will be ~0.1-0.2% lower per trade.");
  console.log("  • Crypto assets run only ~2.75 years of data; equities run ~3 years.");
  console.log("  • These are backtested results — past performance does not guarantee future results.\n");
}

run().catch(err => { console.error(err); process.exit(1); });
