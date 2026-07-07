#!/usr/bin/env node
/**
 * Clear ALL Drawings on Watchlist
 *
 * Launches/connects to TradingView Desktop (CDP on localhost:9222), reads the
 * full watchlist (virtual-scroll aware), and removes EVERY shape/drawing on each
 * ticker's chart via getAllShapes() + removeEntity().
 *
 * Unlike the daily markup's selective removal, this wipes everything — used for
 * the weekly clean slate before drawing new play levels.
 *
 * Logs to logs/clear-drawings-YYYY-MM-DD.log.
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

function pad(n) { return String(n).padStart(2, '0'); }
function formatDateLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `clear-drawings-${formatDateLocal(new Date())}.log`);
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
  log('ERROR: TradingView CDP did not become available within 60s');
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

async function readWatchlist(client) {
  await run(client, `window.__tvReadWl = {
    getVisible: function(){
      var out = [];
      document.querySelectorAll('[data-symbol-full]').forEach(function(e){
        var s = e.getAttribute('data-symbol-full');
        if(s) out.push(s);
      });
      document.querySelectorAll('[class*="symbolNameText"]').forEach(function(e){
        var txt = (e.textContent||'').trim();
        if(txt && /^[A-Z0-9!.]+$/.test(txt)) out.push(txt);
      });
      return out;
    },
    findScroller: function(){
      var sample = document.querySelector('[data-symbol-full]') || document.querySelector('[class*="symbolNameText"]');
      if(!sample) return null;
      var s = sample.parentElement;
      while(s && s !== document.body){
        if(s.scrollHeight > s.offsetHeight + 5) return s;
        s = s.parentElement;
      }
      return null;
    },
    scroller: null
  }; window.__tvReadWl.scroller = window.__tvReadWl.findScroller(); 1`);

  const scrollInfo = await run(client, `(function(){
    var s = window.__tvReadWl.scroller;
    if(!s) return null;
    return { scrollHeight: s.scrollHeight, offsetHeight: s.offsetHeight, top: s.scrollTop };
  })()`);

  if (!scrollInfo) {
    return await run(client, `window.__tvReadWl.getVisible()`);
  }

  const seen = new Set();
  const captureVisible = async () => {
    const visible = await run(client, `window.__tvReadWl.getVisible()`);
    if (visible) visible.forEach(s => seen.add(s));
  };

  for (let pass = 0; pass < 2; pass++) {
    await run(client, `window.__tvReadWl.scroller.scrollTop = 0; 1`);
    await sleep(1000);
    await captureVisible();
    let stuckCount = 0;
    const maxIter = 300;
    for (let i = 0; i < maxIter; i++) {
      await captureVisible();
      const stepInfo = await run(client, `(function(){
        var s = window.__tvReadWl.scroller;
        var before = s.scrollTop;
        s.scrollTop = before + 60;
        return { before: before, after: s.scrollTop };
      })()`);
      await sleep(350);
      await captureVisible();
      const advanced = stepInfo && stepInfo.after > stepInfo.before;
      if (!advanced) { stuckCount++; if (stuckCount >= 3) break; }
      else stuckCount = 0;
    }
    await run(client, `window.__tvReadWl.scroller.scrollTop = 99999999; 1`);
    await sleep(600);
    await captureVisible();
  }

  await run(client, `if(window.__tvReadWl && window.__tvReadWl.scroller) window.__tvReadWl.scroller.scrollTop = 0; 1`);
  return Array.from(seen);
}

async function clearTicker(client, sym) {
  const ticker = sym.split(':')[1] || sym;
  await run(client, `window.TradingViewApi.activeChart().setSymbol('${sym}')`);
  await sleep(1500);
  const currentSym = await run(client, `window.TradingViewApi.activeChart().symbol()`);
  if (!currentSym || !currentSym.includes(ticker)) {
    return { ticker, error: `symbol mismatch (got: ${currentSym})` };
  }
  // Remove EVERY shape on the chart.
  const result = await run(client, `(function(){
    var chart=window.TradingViewApi.activeChart();
    var shapes=chart.getAllShapes();
    var n=shapes.length, removed=0;
    for(var i=0;i<shapes.length;i++){
      try{ chart.removeEntity(shapes[i].id); removed++; }catch(e){}
    }
    return { total:n, removed:removed };
  })()`);
  return { ticker, ...(result || { total: 0, removed: 0 }) };
}

async function main() {
  log('=== clear-drawings start ===');
  if (!(await ensureTradingViewRunning())) process.exit(1);

  const client = await getClient();
  if (!(await waitForTradingViewApi(client))) {
    log('ERROR: TradingViewApi not ready');
    process.exit(1);
  }
  log('TradingViewApi ready');

  let symbols = await readWatchlist(client);
  if (!symbols || symbols.length === 0) {
    log('WARN: watchlist read empty, falling back to baseline');
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist-baseline.json'), 'utf8'));
    symbols = baseline;
  }
  // Keep only fully-qualified EXCHANGE:TICKER entries (drop bare-name dupes from DOM scrape)
  const qualified = symbols.filter(s => s.includes(':'));
  const list = qualified.length ? qualified : symbols;
  log(`Watchlist: ${list.length} symbols`);

  let cleared = 0, totalRemoved = 0;
  const failures = [];
  for (const sym of list) {
    try {
      const r = await clearTicker(client, sym);
      if (r.error) { failures.push(`${sym}: ${r.error}`); log(`  ${sym} — SKIP (${r.error})`); }
      else { cleared++; totalRemoved += r.removed; log(`  ${sym} — removed ${r.removed}/${r.total}`); }
    } catch (e) {
      failures.push(`${sym}: ${e.message}`);
      log(`  ${sym} — ERROR ${e.message}`);
    }
  }

  log(`=== clear-drawings done: ${cleared}/${list.length} charts cleared, ${totalRemoved} drawings removed ===`);
  if (failures.length) log(`Failures (${failures.length}): ${failures.join(' | ')}`);
  await client.close();
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.stack || e}`); process.exit(1); });
