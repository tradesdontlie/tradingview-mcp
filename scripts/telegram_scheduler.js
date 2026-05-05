#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_INTERVAL_MS = 60_000;

function loadDotEnv(path) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(scriptDir, '..', '.env'));

const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  intervalMs: Number(process.env.SCHEDULE_INTERVAL_MS || DEFAULT_INTERVAL_MS),
};

const mode = process.argv.includes('--test') ? 'test' : 'schedule';

function assertConfig() {
  const missing = [];
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.chatId) missing.push('TELEGRAM_CHAT_ID');
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 5_000) {
    missing.push('SCHEDULE_INTERVAL_MS >= 5000');
  }

  if (missing.length > 0) {
    throw new Error(`Missing or invalid config: ${missing.join(', ')}`);
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const detail = payload ? JSON.stringify(payload) : response.statusText;
    throw new Error(`Telegram send failed: ${detail}`);
  }

  return payload.result;
}

const TIMEFRAMES = [
  { tf: '15m', interval: '15m', range: '5d', tiers: [
    ['Ultra-tight 4h', 16, 15],
    ['Tight 6h', 24, 25],
    ['Cold 12h', 48, 40],
  ]},
  { tf: '30m', interval: '30m', range: '10d', tiers: [
    ['Tight 8h', 16, 30],
    ['Cold 16h', 32, 50],
    ['Extended 24h', 48, 70],
  ]},
  { tf: '1h',  interval: '60m', range: '30d', tiers: [
    ['Cold 24h', 24, 70],
    ['Extended 48h', 48, 100],
    ['Multi-day 72h', 72, 130],
  ]},
];

async function fetchTimeframe(interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${interval}/${range})`);
  const raw = await res.json();
  const r = raw.chart.result[0];
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: ts[i], h, l, c });
  }
  return bars;
}

function analyzeTimeframe(bars, tiers) {
  const last = bars[bars.length - 1];
  const recent4 = bars.slice(-4);
  const results = [];

  for (const [label, lookback, maxRange] of tiers) {
    if (bars.length < lookback + 4) continue;
    const window = bars.slice(-(lookback + 4), -4);
    const winHigh = Math.max(...window.map((b) => b.h));
    const winLow = Math.min(...window.map((b) => b.l));
    const winRange = winHigh - winLow;
    if (winRange > maxRange) continue;

    const signals = [];
    let bias = 0;
    const { c, h, l, t } = last;
    const f = (n) => n.toFixed(1);

    if (c > winHigh + 10) { signals.push(`💥↑+${f(c-winHigh)}p`); bias++; }
    else if (c > winHigh) { signals.push(`📈↑${f(c)}`); bias++; }

    if (c < winLow - 10) { signals.push(`💥↓-${f(winLow-c)}p`); bias--; }
    else if (c < winLow) { signals.push(`📉↓${f(c)}`); bias--; }

    if (h > winHigh && c <= winHigh) { signals.push(`🫊sweep↑${f(h)}↺${f(c)}`); bias--; }
    if (l < winLow  && c >= winLow ) { signals.push(`🫊sweep↓${f(l)}↺${f(c)}`); bias++; }

    for (const b of recent4.slice(0, -1)) {
      if (b.c > winHigh) { signals.push(`⏪↑broke ${Math.round((t-b.t)/60)}m ago @${f(b.c)}`); bias++; break; }
      if (b.c < winLow ) { signals.push(`⏪↓broke ${Math.round((t-b.t)/60)}m ago @${f(b.c)}`); bias--; break; }
    }

    if (signals.length) results.push({ label, winHigh, winLow, winRange, signals, bias });
  }

  return results;
}

async function checkMarketAndBuildAlert() {
  const allBars = await Promise.all(
    TIMEFRAMES.map((t) => fetchTimeframe(t.interval, t.range))
  );

  const lastPrice = allBars[0][allBars[0].length - 1].c;
  const tfResults = TIMEFRAMES.map((t, i) => ({
    ...t,
    results: analyzeTimeframe(allBars[i], t.tiers),
  }));
  const tfsWithSignal = tfResults.filter((t) => t.results.length > 0);

  if (tfsWithSignal.length === 0) return null;

  const totalBias = tfResults.reduce(
    (s, t) => s + t.results.reduce((s2, r) => s2 + r.bias, 0),
    0
  );
  const arrow = totalBias > 0 ? '↑' : totalBias < 0 ? '↓' : '⚡';
  const tfNames = tfsWithSignal.map((t) => t.tf).join('+');

  const lines = [`${arrow} XAUUSD ${lastPrice.toFixed(1)} break (${tfNames})`];
  for (const t of tfsWithSignal) {
    for (const r of t.results) {
      lines.push(
        `${t.tf.padEnd(3)} ${r.label} @${r.winLow.toFixed(0)}-${r.winHigh.toFixed(0)}: ${r.signals.join(' ')}`
      );
    }
  }
  return lines.join('\n');
}

let running = false;

async function runTick(reason) {
  if (running) {
    console.log(`[${new Date().toISOString()}] skipped; previous tick still running`);
    return;
  }

  running = true;
  try {
    const alertText = await checkMarketAndBuildAlert();
    if (alertText) {
      const message = await sendTelegram(alertText);
      console.log(`[${new Date().toISOString()}] alert sent, message_id=${message.message_id}`);
    } else {
      console.log(`[${new Date().toISOString()}] ${reason}: no alert`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] tick failed:`, error.message);
  } finally {
    running = false;
  }
}

assertConfig();

if (mode === 'test') {
  const result = await sendTelegram(`Scheduler test message: ${new Date().toISOString()}`);
  console.log(`Telegram test sent, message_id=${result.message_id}`);
  process.exit(0);
}

console.log(`Scheduler started. Interval: ${config.intervalMs}ms`);
await runTick('startup');
setInterval(() => {
  void runTick('interval');
}, config.intervalMs);
