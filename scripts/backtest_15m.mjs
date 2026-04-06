import CDP from 'chrome-remote-interface';
import fs from 'fs';

const src = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine', 'utf8');

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FIND_MONACO = `(function() {
  var container = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (!container) return null;
  var el = container; var fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
  if (!fk) return null;
  var cur = el[fk];
  for (var d = 0; d < 15; d++) {
    if (!cur) break;
    if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv) {
      var env = cur.memoizedProps.value.monacoEnv;
      if (env.editor && typeof env.editor.getEditors === 'function') { var eds = env.editor.getEditors(); if (eds.length > 0) return { editor: eds[0], env }; }
    }
    cur = cur.return;
  }
  return null;
})()`;

// 1. Switch to MNQ1! 15m
await ev(`(function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value();
  chart.setSymbol('MNQ1!', {}); chart.setResolution('15', {});
})()`);
await sleep(3000);
console.error('Chart: MNQ1! 15m');

// 2. Inject strategy into Monaco
for (let i = 0; i < 40; i++) {
  await sleep(200);
  if (await ev(`(function() { return ${FIND_MONACO} !== null; })()`)) { console.error('Monaco ready'); break; }
}
await ev(`(function() {
  var m = ${FIND_MONACO};
  if (m) { m.editor.setValue(${JSON.stringify(src)}); m.editor.focus(); }
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) { ta.click(); ta.focus(); }
})()`);
await sleep(400);

// 3. Add to chart
await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 4, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(100);
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(2000);

// Dismiss any save dialog
const hasDlg = await ev(`Array.from(document.querySelectorAll('button')).some(b => b.offsetParent && (b.textContent||'').trim() === 'No')`);
if (hasDlg) {
  await ev(`(function() { Array.from(document.querySelectorAll('button')).find(b => b.offsetParent && (b.textContent||'').trim() === 'No').click(); })()`);
  await sleep(1500);
}

const studies = await ev(`(function() { try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => s.name); } catch(e) { return []; } })()`);
console.error('Studies:', studies);
await sleep(2000);

// 4. Load more historical bars by scrolling left
const chartCenter = await ev(`(function() {
  var el = document.querySelector('.chart-container, [class*="chart-container"]') || document.body;
  var r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.5) };
})()`);

let bars = await ev(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars().size()`);
console.error('Initial bars:', bars);

for (let batch = 0; batch < 8; batch++) {
  for (let i = 0; i < 20; i++) {
    await Input.dispatchMouseEvent({ type: 'mouseWheel', x: chartCenter.x, y: chartCenter.y, deltaX: -600, deltaY: 0 });
    await sleep(40);
  }
  await sleep(2000);
  bars = await ev(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars().size()`);
  console.error(`Batch ${batch+1}: ${bars} bars`);
  if (bars >= 5000) break;
}
console.error('History loaded:', bars, 'bars');

// 5. Wait for strategy to compute
await sleep(6000);

// 6. Get stats
const perf = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var strat = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (name.toLowerCase().includes('orb') || name.toLowerCase().includes('koz algo')) { strat = { s, name }; break; }
    }
    if (!strat) return { error: 'Not found', sources: sources.length };

    var rd = strat.s._reportData;
    if (rd && typeof rd.value === 'function') rd = rd.value();
    if (!rd) return { error: 'No reportData' };

    function flat(p) {
      if (!p) return null;
      var r = {};
      Object.keys(p).forEach(function(k) {
        var v = p[k];
        if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') r[k] = Math.round(v * 100) / 100;
      });
      return r;
    }

    var trades = [];
    if (Array.isArray(rd.trades)) {
      trades = rd.trades.slice(-15).map(function(t) {
        if (!t || typeof t !== 'object') return null;
        var tr = {};
        Object.keys(t).forEach(function(k) {
          var v = t[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') tr[k] = v;
        });
        return tr;
      }).filter(Boolean);
    }

    return {
      name: strat.name,
      currency: rd.currency,
      totalTrades: rd.trades ? rd.trades.length : 0,
      all: flat(rd.performance && rd.performance.all),
      long: flat(rd.performance && rd.performance.long),
      short: flat(rd.performance && rd.performance.short),
      maxDD: rd.performance ? rd.performance.maxStrategyDrawDown : 0,
      buyHold: rd.performance ? rd.performance.buyHoldReturn : 0,
      recentTrades: trades
    };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(perf, null, 2));

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
fs.writeFileSync('/tmp/tv_backtest_15m.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
