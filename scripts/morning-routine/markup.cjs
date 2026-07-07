#!/usr/bin/env node
/**
 * Morning Markup Routine
 *
 * Runs daily at ~8:45 AM ET (weekdays) via launchd.
 * Connects to TradingView Desktop (CDP on localhost:9222), iterates the watchlist,
 * and marks each ticker with:
 *   - PDH/PDL/PDC (cyan) from yesterday's RTH (13:30-20:00 UTC)
 *   - PMH/PML (orange) from today's pre-market (08:00-13:30 UTC)
 *   - S/R levels (yellow) from 5-day swing analysis + round numbers
 *
 * Preserves green/red/magenta lines (weekly play entries/targets).
 * Logs everything to logs/morning-markup-YYYY-MM-DD.log for auditing.
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// --- Logging ---
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const today = new Date();
const logFile = path.join(LOG_DIR, `morning-markup-${formatDateLocal(today)}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// --- Date utilities ---

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns the previous trading day (skipping Sat/Sun) given a Date.
 * Date arithmetic in local time (ET).
 */
// US stock-market full-day closures. Equity feeds have no bars on these dates, so
// they must be skipped when finding the prior trading day (otherwise PDH/PDL/PDC
// come back N/A — e.g. the Monday after Juneteenth lands on a closed Friday).
const MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

function getPreviousTradingDay(date) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6 || MARKET_HOLIDAYS.has(formatDateLocal(d))) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * Get Unix timestamp for midnight UTC of a given local-date.
 * Takes a Date and returns the UTC midnight of that calendar date.
 */
function getMidnightUTC(date) {
  // Build a UTC date with the same y/m/d as the local date
  const utcMidnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  return Math.floor(utcMidnight / 1000);
}

/**
 * Compute timestamp window for yesterday's RTH session and today's pre-market.
 * RTH:  13:30 UTC to 20:00 UTC  (9:30 AM - 4:00 PM ET, DST-adjusted on TV side anyway)
 * PM:   08:00 UTC to 13:30 UTC  (4:00 AM - 9:30 AM ET)
 *
 * Note: We use UTC offsets directly because TV bar timestamps are UTC seconds.
 * During DST, ET = UTC-4. During standard time, ET = UTC-5. The 13:30 UTC anchor
 * corresponds to 9:30 AM ET during DST and 8:30 AM ET during standard time —
 * but the US equity markets open at 9:30 ET regardless, so we want 13:30 UTC
 * during DST and 14:30 UTC during EST.
 *
 * To handle this cleanly, we determine offset by checking the date.
 */
function getSessionWindows(yesterdayDate, todayDate) {
  // Determine if dates are in DST (US Eastern)
  // US DST: 2nd Sunday March - 1st Sunday November
  function isDST(d) {
    const year = d.getFullYear();
    // 2nd Sunday in March
    const march = new Date(year, 2, 1);
    const dstStart = new Date(year, 2, 14 - march.getDay());
    // 1st Sunday in November
    const nov = new Date(year, 10, 1);
    const dstEnd = new Date(year, 10, 7 - nov.getDay());
    return d >= dstStart && d < dstEnd;
  }

  const yestDST = isDST(yesterdayDate);
  const todayDST = isDST(todayDate);

  // Market open in UTC seconds-from-midnight
  // 9:30 AM ET = 13:30 UTC (DST) or 14:30 UTC (EST)
  const yestRTHOpenOffset = yestDST ? (13 * 3600 + 30 * 60) : (14 * 3600 + 30 * 60);
  const yestRTHCloseOffset = yestDST ? (20 * 3600) : (21 * 3600);
  // 4:00 AM ET PM start = 08:00 UTC (DST) or 09:00 UTC (EST)
  const todayPMStartOffset = todayDST ? (8 * 3600) : (9 * 3600);
  const todayPMEndOffset = todayDST ? (13 * 3600 + 30 * 60) : (14 * 3600 + 30 * 60);

  const yest0 = getMidnightUTC(yesterdayDate);
  const today0 = getMidnightUTC(todayDate);

  return {
    yestOpen: yest0 + yestRTHOpenOffset,
    yestClose: yest0 + yestRTHCloseOffset,
    pmStart: today0 + todayPMStartOffset,
    pmEnd: today0 + todayPMEndOffset,
    yestMidnight: yest0,
    yestDST,
    todayDST
  };
}

// --- TradingView launch & connection ---

async function ensureTradingViewRunning() {
  // 1) CDP already responding? Nothing to do.
  try {
    const versionInfo = execSync('curl -s --max-time 3 http://localhost:9222/json/version', { encoding: 'utf8' });
    if (versionInfo && versionInfo.includes('TradingView')) {
      log('TradingView CDP already running');
      return true;
    }
  } catch (e) {}

  // 2) TV running but WITHOUT the CDP port (e.g. opened manually / no debug flag)?
  //    `open` would just focus the existing instance and never enable the port — so kill it
  //    first and relaunch clean. This is the common failure: TV up, but no 9222.
  try {
    const pids = execSync("pgrep -f 'TradingView.app' || true", { encoding: 'utf8' }).trim();
    if (pids) {
      log('TradingView is running WITHOUT CDP — killing it to relaunch with the debug flag...');
      execSync("kill -9 $(pgrep -f 'TradingView') 2>/dev/null || true");
      await sleep(3000);
    }
  } catch (e) {}

  // 3) Launch a fresh instance WITH the CDP flag (-na forces a new instance).
  log('Launching TradingView with CDP...');
  spawn('open', ['-na', '/Applications/TradingView.app', '--args', '--remote-debugging-port=9222'], { detached: true, stdio: 'ignore' }).unref();

  // 4) Wait up to 120s for CDP to be ready (the app + chart can take a while to warm up).
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      const v = execSync('curl -s --max-time 3 http://localhost:9222/json/version', { encoding: 'utf8' });
      if (v && v.includes('TradingView')) {
        log(`TradingView CDP ready after ${(i + 1) * 2}s`);
        return true;
      }
    } catch (e) {}
  }
  log('ERROR: TradingView CDP did not become available within 120s');
  return false;
}

async function getClient() {
  // CRITICAL: TradingView Desktop exposes several CDP targets (Electron shell, tooltip,
  // draw services, AND the actual chart page). Connecting to the default/first target
  // sometimes lands on the shell where window.TradingViewApi doesn't exist. Explicitly
  // pick the tradingview.com chart page target.
  const client = await CDP({
    port: 9222,
    target: (targets) => {
      const chart = targets.find(t => t.type === 'page' && (t.url || '').includes('tradingview.com'));
      return chart || targets.find(t => t.type === 'page') || targets[0];
    }
  });
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Markup logic ---

async function readWatchlist(client) {
  // TradingView watchlist uses virtual scrolling that aggressively unmounts off-screen items.
  // KEY: TradingView kills the WebSocket if a single Runtime.evaluate call runs too long (>~80s).
  // So we keep each browser-side call short (no awaits inside) and orchestrate scroll+capture
  // from Node side with regular `sleep()` between evaluate calls.

  // Install helpers in the page once
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
    // No scrollable container - just get visible items
    return await run(client, `window.__tvReadWl.getVisible()`);
  }

  const seen = new Set();

  // Helper to push current visible into seen
  const captureVisible = async () => {
    const visible = await run(client, `window.__tvReadWl.getVisible()`);
    if (visible) visible.forEach(s => seen.add(s));
  };

  // 2 passes: top-to-bottom each. Items missed on first pass often render on second.
  // BOTTOM DETECTION: do NOT trust scrollHeight (virtual lists report it too small and
  // grow it as you scroll, causing premature "atBottom"). Instead, detect bottom by
  // scrollTop no longer increasing after a scroll attempt.
  for (let pass = 0; pass < 2; pass++) {
    // Snap to top
    await run(client, `window.__tvReadWl.scroller.scrollTop = 0; 1`);
    await sleep(1000); // virtualizer renders top
    await captureVisible();

    let stuckCount = 0;
    const maxIter = 300;

    for (let i = 0; i < maxIter; i++) {
      await captureVisible(); // pre-scroll capture

      // Scroll one small step (~60px ≈ 1.5 rows) so no row is skipped past rendering,
      // and report whether scrollTop actually advanced.
      const stepInfo = await run(client, `(function(){
        var s = window.__tvReadWl.scroller;
        var before = s.scrollTop;
        s.scrollTop = before + 60;
        return { before: before, after: s.scrollTop };
      })()`);

      await sleep(350); // virtualizer renders new rows
      await captureVisible(); // post-scroll capture

      // If scrollTop didn't move, we've hit the true bottom (content fully rendered).
      const advanced = stepInfo && stepInfo.after > stepInfo.before;
      if (!advanced) {
        stuckCount++;
        if (stuckCount >= 3) break; // confirmed at bottom across 3 tries
      } else {
        stuckCount = 0;
      }
    }

    // Hard slam to the very bottom to catch any final rows, then capture.
    await run(client, `window.__tvReadWl.scroller.scrollTop = 99999999; 1`);
    await sleep(600);
    await captureVisible();
  }

  // Restore scroll to top
  await run(client, `if(window.__tvReadWl && window.__tvReadWl.scroller) window.__tvReadWl.scroller.scrollTop = 0; 1`);

  return Array.from(seen);
}

async function markTicker(client, sym, sessions) {
  const ticker = sym.split(':')[1] || sym;

  // Switch symbol
  await run(client, `window.TradingViewApi.activeChart().setSymbol('${sym}')`);
  await sleep(2500); // longer settle — the label updates fast but the bar series lags

  // Verify symbol switched
  const currentSym = await run(client, `window.TradingViewApi.activeChart().symbol()`);
  if (!currentSym || !currentSym.includes(ticker)) {
    return { ticker, error: `symbol mismatch (got: ${currentSym})` };
  }

  // Remove daily markup lines & gap zones (cyan/orange/yellow lines, purple gap lines, gap rectangles)
  // Preserves green/red/magenta weekly play levels
  await run(client, `(function(){
    var chart=window.TradingViewApi.activeChart();
    var shapes=chart.getAllShapes();
    for(var i=0;i<shapes.length;i++){
      var s=shapes[i];
      try{
        var props=chart.getShapeById(s.id);
        var p=props.getProperties();
        var c=(p.linecolor||p.color||'').toLowerCase();
        var bg=(p.backgroundColor||p.bgcolor||'').toLowerCase();
        if(s.name==='horizontal_line'){
          if(c==='#00bcd4'||c==='#ff6b00'||c==='#ffd600'||c==='#9c27b0'||c==='#ba68c8'){
            chart.removeEntity(s.id);
          }
        } else if(s.name==='rectangle'){
          if(bg==='#ffab40'||bg==='#4fc3f7'||c==='#ffab40'||c==='#4fc3f7'){
            chart.removeEntity(s.id);
          }
        }
      }catch(e){}
    }
  })()`);

  // Switch to 5min for data extraction
  await run(client, `window.TradingViewApi.activeChart().setResolution('5')`);
  await sleep(2800);

  // Read bars AND the series' own symbol in one shot. CRITICAL: validate the bars belong
  // to this ticker — the chart label can update before the data series finishes loading,
  // which would otherwise mark the WRONG symbol's prices (a silent data-integrity bug the
  // coverage check can't catch). symbolInfo() reflects the actually-loaded data series.
  const payload = await run(client, `(function(){
    var chart=window.TradingViewApi.activeChart();
    var s=chart._chartWidget.model().mainSeries();
    var seriesSym='';
    try{ var si=s.symbolInfo(); seriesSym=(si&&(si.full_name||si.name||si.ticker||si.pro_name))||''; }catch(e){}
    var b=s.bars();var data=[];b.each(function(time,bar){data.push({t:bar[0],o:bar[1],h:bar[2],l:bar[3],c:bar[4],v:bar[5]})});
    return { seriesSym: seriesSym, chartSym: chart.symbol(), bars: data.slice(-2000) };
  })()`);

  const bars = payload && payload.bars;
  if (!bars || bars.length === 0) {
    return { ticker, error: 'no bar data' };
  }

  // Validate the loaded data series actually matches the requested ticker.
  // Prefer the series symbol; fall back to the chart label. If neither matches, the bars
  // are stale from a prior symbol — error out so the coverage-check retries this ticker.
  const seriesSym = (payload.seriesSym || '').toUpperCase();
  const chartSym = (payload.chartSym || '').toUpperCase();
  const T = ticker.toUpperCase();
  const seriesOk = seriesSym.includes(T);
  const chartOk = chartSym.includes(T);
  if (seriesSym && !seriesOk) {
    return { ticker, error: `stale bars — series is ${payload.seriesSym}, expected ${ticker}` };
  }
  if (!seriesSym && !chartOk) {
    return { ticker, error: `cannot confirm bars for ${ticker} (chart: ${payload.chartSym})` };
  }

  // Compute PDH/PDL/PDC and PMH/PML
  let pdh = -Infinity, pdl = Infinity, pdc = 0;
  let pmh = -Infinity, pml = Infinity;
  let hasPD = false, hasPM = false;

  for (const bar of bars) {
    if (bar.t >= sessions.yestOpen && bar.t < sessions.yestClose) {
      if (bar.h > pdh) pdh = bar.h;
      if (bar.l < pdl) pdl = bar.l;
      pdc = bar.c;
      hasPD = true;
    }
    if (bar.t >= sessions.pmStart && bar.t < sessions.pmEnd) {
      if (bar.h > pmh) pmh = bar.h;
      if (bar.l < pml) pml = bar.l;
      hasPM = true;
    }
  }

  // Sanity check: if PMH/PML are wildly outside PDC, flag it
  let warning = null;
  if (hasPD && hasPM) {
    const range = pdh - pdl;
    if (Math.abs(pmh - pdc) > range * 5 || Math.abs(pml - pdc) > range * 5) {
      warning = `PM data far from PDC (PDC=${pdc.toFixed(2)}, PMH=${pmh.toFixed(2)}, PML=${pml.toFixed(2)})`;
    }
  }

  // S/R from 5-day swing analysis
  const fiveDaysAgo = sessions.yestMidnight - 4 * 86400;
  const rthBars = bars.filter(b => {
    const dayStart = Math.floor(b.t / 86400) * 86400;
    const timeInDay = b.t - dayStart;
    // Use DST-aware RTH window
    const dstOffset = sessions.yestDST ? 0 : 3600;
    return timeInDay >= (48600 + dstOffset) && timeInDay < (72000 + dstOffset) && b.t >= fiveDaysAgo && b.t < sessions.yestClose;
  });

  const swings = [];
  const lb = 5;
  for (let i = lb; i < rthBars.length - lb; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lb; j++) {
      if (rthBars[i].h <= rthBars[i - j].h || rthBars[i].h <= rthBars[i + j].h) isHigh = false;
      if (rthBars[i].l >= rthBars[i - j].l || rthBars[i].l >= rthBars[i + j].l) isLow = false;
    }
    if (isHigh) swings.push(rthBars[i].h);
    if (isLow) swings.push(rthBars[i].l);
  }

  const sorted = [...new Set(swings)].sort((a, b) => a - b);
  const clusters = [];
  const threshold = (pdh !== -Infinity && pdl !== Infinity) ? (pdh - pdl) * 0.003 : (sorted[0] || 1) * 0.003;

  for (const level of sorted) {
    let merged = false;
    for (const cluster of clusters) {
      if (Math.abs(level - cluster.sum / cluster.count) < threshold * 100) {
        cluster.sum += level;
        cluster.count++;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ sum: level, count: 1 });
  }

  let srLevels = clusters.filter(c => c.count >= 2).map(c => Math.round(c.sum / c.count * 100) / 100).sort((a, b) => b - a);

  const lastPrice = bars[bars.length - 1].c;
  let step;
  if (lastPrice > 500) step = 25;
  else if (lastPrice > 100) step = 5;
  else if (lastPrice > 50) step = 2;
  else if (lastPrice > 20) step = 1;
  else if (lastPrice > 5) step = 0.5;
  else step = 0.25;

  const base = Math.floor(lastPrice / step) * step;
  for (let i = -3; i <= 3; i++) {
    const rn = Math.round((base + i * step) * 100) / 100;
    const tooClose = srLevels.some(sr => Math.abs(sr - rn) < step * 0.3);
    if (!tooClose) srLevels.push(rn);
  }
  srLevels = srLevels.sort((a, b) => b - a).slice(0, 8);

  // Switch to daily for drawing
  await run(client, `window.TradingViewApi.activeChart().setResolution('D')`);
  await sleep(1500);

  const drawLine = async (price, color, text, style) => {
    await run(client, `(function(){var chart=window.TradingViewApi.activeChart();chart.createShape({time:Math.floor(Date.now()/1000),price:${price}},{shape:'horizontal_line',lock:true,disableSelection:false,overrides:{linecolor:'${color}',linestyle:${style},linewidth:${style === 2 ? 1 : 2},showLabel:true,text:'${text}',textcolor:'${color}',fontsize:10,horzLabelsAlign:'right',showPrice:true}})})()`);
  };

  // --- Gap detection ---
  // Only mark a gap if the entire PM range sits cleanly above or below PDC,
  // AND the gap exceeds 0.3% of price (avoids tagging tiny moves as "gaps").
  let gapInfo = null;
  if (hasPD && hasPM) {
    let direction = null, gapTop = null, gapBottom = null;
    if (pml > pdc) {
      // Up gap: entire PM range above yesterday's close
      direction = 'up';
      gapTop = pml;     // bottom of PM range = top of empty gap zone
      gapBottom = pdc;  // PDC = bottom of empty gap zone
    } else if (pmh < pdc) {
      // Down gap: entire PM range below yesterday's close
      direction = 'down';
      gapTop = pdc;
      gapBottom = pmh;
    }

    if (direction) {
      const gapAbsPct = (gapTop - gapBottom) / pdc * 100;
      if (gapAbsPct > 0.3) {
        const gapPctSigned = direction === 'up' ? gapAbsPct : -gapAbsPct;
        const halfFill = (gapTop + gapBottom) / 2;
        let prob;
        if (gapAbsPct < 1) prob = 'HIGH';
        else if (gapAbsPct < 3) prob = 'MED';
        else prob = 'LOW';
        gapInfo = { direction, gapTop, gapBottom, halfFill, gapPctSigned, prob };
      }
    }
  }

  // --- Draw daily/PM/SR lines ---
  // MARKUP_NO_PD skips the cyan PDH/PDL/PDC lines (and the PDC-based gap zone).
  const NO_PD = !!process.env.MARKUP_NO_PD;
  if (hasPD && !NO_PD) {
    await drawLine(pdh, '#00BCD4', 'PDH ' + pdh.toFixed(2), 0);
    await drawLine(pdl, '#00BCD4', 'PDL ' + pdl.toFixed(2), 0);
    // Skip the dashed cyan PDC if there's a gap — purple gap-fill line at PDC takes its place
    if (!gapInfo) {
      await drawLine(pdc, '#00BCD4', 'PDC ' + pdc.toFixed(2), 2);
    }
  }
  if (hasPM) {
    await drawLine(pmh, '#FF6B00', 'PMH ' + pmh.toFixed(2), 2);
    await drawLine(pml, '#FF6B00', 'PML ' + pml.toFixed(2), 2);
  }
  for (const level of srLevels) {
    await drawLine(level, '#FFD600', 'S/R ' + level.toFixed(2), 2);
  }

  // --- Draw gap zone if present ---
  if (gapInfo && !NO_PD) {
    const bgColor = gapInfo.direction === 'up' ? '#FFAB40' : '#4FC3F7';
    const sign = gapInfo.gapPctSigned > 0 ? '+' : '';
    const pctStr = sign + gapInfo.gapPctSigned.toFixed(2) + '%';

    // Shaded rectangle covering the empty gap zone
    await run(client, `(function(){
      var chart=window.TradingViewApi.activeChart();
      var now=Math.floor(Date.now()/1000);
      chart.createMultipointShape(
        [{time: now - 86400*4, price: ${gapInfo.gapTop}},
         {time: now + 86400*2, price: ${gapInfo.gapBottom}}],
        {shape:'rectangle',lock:true,disableSelection:false,
         overrides:{backgroundColor:'${bgColor}',color:'${bgColor}',linecolor:'${bgColor}',transparency:80,linewidth:1,showLabel:false}});
    })()`);

    // Bold purple line at PDC labeled with gap stats — replaces the cyan PDC line
    await run(client, `(function(){
      var chart=window.TradingViewApi.activeChart();
      chart.createShape({time:Math.floor(Date.now()/1000),price:${pdc}},
        {shape:'horizontal_line',lock:true,disableSelection:false,
         overrides:{linecolor:'#9C27B0',linestyle:0,linewidth:3,
                    showLabel:true,text:'GAP FILL ${pdc.toFixed(2)} (${pctStr}, ${gapInfo.prob})',
                    textcolor:'#9C27B0',fontsize:11,horzLabelsAlign:'right',showPrice:true,bold:true}});
    })()`);

    // Dashed half-gap line as a partial-fill target
    await drawLine(gapInfo.halfFill, '#BA68C8', '1/2 GAP ' + gapInfo.halfFill.toFixed(2), 1);
  }

  return {
    ticker,
    pdh: hasPD ? pdh : null,
    pdl: hasPD ? pdl : null,
    pdc: hasPD ? pdc : null,
    pmh: hasPM ? pmh : null,
    pml: hasPM ? pml : null,
    srCount: srLevels.length,
    gap: gapInfo,
    warning
  };
}

// --- Main ---

(async () => {
  const startTime = Date.now();
  log('=== Morning markup routine starting ===');

  // Determine dates
  const now = new Date();
  const yesterday = getPreviousTradingDay(now);
  const sessions = getSessionWindows(yesterday, now);

  log(`Today: ${formatDateLocal(now)} (DST: ${sessions.todayDST})`);
  log(`Yesterday (last trading day): ${formatDateLocal(yesterday)} (DST: ${sessions.yestDST})`);
  log(`Yesterday RTH: ${new Date(sessions.yestOpen * 1000).toISOString()} -> ${new Date(sessions.yestClose * 1000).toISOString()}`);
  log(`Today PM:      ${new Date(sessions.pmStart * 1000).toISOString()} -> ${new Date(sessions.pmEnd * 1000).toISOString()}`);

  // Skip if today is a weekend (shouldn't happen via cron 1-5, but safety)
  if (now.getDay() === 0 || now.getDay() === 6) {
    log('Today is a weekend, skipping');
    process.exit(0);
  }

  // Ensure TradingView is running
  const tvRunning = await ensureTradingViewRunning();
  if (!tvRunning) {
    log('FATAL: Could not start TradingView');
    process.exit(1);
  }

  // Connect to CDP
  let client;
  try {
    client = await getClient();
  } catch (e) {
    log(`FATAL: Could not connect to CDP: ${e.message}`);
    process.exit(1);
  }

  // Wait for TradingViewApi
  const apiReady = await waitForTradingViewApi(client);
  if (!apiReady) {
    log('FATAL: TradingViewApi did not become ready');
    await client.close();
    process.exit(1);
  }
  log('TradingViewApi is ready');

  // Optional targeted override: when MARKUP_SYMBOLS is set (comma-separated
  // EXCHANGE:TICKER list), skip the watchlist read entirely and mark only those.
  // The cron never sets it, so default behavior is unchanged. Useful for marking
  // tickers that aren't in the watchlist yet (e.g. fresh weekly plays).
  let symbols;
  const SYMBOL_OVERRIDE = process.env.MARKUP_SYMBOLS;
  if (SYMBOL_OVERRIDE) {
    symbols = SYMBOL_OVERRIDE.split(',').map(s => s.trim()).filter(Boolean);
    log(`MARKUP_SYMBOLS override active: marking only ${symbols.join(', ')}`);
  } else {

  // Read watchlist until the count stabilizes (UNION of repeated reads).
  // TradingView's virtual scroll drops off-screen rows between reads, so a single
  // pass is unreliable — different passes catch different chunks. We union several
  // passes and stop once two consecutive reads add nothing new. Reconnects on error.
  async function readWatchlistUnion() {
    const acc = new Set();
    let stableRounds = 0;
    for (let round = 0; round < 6; round++) {
      let batch = null;
      try {
        batch = await readWatchlist(client);
      } catch (e) {
        log(`Watchlist read error (${e.message}) — reconnecting...`);
        try { await client.close(); } catch (ex) {}
        await sleep(2000);
        try { client = await getClient(); await waitForTradingViewApi(client); }
        catch (re) { log(`Reconnect failed: ${re.message}`); }
        continue;
      }
      const before = acc.size;
      if (batch) batch.forEach(s => acc.add(s));
      const added = acc.size - before;
      log(`Watchlist read round ${round + 1}: +${added} new (total ${acc.size})`);
      if (added === 0) {
        stableRounds++;
        if (stableRounds >= 2) break; // two consecutive reads added nothing = stable
      } else {
        stableRounds = 0;
      }
      await sleep(800);
    }
    return Array.from(acc);
  }

  let scrollRead = await readWatchlistUnion();
  if (!scrollRead) scrollRead = [];

  // PERSISTENT BASELINE: TradingView's virtual-scroll DOM read is unreliable — different
  // runs stall at different points and miss different chunks. To guarantee coverage we keep
  // a baseline file of every full-path symbol ever seen, and mark the UNION of (today's
  // scroll read) ∪ (baseline). New tickers get added to the baseline the first time they're
  // scrolled; the watchlist is stable enough day-to-day that this guarantees full coverage
  // even when a single scroll comes up short. Removed tickers linger (harmlessly marked)
  // and are logged so they can be pruned manually.
  const BASELINE_FILE = path.join(__dirname, 'watchlist-baseline.json');
  let baseline = [];
  try {
    if (fs.existsSync(BASELINE_FILE)) baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch (e) { log(`Baseline read error (ignored): ${e.message}`); }

  // Only baseline full-path symbols (e.g. "NASDAQ:NVDA") — bare tickers are ambiguous.
  const scrollFull = scrollRead.filter(s => s.includes(':'));
  const scrollFullSet = new Set(scrollFull);
  const baselineSet = new Set(baseline.filter(s => s.includes(':')));

  // Effective watchlist = union of today's scroll read + baseline
  const unionFull = new Set([...scrollFullSet, ...baselineSet]);
  // Keep bare tickers from today's read only if no full-path counterpart exists in the union
  const unionTickers = new Set([...unionFull].map(s => s.split(':')[1]));
  const bareExtras = scrollRead.filter(s => !s.includes(':') && !unionTickers.has(s));
  let watchlist = [...unionFull, ...bareExtras];

  if (watchlist.length === 0) {
    log('FATAL: Watchlist is empty (scroll + baseline both empty)');
    await client.close();
    process.exit(1);
  }

  // Report what the scroll missed vs baseline (these are covered by baseline, not lost)
  const missedByScroll = [...baselineSet].filter(s => !scrollFullSet.has(s));
  const newThisRun = [...scrollFullSet].filter(s => !baselineSet.has(s));
  log(`Scroll read: ${scrollRead.length} raw | Baseline: ${baselineSet.size} | Effective union: ${watchlist.length}`);
  if (missedByScroll.length) log(`Scroll MISSED (covered by baseline): ${missedByScroll.join(', ')}`);
  if (newThisRun.length) log(`NEW since last baseline: ${newThisRun.join(', ')}`);

  // Persist updated baseline = union of everything ever seen (full-path only)
  try {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify([...unionFull].sort(), null, 2));
  } catch (e) { log(`Baseline write error (ignored): ${e.message}`); }

  log(`Symbols: ${watchlist.join(', ')}`);

  // Filter out crypto/non-equity that can't have RTH/PM windows
  // Dedup: the new readWatchlist returns both "NASDAQ:NVDA" (full) and "NVDA" (plain) for each row.
  // Prefer the full format. If only plain exists, keep it (TV can resolve bare tickers).
  const fullSyms = new Set(watchlist.filter(s => s.includes(':')));
  const fullTickers = new Set();
  for (const f of fullSyms) {
    const parts = f.split(':');
    if (parts.length === 2) fullTickers.add(parts[1]);
  }
  // Keep full symbols + any plain symbol that has no full counterpart
  const deduped = [
    ...fullSyms,
    ...watchlist.filter(s => !s.includes(':') && !fullTickers.has(s))
  ];
  symbols = deduped.filter(s => !s.startsWith('BINANCE:') && !s.startsWith('COINBASE:'));
  if (symbols.length < watchlist.length) {
    log(`Filtered out ${watchlist.length - symbols.length} crypto/non-equity symbols`);
  }

  // Verify SPY/QQQ/IWM are present (canonical sanity check)
  const required = ['SPY', 'QQQ', 'IWM'];
  for (const r of required) {
    const found = symbols.some(s => s.endsWith(':' + r));
    log(`Sanity check: ${r} ${found ? 'PRESENT' : 'MISSING'}`);
  }

  } // end watchlist-read branch (else of MARKUP_SYMBOLS override)

  // Process each ticker
  const results = [];
  const warnings = [];
  let successCount = 0;

  for (let idx = 0; idx < symbols.length; idx++) {
    const sym = symbols[idx];
    try {
      const result = await markTicker(client, sym, sessions);
      results.push(result);
      if (result.error) {
        log(`${result.ticker}: ERROR - ${result.error}`);
      } else {
        successCount++;
        const pdh = result.pdh ? result.pdh.toFixed(2) : 'N/A';
        const pdl = result.pdl ? result.pdl.toFixed(2) : 'N/A';
        const pdc = result.pdc ? result.pdc.toFixed(2) : 'N/A';
        const pmh = result.pmh ? result.pmh.toFixed(2) : 'N/A';
        const pml = result.pml ? result.pml.toFixed(2) : 'N/A';
        const gapTag = result.gap ? ` GAP=${result.gap.direction.toUpperCase()} ${result.gap.gapPctSigned > 0 ? '+' : ''}${result.gap.gapPctSigned.toFixed(2)}% (${result.gap.prob})` : '';
        log(`${result.ticker}: PDH=${pdh} PDL=${pdl} PDC=${pdc} PMH=${pmh} PML=${pml} SR=${result.srCount}${gapTag}${result.warning ? ' [WARN: ' + result.warning + ']' : ''}`);
        if (result.warning) warnings.push(`${result.ticker}: ${result.warning}`);
      }
    } catch (e) {
      log(`${sym}: EXCEPTION - ${e.message}`);
      // Reconnect on WebSocket drop or collected-promise (symbol-switch race)
      if (e.message.includes('WebSocket') || e.message.includes('not open') || e.message.includes('collected')) {
        try { await client.close(); } catch (ex) {}
        await sleep(2000);
        try {
          client = await getClient();
          await waitForTradingViewApi(client);
          idx--; // retry this symbol
        } catch (re) {
          log(`Reconnect failed: ${re.message}`);
          break;
        }
      }
    }
  }

  // Coverage check: retry any symbols that never got a clean mark (errored, dropped,
  // or skipped). This closes the gap so the run self-heals instead of needing manual backfill.
  const markedTickers = new Set(results.filter(r => r && !r.error).map(r => r.ticker));
  const missing = symbols.filter(s => !markedTickers.has(s.split(':')[1] || s));
  if (missing.length) {
    log(`Coverage check: ${missing.length} unmarked — retrying: ${missing.map(s => s.split(':')[1] || s).join(', ')}`);
    for (let idx = 0; idx < missing.length; idx++) {
      const sym = missing[idx];
      try {
        const result = await markTicker(client, sym, sessions);
        results.push(result);
        if (result.error) {
          log(`RETRY ${result.ticker}: ERROR - ${result.error}`);
        } else {
          successCount++;
          markedTickers.add(result.ticker);
          const pdh = result.pdh ? result.pdh.toFixed(2) : 'N/A';
          const pmh = result.pmh ? result.pmh.toFixed(2) : 'N/A';
          log(`RETRY ${result.ticker}: PDH=${pdh} PMH=${pmh} SR=${result.srCount} OK`);
        }
      } catch (e) {
        log(`RETRY ${sym}: EXCEPTION - ${e.message}`);
        if (e.message.includes('WebSocket') || e.message.includes('not open') || e.message.includes('collected')) {
          try { await client.close(); } catch (ex) {}
          await sleep(2000);
          try { client = await getClient(); await waitForTradingViewApi(client); idx--; }
          catch (re) { log(`Reconnect failed: ${re.message}`); break; }
        }
      }
    }
    const stillMissing = symbols.filter(s => !markedTickers.has(s.split(':')[1] || s));
    if (stillMissing.length) {
      log(`STILL UNMARKED after retry: ${stillMissing.map(s => s.split(':')[1] || s).join(', ')}`);
    } else {
      log('Coverage check: all symbols marked after retry ✓');
    }
  } else {
    log('Coverage check: full coverage on first pass ✓');
  }

  await client.close();

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  log(`=== DONE: ${successCount}/${symbols.length} tickers marked in ${elapsedSec}s ===`);
  if (warnings.length) {
    log(`Warnings (${warnings.length}):`);
    for (const w of warnings) log(`  - ${w}`);
  }

  logStream.end();
  process.exit(0);
})().catch(e => {
  log(`FATAL UNCAUGHT: ${e.message}\n${e.stack}`);
  process.exit(1);
});
