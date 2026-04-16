#!/usr/bin/env node
// XAUUSD Chart Monitor — price alerts + indicator state watcher
import { connect, evaluate } from './src/connection.js';
import { execSync } from 'child_process';

// ── KEY LEVELS ────────────────────────────────────────────────
const LEVELS = [
  { key: 'INVALIDATION',   price: 4823.06, side: 'above', label: '🚫 INVALIDATION — NY Open reclaimed, bias shifts BULL' },
  { key: 'BEAR_OB',        price: 4820.36, side: 'above', label: '⚠️  Entering Bearish OB top (4820.36)' },
  { key: 'SELL_ZONE',      price: 4818.00, side: 'above', label: '🔴 SELL ZONE entered (4818–4820) — watch for rejection' },
  { key: 'SELL_REVERSAL',  price: 4814.40, side: 'below', label: '⚡ SELL REVERSAL triggered (4814.40)' },
  { key: 'TARGET_1',       price: 4811.87, side: 'below', label: '✅ TARGET 1 HIT — Pivot Bottom 4811.87' },
  { key: 'SSL_TWIN',       price: 4811.59, side: 'below', label: '💧 SSL Twin Lows swept (4811.59)' },
  { key: 'TARGET_2',       price: 4805.17, side: 'below', label: '🎯 TARGET 2 HIT — VAL + SSL 4805.17' },
  { key: 'PDL',            price: 4786.08, side: 'below', label: '🔥 PDL REACHED — 4786.08' },
];

const POLL_PRICE_MS     = 3000;
const POLL_INDICATOR_MS = 20000;
const HEARTBEAT_MS      = 60000;

// ── STATE ─────────────────────────────────────────────────────
const triggered  = new Set();
let lastPrice    = null;
let lastTrend    = null;
let lastInst     = null;
let lastMarket   = null;
let tickCount    = 0;
let alertCount   = 0;

const fmt = (n) => (+n).toFixed(2);
const ts  = () => new Date().toTimeString().slice(0, 8);

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
}

function alert(lines) {
  alertCount++;
  console.log('\n' + '▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶');
  lines.forEach(l => console.log('  ' + l));
  console.log('▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶\n');
}

// ── PRICE TICK ────────────────────────────────────────────────
async function tickPrice() {
  try {
    const raw = execSync('node src/cli/index.js quote', {
      cwd: 'C:/TradingView Bot/tradingview-mcp',
      timeout: 5000, encoding: 'utf8'
    });
    const q = JSON.parse(raw);
    if (!q?.last) return;

    const price = q.last;
    tickCount++;

    // Log every move >= 0.5 pts
    if (lastPrice === null || Math.abs(price - lastPrice) >= 0.5) {
      const dir = lastPrice === null ? '→' : price > lastPrice ? '▲' : '▼';
      log(`${dir} ${fmt(price)}   H:${fmt(q.high)}  L:${fmt(q.low)}  Vol:${q.volume}`);
      lastPrice = price;
    }

    // Level alerts
    for (const lvl of LEVELS) {
      if (triggered.has(lvl.key)) continue;
      const hit = lvl.side === 'above' ? price >= lvl.price : price <= lvl.price;
      if (hit) {
        triggered.add(lvl.key);
        alert([
          `ALERT #${alertCount + 1}  [${ts()}]`,
          lvl.label,
          `Price: ${fmt(price)}  |  Level: ${fmt(lvl.price)}`,
        ]);
      }
    }
  } catch {}
}

// ── INDICATOR WATCH ───────────────────────────────────────────
async function checkIndicators() {
  try {
    const raw = execSync('node src/cli/index.js data tables', {
      cwd: 'C:/TradingView Bot/tradingview-mcp',
      timeout: 8000, encoding: 'utf8'
    });
    const data = JSON.parse(raw);

    for (const study of (data.studies || [])) {
      if (!study.name.includes('BTrader Conept')) continue;
      for (const tbl of (study.tables || [])) {
        for (const row of (tbl.rows || [])) {
          const tm = row.match(/Trend:\s*(🐂|🐻)/);
          if (tm) {
            const trend = tm[1];
            if (lastTrend !== null && trend !== lastTrend) {
              alert([`🔄 TREND FLIP: ${lastTrend} → ${trend}`,
                trend === '🐻' ? 'Session BEARISH — bears in control' : 'Session BULLISH — bulls in control']);
            }
            lastTrend = trend;
          }
          const im = row.match(/Inst:\s*(✅|❌)/);
          if (im) {
            const inst = im[1];
            if (lastInst !== null && inst !== lastInst) {
              alert([`🏦 INST FLOW: ${lastInst} → ${inst}`,
                inst === '✅' ? '⚡ Smart money detected — big move expected' : 'Institutional flow withdrawn']);
            }
            lastInst = inst;
          }
          const mm = row.match(/Market:\s*(📈|📉)/);
          if (mm) {
            const mkt = mm[1];
            if (lastMarket !== null && mkt !== lastMarket) {
              alert([`📊 MARKET FLIP: ${lastMarket} → ${mkt}`,
                mkt === '📉' ? 'Market turned BEARISH' : 'Market turned BULLISH']);
            }
            lastMarket = mkt;
          }
        }
      }
    }
  } catch {}
}

// ── HEARTBEAT ─────────────────────────────────────────────────
function heartbeat() {
  const triggered_list = triggered.size ? [...triggered].join(', ') : 'none';
  log(`💓 ALIVE | price:${lastPrice ? fmt(lastPrice) : '?'} | ticks:${tickCount} | alerts:${alertCount} | triggered:[${triggered_list}] | Trend:${lastTrend || '?'} Inst:${lastInst || '?'}`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   XAUUSD 5m MONITOR  —  BTrader + ICT Levels            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  LEVELS.forEach(l => console.log(`  ${l.side === 'above' ? '⬆' : '⬇'}  ${fmt(l.price)}  ${l.label}`));
  console.log('  Heartbeat every 60s | Alerts on level break | Indicator flip detection');
  console.log('');

  await connect();
  log('✅ Connected to TradingView CDP');

  await checkIndicators();
  log(`📊 State — Trend:${lastTrend || '?'}  Inst:${lastInst || '?'}  Market:${lastMarket || '?'}`);
  log('🟢 Monitoring started...');
  console.log('');

  setInterval(tickPrice, POLL_PRICE_MS);
  setInterval(checkIndicators, POLL_INDICATOR_MS);
  setInterval(heartbeat, HEARTBEAT_MS);

  process.stdin.resume();
  process.on('SIGINT', () => { log('Monitor stopped.'); process.exit(0); });
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
