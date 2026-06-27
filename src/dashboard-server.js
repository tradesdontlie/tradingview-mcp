#!/usr/bin/env node
/**
 * Dashboard server — serves the live HTML/JS dashboard and the REST API it
 * polls for regime (trend/range + liquidity-sweep/reversal/trade-bias),
 * Asian index drops, and news headlines.
 *
 * Run: node src/dashboard-server.js [--port 4545]
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { analyzeRegime } from './core/regime.js';
import { getAsiaIndices } from './core/asiaIndices.js';
import { getNews } from './core/news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values: argv } = parseArgs({
  options: { port: { type: 'string', short: 'p', default: '4545' } },
  strict: false,
});
const PORT = Number(argv.port) || 4545;

// Only the continuous front-month contracts — ignore the explicit-month
// duplicates (MNQU2026, MGCQ2026 etc) that also show up as separate panes.
const SYMBOL_FILTER = ['MGC1!', 'MNQ1!'];
function keepPane(p) {
  return SYMBOL_FILTER.some(s => (p.symbol || '').includes(s));
}

const app = express();
app.use(express.static(path.resolve(__dirname, '../public')));

// In-memory rolling history, same idea as the CLI agent's history buffer,
// so the dashboard can show NOW / -1m / -5m / -10m without re-querying CDP.
const MAX_HISTORY_MS = 12 * 60 * 1000;
const regimeHistory = [];

function pushHistory(result) {
  regimeHistory.push({ ts: result.ts || Date.now(), panes: result.panes });
  const cutoff = Date.now() - MAX_HISTORY_MS;
  while (regimeHistory.length > 0 && regimeHistory[0].ts < cutoff) regimeHistory.shift();
}

function snapshotAt(offsetSec) {
  if (regimeHistory.length === 0) return null;
  const target = Date.now() - offsetSec * 1000;
  let best = null, bestDelta = Infinity;
  for (const h of regimeHistory) {
    const d = Math.abs(h.ts - target);
    if (d < bestDelta) { bestDelta = d; best = h; }
  }
  return best;
}

let lastRegimeError = null;

let pollInFlight = false;

async function pollRegime() {
  if (pollInFlight) return;  // never stack calls if CDP is slow — keeps ticks real-time, not queued
  pollInFlight = true;
  try {
    const result = await analyzeRegime();
    if (result && result.panes) {
      result.panes = result.panes.filter(keepPane);
      pushHistory(result);
      lastRegimeError = null;
    }
  } catch (err) {
    lastRegimeError = err.message;
  } finally {
    pollInFlight = false;
  }
}

// Tight poll loop for real-time ticks — CDP round-trip is ~80ms, so 300ms
// gives a fresh quote/structure read several times a second without
// hammering the chart. HTTP requests just read the cache, never block on CDP.
const REGIME_POLL_MS = 300;
setInterval(pollRegime, REGIME_POLL_MS);
pollRegime();

app.get('/api/regime', (req, res) => {
  const now    = snapshotAt(0);
  const min1   = snapshotAt(60);
  const min5   = snapshotAt(300);
  const min10  = snapshotAt(600);
  res.json({
    error: lastRegimeError,
    now:   now  || null,
    min1:  min1 || null,
    min5:  min5 || null,
    min10: min10 || null,
  });
});

// Proactive background refresh so data is fresh even if the dashboard tab is closed
setInterval(() => { getAsiaIndices().catch(() => {}); }, 60 * 1000);
setInterval(() => { getNews().catch(() => {}); }, 2 * 60 * 1000);
getAsiaIndices().catch(() => {});
getNews().catch(() => {});

app.get('/api/asia', async (req, res) => {
  try {
    const data = await getAsiaIndices();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const data = await getNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  process.stderr.write(
    `\x1b[2m⚠  tradingview-mcp  |  Not affiliated with TradingView Inc.\x1b[0m\n` +
    `Dashboard running at \x1b[1mhttp://localhost:${PORT}\x1b[0m\n`
  );
});
