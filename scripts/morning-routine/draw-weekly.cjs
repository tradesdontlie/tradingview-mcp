#!/usr/bin/env node
/**
 * Draw Weekly Play Levels — June 22–26, 2026
 *
 * Connects to TradingView Desktop (CDP on localhost:9222), and for each play:
 *   - resolves the correct exchange prefix (candidate list + bar-count verify, BATS fallback)
 *   - switches chart to Daily ('D')
 *   - clears any residual play lines (green/red/purple) for idempotency
 *   - draws an ENTRY line and a TARGET line
 *
 * Convention (matches prior weeks):
 *   BULL ENTRY -> green  #00E676  solid
 *   TARGET     -> purple #E040FB  solid
 *
 * Logs to logs/draw-weekly-YYYY-MM-DD.log.
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// --- This week's plays (June 22–26) ---
// candidates: ordered exchange-qualified symbols to try until bars>5 confirms data.
const PLAYS = [
  { t: 'NVDA',  cand: ['NASDAQ:NVDA'],            entry: 209.75, target: 218.35 },
  { t: 'AAPL',  cand: ['NASDAQ:AAPL'],            entry: 300.00, target: 308.30 },
  { t: 'AMZN',  cand: ['NASDAQ:AMZN'],            entry: 247.00, target: 255.50 },
  { t: 'GOOGL', cand: ['NASDAQ:GOOGL'],           entry: 373.50, target: 381.00 },
  { t: 'META',  cand: ['NASDAQ:META'],            entry: 580.00, target: 591.00 },
  { t: 'INTC',  cand: ['NASDAQ:INTC'],            entry: 123.85, target: 135.50 },
  { t: 'CRWV',  cand: ['NASDAQ:CRWV'],            entry: 120.25, target: 132.00 },
  { t: 'HOOD',  cand: ['NASDAQ:HOOD'],            entry: 108.75, target: 114.75 },
  { t: 'TSM',   cand: ['NYSE:TSM'],               entry: 450.00, target: 465.25 },
  { t: 'MRNA',  cand: ['NASDAQ:MRNA', 'BATS:MRNA'], entry: 57.65,  target: 67.60 },
  { t: 'IONQ',  cand: ['NYSE:IONQ', 'BATS:IONQ'], entry: 56.66,  target: 61.25 },
  { t: 'BTDR',  cand: ['NASDAQ:BTDR', 'BATS:BTDR'], entry: 18.00,  target: 20.90 },
];

const ENTRY_COLOR  = '#00E676'; // green
const TARGET_COLOR = '#E040FB'; // purple
const BEAR_COLOR   = '#FF5252'; // red (cleared, not used this week)

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `draw-weekly-${fmtDate(new Date())}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureTradingViewRunning() {
  try {
    const v = execSync('curl -s --max-time 3 http://localhost:9222/json/version', { encoding: 'utf8' });
    if (v && v.includes('TradingView')) { log('TradingView CDP already running'); return true; }
  } catch (e) {}
  log('TradingView CDP not detected, launching...');
  spawn('open', ['-a', 'TradingView', '--args', '--remote-debugging-port=9222'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const v = execSync('curl -s --max-time 3 http://localhost:9222/json/version', { encoding: 'utf8' });
      if (v && v.includes('TradingView')) { log(`TradingView CDP ready after ${(i + 1) * 2}s`); return true; }
    } catch (e) {}
  }
  return false;
}

async function getClient() {
  const client = await CDP({ port: 9222 });
  await client.Runtime.enable();
  return client;
}

async function run(client, expr) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.result) return r.result.value;
  return null;
}

async function waitForTradingViewApi(client, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ready = await run(client, `typeof window.TradingViewApi !== 'undefined' && window.TradingViewApi.activeChart ? 'ready' : 'not'`);
    if (ready === 'ready') return true;
    await sleep(2000);
  }
  return false;
}

async function barCount(client) {
  return await run(client, `(function(){try{
    var s=window.TradingViewApi.activeChart()._chartWidget.model().mainSeries();
    var b=s.bars(); var n=0; b.each(function(){n++}); return n;
  }catch(e){return -1;}})()`);
}

// Try candidates until one resolves with data on the Daily timeframe.
async function resolveSymbol(client, candidates) {
  for (const sym of candidates) {
    await run(client, `window.TradingViewApi.activeChart().setSymbol('${sym}')`);
    await sleep(1500);
    await run(client, `window.TradingViewApi.activeChart().setResolution('D')`);
    await sleep(2000);
    const resolved = await run(client, `window.TradingViewApi.activeChart().symbol()`);
    const bars = await barCount(client);
    if (bars > 5) return { sym, resolved, bars };
    log(`    candidate ${sym} -> resolved ${resolved}, bars=${bars} (insufficient)`);
  }
  return null;
}

async function clearPlayLines(client) {
  await run(client, `(function(){
    var chart=window.TradingViewApi.activeChart();
    var shapes=chart.getAllShapes();
    for(var i=0;i<shapes.length;i++){
      var s=shapes[i];
      try{
        var p=chart.getShapeById(s.id).getProperties();
        var c=(p.linecolor||p.color||'').toLowerCase();
        if(s.name==='horizontal_line' && (c==='#00e676'||c==='#e040fb'||c==='#ff5252')){
          chart.removeEntity(s.id);
        }
      }catch(e){}
    }
  })()`);
}

async function drawLine(client, price, color, text) {
  await run(client, `(function(){var chart=window.TradingViewApi.activeChart();chart.createShape({time:Math.floor(Date.now()/1000),price:${price}},{shape:'horizontal_line',lock:true,disableSelection:false,overrides:{linecolor:'${color}',linestyle:0,linewidth:2,showLabel:true,text:'${text}',textcolor:'${color}',fontsize:10,horzLabelsAlign:'right',showPrice:true}})})()`);
}

async function main() {
  log('=== draw-weekly start (June 22–26) ===');
  if (!(await ensureTradingViewRunning())) { log('FATAL: CDP unavailable'); process.exit(1); }
  let client = await getClient();
  if (!(await waitForTradingViewApi(client))) { log('FATAL: TradingViewApi not ready'); process.exit(1); }
  log('TradingViewApi ready');

  const done = [], failed = [];
  for (const play of PLAYS) {
    try {
      const res = await resolveSymbol(client, play.cand);
      if (!res) { failed.push(`${play.t} (no data on: ${play.cand.join(', ')})`); log(`${play.t} — FAILED to resolve`); continue; }
      await clearPlayLines(client);
      await drawLine(client, play.entry,  ENTRY_COLOR,  `BULL ENTRY ${play.entry.toFixed(2)}`);
      await drawLine(client, play.target, TARGET_COLOR, `TARGET ${play.target.toFixed(2)}`);
      done.push(`${play.t}@${res.resolved}`);
      log(`${play.t} — ${res.resolved} (${res.bars} bars): ENTRY ${play.entry.toFixed(2)} / TARGET ${play.target.toFixed(2)}`);
    } catch (e) {
      // WebSocket drop recovery: reconnect and retry once.
      log(`${play.t} — error ${e.message}; reconnecting CDP...`);
      try { await client.close(); } catch (_) {}
      try {
        client = await getClient();
        await waitForTradingViewApi(client);
        const res = await resolveSymbol(client, play.cand);
        if (res) {
          await clearPlayLines(client);
          await drawLine(client, play.entry,  ENTRY_COLOR,  `BULL ENTRY ${play.entry.toFixed(2)}`);
          await drawLine(client, play.target, TARGET_COLOR, `TARGET ${play.target.toFixed(2)}`);
          done.push(`${play.t}@${res.resolved}`);
          log(`${play.t} — recovered, drawn on ${res.resolved}`);
        } else { failed.push(`${play.t} (post-reconnect no data)`); }
      } catch (e2) {
        failed.push(`${play.t} (${e2.message})`);
        log(`${play.t} — FAILED after reconnect: ${e2.message}`);
      }
    }
  }

  log(`=== draw-weekly done: ${done.length}/${PLAYS.length} drawn ===`);
  log(`Drawn: ${done.join(', ')}`);
  if (failed.length) log(`FAILED (${failed.length}): ${failed.join(' | ')}`);
  try { await client.close(); } catch (_) {}
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.stack || e}`); process.exit(1); });
