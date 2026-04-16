#!/usr/bin/env node
/**
 * TradingView Signal Dashboard — HTTP server + SSE
 * Serves dashboard.html and streams live log data via Server-Sent Events
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const CWD   = 'C:/TradingView Bot/tradingview-mcp';

const SIGNAL_LOG  = path.join(CWD, 'signal_output.log');
const MONITOR_LOG = path.join(CWD, 'monitor_output.log');

// ── SSE client registry ───────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
}

// ── Log tailing ───────────────────────────────────────────────
function tailFile(filePath, label) {
  if (!fs.existsSync(filePath)) return;
  let size = fs.statSync(filePath).size;
  fs.watch(filePath, () => {
    try {
      const newSize = fs.statSync(filePath).size;
      if (newSize <= size) return;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(newSize - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = newSize;
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      lines.forEach(line => broadcast('log', { source: label, line }));
    } catch {}
  });
}

tailFile(SIGNAL_LOG,  'signal');
tailFile(MONITOR_LOG, 'monitor');

// ── Live state from TradingView ───────────────────────────────
function run(cmd) {
  try {
    return JSON.parse(execSync(`node src/cli/index.js ${cmd}`, { cwd: CWD, timeout: 6000, encoding: 'utf8' }));
  } catch { return null; }
}

async function fetchLiveState() {
  const quote  = run('quote');
  const tables = run('data tables');
  const state  = { price: null, trend: null, inst: null, market: null, ts: new Date().toISOString() };

  if (quote?.last) state.price = { last: quote.last, high: quote.high, low: quote.low, volume: quote.volume };

  if (tables?.studies) {
    for (const s of tables.studies) {
      if (!s.name?.includes('BTrader Conept')) continue;
      for (const t of (s.tables || [])) {
        for (const row of (t.rows || [])) {
          const tm = row.match(/Trend:\s*(🐂|🐻)/);  if (tm) state.trend  = tm[1];
          const im = row.match(/Inst:\s*(✅|❌)/);    if (im) state.inst   = im[1];
          const mm = row.match(/Market:\s*(📈|📉)/);  if (mm) state.market = mm[1];
        }
      }
    }
  }
  return state;
}

// Poll TradingView every 4s and broadcast
setInterval(async () => {
  if (clients.size === 0) return;
  const state = await fetchLiveState();
  broadcast('state', state);
}, 4000);

// ── Parse existing logs for initial load ──────────────────────
function readLog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').filter(l => l.trim()).slice(-200);
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // SSE endpoint
  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    clients.add(res);

    // Send initial history
    const sigLines = readLog(SIGNAL_LOG).map(l => ({ source: 'signal',  line: l }));
    const monLines = readLog(MONITOR_LOG).map(l => ({ source: 'monitor', line: l }));
    const all = [...monLines, ...sigLines].slice(-300);
    res.write(`event: history\ndata: ${JSON.stringify(all)}\n\n`);

    // Send current live state
    const state = await fetchLiveState();
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

    req.on('close', () => clients.delete(res));
    return;
  }

  // API: raw log
  if (url === '/api/logs') {
    const out = {
      signal:  readLog(SIGNAL_LOG),
      monitor: readLog(MONITOR_LOG),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  // Serve dashboard HTML
  if (url === '/' || url === '/index.html') {
    const htmlPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end('dashboard.html not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  XAUUSD Dashboard  →  http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Signal log : ${SIGNAL_LOG}`);
  console.log(`  Monitor log: ${MONITOR_LOG}`);
  console.log(`  SSE clients connected: 0`);
});

process.stdin.resume();
process.on('SIGINT', () => { server.close(); process.exit(0); });
