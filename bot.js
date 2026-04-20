/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via Phemex if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["PHEMEX_API_KEY", "PHEMEX_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    // Running locally with no .env — create a template and open it
    if (!existsSync(".env")) {
      console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
      writeFileSync(
        ".env",
        [
          "# Phemex credentials",
          "PHEMEX_API_KEY=",
          "PHEMEX_SECRET_KEY=",
          "",
          "# Trading config",
          "PORTFOLIO_VALUE_USD=1000",
          "MAX_TRADE_SIZE_USD=20",
          "MAX_TRADES_PER_DAY=10",
          "PAPER_TRADING=true",
          "SYMBOL=sBTCUSDT",
          "TIMEFRAME=4H",
        ].join("\n") + "\n",
      );
      try { execSync("notepad .env"); } catch {}
      console.log("Fill in your Phemex credentials in .env then re-run: node bot.js\n");
    } else {
      console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
      console.log("Set them in .env (local) or as environment variables (Railway).\n");
    }
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
    `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "sBTCUSDT",
  timeframes: (process.env.TIMEFRAMES || "4h,1d").split(",").map(s => s.trim()),
  stopPct: parseFloat(process.env.STOP_PCT || "0.005"),
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "20"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  strategy: process.env.STRATEGY || "both",   // "frankie" | "fvg" | "both"
  phemex: {
    apiKey: process.env.PHEMEX_API_KEY,
    secretKey: process.env.PHEMEX_SECRET_KEY,
    baseUrl: process.env.PHEMEX_BASE_URL || "https://api.phemex.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "1H": "1h", "4h": "4h", "4H": "4h",
    "1d": "1d", "1D": "1d", "1w": "1w", "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "4h";
  // Strip Phemex spot 's' prefix (sBTCUSDT → BTCUSDT) for Binance
  const binanceSymbol = symbol.startsWith("s") ? symbol.slice(1) : symbol;

  // Binance US for US-based users (same API format as binance.com)
  const url = `https://api.binance.us/api/v3/klines?symbol=${binanceSymbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Array Indicator Helpers ─────────────────────────────────────────────────

function emaArr(values, period) {
  const mult = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let sum = 0, seeded = false, seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (!seeded) {
      sum += v;
      seedCount++;
      if (seedCount === period) {
        out[i] = sum / period;
        seeded = true;
      }
    } else {
      out[i] = v * mult + out[i - 1] * (1 - mult);
    }
  }
  return out;
}

function smaArr(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j] ?? 0;
    out[i] = sum / period;
  }
  return out;
}

function atrArr(highs, lows, closes, period) {
  const tr = closes.map((c, i) =>
    i === 0
      ? highs[i] - lows[i]
      : Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]),
        ),
  );
  return emaArr(tr, period);
}

// ─── Scalar Indicator Helpers ────────────────────────────────────────────────

function calcEMA(closes, period) {
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
  }
  return ema;
}

// ─── Frankie Candles Indicator Calculations ──────────────────────────────────

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (session.length === 0) return null;
  const cumTPV = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = session.reduce((s, c) => s + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// Point of Control — price level with highest volume in last N candles
function calcPOC(candles, lookback = 100) {
  const slice = candles.slice(-lookback);
  const buckets = {};
  const step = 100; // $100 price buckets
  for (const c of slice) {
    const bucket = Math.round(c.close / step) * step;
    buckets[bucket] = (buckets[bucket] || 0) + c.volume;
  }
  let maxVol = 0, poc = 0;
  for (const [price, vol] of Object.entries(buckets)) {
    if (vol > maxVol) { maxVol = vol; poc = parseFloat(price); }
  }
  return poc;
}

// Fibonacci 0.786 (golden pocket) — check if price is in zone of recent swing
function calcFibZone(highs, lows, closes, lookback = 50) {
  const n = closes.length;
  const slice_h = highs.slice(-lookback);
  const slice_l = lows.slice(-lookback);
  const swingH = Math.max(...slice_h);
  const swingL = Math.min(...slice_l);
  const price  = closes[n - 1];
  const range  = swingH - swingL;
  const fib786Bull = swingL + range * (1 - 0.786); // 0.214 level from low
  const fib786Bear = swingH - range * (1 - 0.786); // 0.786 from high
  const tolerance  = range * 0.02; // 2% of range as zone width

  return {
    bull: price >= fib786Bull - tolerance && price <= fib786Bull + tolerance,
    bear: price >= fib786Bear - tolerance && price <= fib786Bear + tolerance,
    fib786Bull, fib786Bear,
  };
}

// Liquidity sweep — price wicks below swing low then closes above (bull), or above swing high then closes below (bear)
function calcLiquiditySweep(highs, lows, closes, swLen = 10) {
  const n    = closes.length;
  const last = n - 1;
  const lookback = closes.slice(-swLen - 1, -1);
  const swingL = Math.min(...lows.slice(-swLen - 1, -1));
  const swingH = Math.max(...highs.slice(-swLen - 1, -1));

  // Bull sweep: current low pierces below swing low but close is above it
  const bullSweep = lows[last] < swingL && closes[last] > swingL;
  // Bear sweep: current high pierces above swing high but close is below it
  const bearSweep = highs[last] > swingH && closes[last] < swingH;

  return { bull: bullSweep, bear: bearSweep, swingH, swingL };
}

// 1. Money Flow — EMA50 vs EMA200 trend + MACD momentum (Frankie's primary filter)
function moneyFlowSignal(highs, lows, closes) {
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const macd   = impulseMACDSignal(highs, lows, closes);
  return {
    bull: ema50 > ema200 && macd.bull,
    bear: ema50 < ema200 || macd.bear,
    ema50, ema200,
  };
}

// 2. VWAP position signal
function vwapSignal(candles) {
  const vwap = calcVWAP(candles);
  if (!vwap) return { bull: false, bear: false, vwap: null };
  const price = candles[candles.length - 1].close;
  const pct   = Math.abs((price - vwap) / vwap) * 100;
  return {
    bull: price < vwap && pct < 2.0,  // discount to VWAP — pullback entry zone
    bear: price > vwap && pct < 2.0,  // premium to VWAP — short entry zone
    vwap,
  };
}

// 3. POC signal — price near Point of Control
function pocSignal(candles) {
  const poc   = calcPOC(candles, 100);
  const price = candles[candles.length - 1].close;
  const pct   = Math.abs((price - poc) / poc) * 100;
  return { bull: price >= poc && pct < 1.5, bear: price <= poc && pct < 1.5, poc };
}

// 4. VuManChu — WaveTrend oscillator
function waveTrendSignal(highs, lows, closes, n1 = 10, n2 = 21) {
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = emaArr(ap, n1);
  const d   = emaArr(ap.map((v, i) => (esa[i] != null ? Math.abs(v - esa[i]) : 0)), n1);
  const ci  = ap.map((v, i) =>
    esa[i] != null && d[i] != null && d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0,
  );
  const tci  = emaArr(ci, n2);
  const wt2a = smaArr(tci.map(v => v ?? 0), 4);

  const last = closes.length - 1;
  const wt1 = tci[last] ?? 0, wt1p = tci[last - 1] ?? 0;
  const wt2 = wt2a[last] ?? 0, wt2p = wt2a[last - 1] ?? 0;

  const crossUp   = wt1p <= wt2p && wt1 > wt2;
  const crossDown = wt1p >= wt2p && wt1 < wt2;

  return { bull: crossUp && wt2 < -33, bear: crossDown && wt2 > 33, wt1, wt2 };
}

// 5. Credible Crypto — Impulse MACD (LazyBear, len=34)
function impulseMACDSignal(highs, lows, closes, len = 34, sigLen = 9) {
  const hlc3 = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const hi2  = emaArr(emaArr(highs, len).map(v => v ?? 0), len);
  const lo2  = emaArr(emaArr(lows,  len).map(v => v ?? 0), len);
  const mi2  = emaArr(emaArr(hlc3,  len).map(v => v ?? 0), len);

  const impMDArr = mi2.map((m, i) => {
    if (m == null || hi2[i] == null || lo2[i] == null) return 0;
    return m > hi2[i] ? m - hi2[i] : m < lo2[i] ? m - lo2[i] : 0;
  });
  const sigArr = smaArr(impMDArr, sigLen);

  const last = closes.length - 1;
  const md   = impMDArr[last];
  const hist = md - (sigArr[last] ?? 0);

  return { bull: md > 0 && hist >= 0, bear: md <= 0 || (md > 0 && hist < 0), md, hist };
}

// 6. Frankie Candles — SMC: BOS, CHoCH, FVG detection
function smcSignal(highs, lows, closes, swLen = 5) {
  const n    = closes.length;
  const last = n - 1;

  // Detect pivot highs/lows (need swLen bars on each side)
  let lastSwH = null, lastSwL = null;
  for (let i = swLen; i <= last - swLen; i++) {
    let isH = true, isL = true;
    for (let j = i - swLen; j <= i + swLen; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j]  <= lows[i])  isL = false;
    }
    if (isH) lastSwH = highs[i];
    if (isL) lastSwL = lows[i];
  }

  const price  = closes[last];
  const prevP  = closes[last - 1];
  const bullBOS = lastSwH !== null && prevP <= lastSwH && price > lastSwH;
  const bearBOS = lastSwL !== null && prevP >= lastSwL && price < lastSwL;
  const bullFVG = last >= 2 && highs[last - 2] < lows[last];
  const bearFVG = last >= 2 && lows[last - 2] > highs[last];

  return { bull: bullBOS || bullFVG, bear: bearBOS || bearFVG, bullBOS, bearBOS, bullFVG, bearFVG };
}

// ─── ICT FVG + Order Block Signals ───────────────────────────────────────────

// Price inside a recent unfilled Fair Value Gap (MANDATORY for FVG strategy)
// Bullish FVG: high[i-2] < low[i]  → gap zone = [high[i-2], low[i]]
// Bearish FVG: low[i-2] > high[i]  → gap zone = [high[i], low[i-2]]
function fvgSignal(highs, lows, closes, lb = 30) {
  const last  = closes.length - 1;
  const price = closes[last];
  let bullInZone = false, bearInZone = false;

  for (let i = last - 2; i >= Math.max(2, last - lb); i--) {
    if (!bullInZone) {
      const gapLow = highs[i - 2], gapHigh = lows[i];
      if (gapHigh > gapLow && price >= gapLow && price <= gapHigh) bullInZone = true;
    }
    if (!bearInZone) {
      const gapLow = highs[i], gapHigh = lows[i - 2];
      if (gapHigh > gapLow && price >= gapLow && price <= gapHigh) bearInZone = true;
    }
    if (bullInZone && bearInZone) break;
  }
  return { bull: bullInZone, bear: bearInZone };
}

// Order Block: last opposite-close candle before the FVG-creating impulse
function orderBlockSignal(highs, lows, opens, closes, lb = 30) {
  const last  = closes.length - 1;
  const price = closes[last];
  let bullOB = null, bearOB = null;

  for (let i = last - 2; i >= Math.max(3, last - lb); i--) {
    if (!bullOB && highs[i - 2] < lows[i]) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (closes[j] < opens[j]) { bullOB = { low: lows[j], high: highs[j] }; break; }
      }
    }
    if (!bearOB && lows[i - 2] > highs[i]) {
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

// Change of Character: recent swing broke out of prior range
function chochSignal(highs, lows, closes, swLen = 10, lb = 25) {
  const last = closes.length - 1;
  if (last < lb + swLen) return { bull: false, bear: false };
  const priorH  = Math.max(...highs.slice(last - lb - swLen, last - swLen));
  const priorL  = Math.min(...lows.slice(last - lb - swLen, last - swLen));
  const recentH = Math.max(...highs.slice(last - swLen, last));
  const recentL = Math.min(...lows.slice(last - swLen, last));
  return {
    bull: recentH > priorH && closes[last] > recentH * 0.998,
    bear: recentL < priorL && closes[last] < recentL * 1.002,
  };
}

// Volume Spike: above-average volume confirms the FVG impulse
function volumeSpikeSignal(candles, lb = 20) {
  const last   = candles.length - 1;
  const avgVol = candles.slice(last - lb, last).reduce((s, c) => s + c.volume, 0) / lb;
  const c      = candles[last];
  return {
    bull: c.close > c.open && c.volume > avgVol * 1.5,
    bear: c.close < c.open && c.volume > avgVol * 1.5,
  };
}

// ─── Safety Check (Frankie Candles — 3-of-6 required) ────────────────────────

function runSafetyCheck(systems) {
  console.log("\n── Safety Check (Frankie Candles Strategy) ──────────────\n");

  const rows = [
    ["Money Flow (EMA+MACD)", systems.moneyFlow.bull,  systems.moneyFlow.bear],
    ["VWAP Position",         systems.vwap.bull,       systems.vwap.bear],
    ["POC Level",             systems.poc.bull,        systems.poc.bear],
    ["WaveTrend (momentum)",  systems.wt.bull,         systems.wt.bear],
    ["Liquidity Sweep",       systems.liquidity.bull,  systems.liquidity.bear],
    ["Fib 0.786 Zone",        systems.fib.bull,        systems.fib.bear],
  ];

  let bullScore = 0, bearScore = 0;
  const results = [];

  for (const [label, bull, bear] of rows) {
    const signal = bull ? "BULL ▲" : bear ? "BEAR ▼" : "NEUT —";
    const icon   = bull ? "🟢" : bear ? "🔴" : "⚪";
    console.log(`  ${icon} ${label.padEnd(24)} ${signal}`);
    if (bull) bullScore++;
    if (bear) bearScore++;
    results.push({ label, bull, bear, pass: bull || bear });
  }

  console.log(`\n  Bull score: ${bullScore}/6  |  Bear score: ${bearScore}/6`);

  const MIN_SIG  = 3;
  const longSig  = bullScore >= MIN_SIG && bullScore > bearScore;
  const shortSig = bearScore >= MIN_SIG && bearScore > bullScore;
  const allPass  = longSig || shortSig;
  const direction = longSig ? "LONG" : shortSig ? "SHORT" : "WAIT";

  if (longSig)  console.log(`\n  ✅ LONG  — ${bullScore} systems agree`);
  else if (shortSig) console.log(`\n  ✅ SHORT — ${bearScore} systems agree`);
  else          console.log(`\n  🚫 NO TRADE — need ${MIN_SIG}+ systems aligned (bull:${bullScore} bear:${bearScore})`);

  return { results, allPass, direction, bullScore, bearScore };
}

// ─── Safety Check (ICT FVG — MoneyFlow + FVG mandatory, 2-of-7 total) ────────

function runFVGSafetyCheck(systems) {
  console.log("\n── Safety Check (ICT FVG Strategy) ──────────────────────\n");

  const rows = [
    ["Money Flow (EMA+MACD)", systems.moneyFlow.bull, systems.moneyFlow.bear],
    ["Fair Value Gap",        systems.fvg.bull,       systems.fvg.bear],
    ["Order Block",           systems.ob.bull,        systems.ob.bear],
    ["Change of Character",   systems.choch.bull,     systems.choch.bear],
    ["WaveTrend (momentum)",  systems.wt.bull,        systems.wt.bear],
    ["Volume Spike",          systems.vol.bull,       systems.vol.bear],
    ["POC Level",             systems.poc.bull,       systems.poc.bear],
  ];

  let bullScore = 0, bearScore = 0;
  const results = [];

  for (const [label, bull, bear] of rows) {
    const signal = bull ? "BULL ▲" : bear ? "BEAR ▼" : "NEUT —";
    const icon   = bull ? "🟢" : bear ? "🔴" : "⚪";
    console.log(`  ${icon} ${label.padEnd(24)} ${signal}`);
    if (bull) bullScore++;
    if (bear) bearScore++;
    results.push({ label, bull, bear, pass: bull || bear });
  }

  console.log(`\n  Bull score: ${bullScore}/7  |  Bear score: ${bearScore}/7`);

  const MIN_SIG = 2;
  const longSig  = systems.moneyFlow.bull && systems.fvg.bull && bullScore >= MIN_SIG && bullScore > bearScore;
  const shortSig = systems.moneyFlow.bear && systems.fvg.bear && bearScore >= MIN_SIG && bearScore > bullScore;
  const allPass  = longSig || shortSig;
  const direction = longSig ? "LONG" : shortSig ? "SHORT" : "WAIT";

  if (longSig)       console.log(`\n  ✅ LONG  — ${bullScore} systems agree (MoneyFlow + FVG confirmed)`);
  else if (shortSig) console.log(`\n  ✅ SHORT — ${bearScore} systems agree (MoneyFlow + FVG confirmed)`);
  else               console.log(`\n  🚫 NO TRADE — need MoneyFlow + FVG + ${MIN_SIG}+ total (bull:${bullScore} bear:${bearScore})`);

  return { results, allPass, direction, bullScore, bearScore };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  console.log(`✅ Trade size:   $${tradeSize.toFixed(2)} (max $${CONFIG.maxTradeSizeUSD})`);
  return true;
}

// ─── Phemex Execution ────────────────────────────────────────────────────────
// Auth: HMAC-SHA256(secret, path + expiry + body) → hex
// Expiry = now + 60s

function signPhemex(path, expiry, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.phemex.secretKey)
    .update(`${path}${expiry}${body}`)
    .digest("hex");
}

async function placePhemexOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(8);
  const expiry   = Math.floor(Date.now() / 1000) + 60;
  const path     = CONFIG.tradeMode === "spot" ? "/spot/orders" : "/orders";
  const phemexSide = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();

  const body = JSON.stringify({
    symbol,
    side: phemexSide,
    orderQty: quantity,
    ordType: "Market",
    ...(CONFIG.tradeMode === "futures" && { posSide: "Long", reduceOnly: false }),
  });

  const signature = signPhemex(path, expiry, body);

  const res = await fetch(`${CONFIG.phemex.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-phemex-access-token": CONFIG.phemex.apiKey,
      "x-phemex-request-expiry": String(expiry),
      "x-phemex-request-signature": signature,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(`Phemex order failed: ${data.msg}`);
  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Quantity", "Price", "Total USD", "Fee (est.)", "Net Amount",
  "Order ID", "Mode", "Notes", "P&L USD", "P&L %",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

async function sheetsPost(payload) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function getPosition(tf) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (!webhookUrl) return null;
  try {
    const res = await fetch(`${webhookUrl}?tf=${encodeURIComponent(tf)}`);
    const data = await res.json();
    return data.open ? data : null;
  } catch { return null; }
}

async function writeTradeCsv(logEntry, pnl = null, pnlPct = null) {
  const now  = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = (logEntry.conditions ?? []).filter(c => !c.pass).map(c => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED";
    notes = `No trade: ${logEntry.direction ?? "WAIT"} — ${failed || "insufficient confluence"}`;
  } else if (logEntry.paperTrading) {
    side     = logEntry.direction === "SHORT" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee      = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId  = logEntry.orderId || "";
    mode     = "PAPER";
    notes    = `${logEntry.direction} — all conditions met`;
  } else {
    side     = logEntry.direction === "SHORT" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee      = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId  = logEntry.orderId || "";
    mode     = "LIVE";
    notes    = logEntry.error ? `Error: ${logEntry.error}` : `${logEntry.direction} — all conditions met`;
  }

  const row = [date, time, "Phemex", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), totalUSD, fee, netAmount, orderId, mode, `"${notes}"`,
    pnl != null ? pnl.toFixed(2) : "", pnlPct != null ? pnlPct.toFixed(2) + "%" : ""].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");

  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (webhookUrl) {
    try {
      await sheetsPost({
        action: "log",
        date, time, exchange: "Phemex", symbol: logEntry.symbol,
        side, quantity, price: logEntry.price.toFixed(2),
        totalUSD, fee, netAmount, orderId, mode, notes,
        pnl: pnl != null ? pnl.toFixed(2) : "",
        pnlPct: pnlPct != null ? pnlPct.toFixed(2) + "%" : "",
      });
      console.log(`Google Sheets updated ✓`);
    } catch (err) {
      console.log(`Google Sheets failed: ${err.message}`);
    }
  } else {
    console.log(`Tax record saved → ${CSV_FILE}`);
  }
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found yet."); return; }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows  = lines.slice(1).map(l => l.split(","));
  const live    = rows.filter(r => r[11] === "LIVE");
  const paper   = rows.filter(r => r[11] === "PAPER");
  const blocked = rows.filter(r => r[11] === "BLOCKED");
  const totalVolume = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees   = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-timeframe logic ──────────────────────────────────────────────────────

async function runTimeframe(tf, log) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  Timeframe: ${tf.toUpperCase()} | ${new Date().toISOString()}`);
  console.log(`${"─".repeat(57)}`);

  const candles = await fetchCandles(CONFIG.symbol, tf, 500);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  console.log(`  Price: $${price.toFixed(2)}`);

  const opens     = candles.map(c => c.open);
  const moneyFlow = moneyFlowSignal(highs, lows, closes);
  const vwap      = vwapSignal(candles);
  const poc       = pocSignal(candles);
  const wt        = waveTrendSignal(highs, lows, closes);
  const liquidity = calcLiquiditySweep(highs, lows, closes);
  const fib       = calcFibZone(highs, lows, closes);
  const fvg       = fvgSignal(highs, lows, closes);
  const ob        = orderBlockSignal(highs, lows, opens, closes);
  const choch     = chochSignal(highs, lows, closes);
  const vol       = volumeSpikeSignal(candles);

  const useFrankie = CONFIG.strategy === "frankie" || CONFIG.strategy === "both";
  const useFVG     = CONFIG.strategy === "fvg"     || CONFIG.strategy === "both";

  let frankieResult = null, fvgResult = null;
  if (useFrankie) frankieResult = runSafetyCheck({ moneyFlow, vwap, poc, wt, liquidity, fib });
  if (useFVG)     fvgResult     = runFVGSafetyCheck({ moneyFlow, fvg, ob, choch, wt, vol, poc });

  // Pick a signal: prefer whichever has higher score; both must agree direction if both active
  let allPass, direction, bullScore, bearScore, results;
  if (frankieResult && fvgResult) {
    const frankeDir = frankieResult.direction;
    const fvgDir    = fvgResult.direction;
    if (frankeDir !== "WAIT" && frankeDir === fvgDir) {
      // Both strategies agree — highest conviction
      allPass   = true;
      direction = frankeDir;
      bullScore = Math.max(frankieResult.bullScore, fvgResult.bullScore);
      bearScore = Math.max(frankieResult.bearScore, fvgResult.bearScore);
      results   = [...frankieResult.results, ...fvgResult.results];
      console.log(`\n  ★ DUAL CONFIRM — Frankie + FVG both say ${direction}`);
    } else if (fvgDir !== "WAIT" && frankeDir === "WAIT") {
      ({ allPass, direction, bullScore, bearScore, results } = fvgResult);
    } else if (frankeDir !== "WAIT" && fvgDir === "WAIT") {
      ({ allPass, direction, bullScore, bearScore, results } = frankieResult);
    } else {
      allPass = false; direction = "WAIT";
      bullScore = Math.max(frankieResult.bullScore, fvgResult.bullScore);
      bearScore = Math.max(frankieResult.bearScore, fvgResult.bearScore);
      results = frankieResult.results;
      console.log(`\n  🚫 NO TRADE — strategies disagree (Frankie:${frankeDir} FVG:${fvgDir})`);
    }
  } else {
    ({ allPass, direction, bullScore, bearScore, results } = frankieResult || fvgResult);
  }

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol, timeframe: tf, price,
    indicators: {
      ema50: moneyFlow.ema50, ema200: moneyFlow.ema200,
      moneyFlow: moneyFlow.bull ? "bull" : "bear",
      vwap: vwap.vwap, poc: poc.poc, wt1: wt.wt1, wt2: wt.wt2,
      liquiditySweep: liquidity.bull ? "bull" : liquidity.bear ? "bear" : "none",
      fibZone: fib.bull ? "bull" : fib.bear ? "bear" : "none",
    },
    bullScore, bearScore, conditions: results, allPass, direction,
    tradeSize, orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  // ── Position management ──────────────────────────────
  const openPosition = await getPosition(tf);
  let pnl = null, pnlPct = null;

  if (openPosition) {
    const { direction: posDir, entryPrice, quantity: posQty, tradeSize: posSize } = openPosition;
    const ep   = parseFloat(entryPrice);
    const qty  = parseFloat(posQty);
    const size = parseFloat(posSize);

    const stopHit = posDir === "LONG"
      ? price < ep * (1 - CONFIG.stopPct)
      : price > ep * (1 + CONFIG.stopPct);
    const signalFlip = posDir === "LONG"
      ? (bearScore >= 3 && bearScore > bullScore)
      : (bullScore >= 3 && bullScore > bearScore);

    console.log(`\n  Open ${posDir} from $${ep.toFixed(2)} | stop: ${(CONFIG.stopPct*100).toFixed(1)}%`);
    console.log(`  Stop hit: ${stopHit} | Signal flip: ${signalFlip}`);

    if (stopHit || signalFlip) {
      pnl    = posDir === "LONG" ? (price - ep) * qty : (ep - price) * qty;
      pnlPct = (pnl / size) * 100;
      const emoji = pnl >= 0 ? "✅" : "❌";
      console.log(`  ${emoji} CLOSING ${posDir} — P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) — ${stopHit ? "stop" : "signal flip"}`);
      logEntry.allPass = true;
      logEntry.direction = posDir === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
      logEntry.orderPlaced = true;
      logEntry.orderId = `CLOSE-${Date.now()}`;
      try { await sheetsPost({ action: "clearPosition", tf }); } catch {}
    } else {
      console.log(`  Holding ${posDir} — no exit signal`);
      logEntry.allPass = false;
      logEntry.direction = "HOLD";
    }
  } else if (allPass) {
    const side = direction === "LONG" ? "buy" : "sell";
    if (CONFIG.paperTrading) {
      console.log(`\n  📋 PAPER ${direction} — $${tradeSize.toFixed(2)} ${CONFIG.symbol}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n  🔴 LIVE ${direction} — $${tradeSize.toFixed(2)} ${CONFIG.symbol}`);
      try {
        const order = await placePhemexOrder(CONFIG.symbol, side, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderID || order.orderId;
        console.log(`  ✅ ORDER PLACED — ${logEntry.orderId}`);
      } catch (err) {
        console.log(`  ❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
    if (logEntry.orderPlaced) {
      try {
        await sheetsPost({
          action: "setPosition", tf,
          direction, entryPrice: price,
          quantity: (tradeSize / price).toFixed(6),
          entryTime: new Date().toISOString(),
          tradeSize, symbol: CONFIG.symbol,
        });
      } catch {}
    }
  } else {
    console.log(`\n  🚫 NO TRADE — need 3+ signals (bull:${bullScore} bear:${bearScore})`);
  }

  log.trades.push(logEntry);
  await writeTradeCsv(logEntry, pnl, pnlPct);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  const stratLabel = CONFIG.strategy === "both" ? "Frankie + FVG" : CONFIG.strategy === "fvg" ? "ICT FVG" : "Frankie Candles";
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ${stratLabel} Bot — ${CONFIG.timeframes.join(" + ").toUpperCase()}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Stop: ${(CONFIG.stopPct * 100).toFixed(1)}% | Exit: signal flip`);
  console.log("═══════════════════════════════════════════════════════════");

  const log = loadLog();
  if (!checkTradeLimits(log)) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  for (const tf of CONFIG.timeframes) {
    await runTimeframe(tf, log);
  }

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
