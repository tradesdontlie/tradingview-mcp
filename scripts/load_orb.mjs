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
  var el = container; var fiberKey;
  for (var i = 0; i < 20; i++) {
    if (!el) break;
    fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (fiberKey) break; el = el.parentElement;
  }
  if (!fiberKey) return null;
  var cur = el[fiberKey];
  for (var d = 0; d < 15; d++) {
    if (!cur) break;
    if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv) {
      var env = cur.memoizedProps.value.monacoEnv;
      if (env.editor && typeof env.editor.getEditors === 'function') {
        var eds = env.editor.getEditors();
        if (eds.length > 0) return { editor: eds[0], env };
      }
    }
    cur = cur.return;
  }
  return null;
})()`;

// Ensure we're on MNQ1! 5m
await ev(`(function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value();
  chart.setSymbol('MNQ1!', {}); chart.setResolution('5', {});
})()`);
await sleep(2000);

// Open Pine editor
await ev(`(function() {
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb) { if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab(); else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor'); }
  var btn = document.querySelector('[data-name="pine-dialog-button"]');
  if (btn) btn.click();
})()`);

for (let i = 0; i < 40; i++) {
  await sleep(200);
  const ready = await ev(`(function() { return ${FIND_MONACO} !== null; })()`);
  if (ready) { console.error('Monaco ready'); break; }
}

// Inject strategy source
await ev(`(function() {
  var m = ${FIND_MONACO};
  if (m) { m.editor.setValue(${JSON.stringify(src)}); m.editor.focus(); }
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) { ta.click(); ta.focus(); }
})()`);
await sleep(500);
console.error('Source injected, lines:', src.split('\n').length);

// Compile + add to chart with Cmd+Enter
await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 4, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(100);
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
console.error('Cmd+Enter sent');
await sleep(3000);

// Handle any dialog (Yes/No/Save)
const dlg = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
  return btns.filter(b => ['Yes','No','Save','Cancel'].includes((b.textContent||'').trim())).map(b => (b.textContent||'').trim());
})()`);
console.error('Dialogs:', dlg);

if (dlg.includes('No')) {
  await ev(`(function() {
    var btns = Array.from(document.querySelectorAll('button'));
    for (var b of btns) { if ((b.textContent||'').trim() === 'No' && b.offsetParent) { b.click(); return; } }
  })()`);
  console.error('Dismissed save dialog');
  await sleep(2000);
}

// Check if added
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

// Wait for strategy to compute, then get results
await sleep(8000);

const perf = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (!name.toLowerCase().includes('orb') && !name.toLowerCase().includes('mnq')) continue;

      var rd = s._reportData;
      if (rd && typeof rd.value === 'function') rd = rd.value();
      if (!rd) return { error: 'no reportData', name };

      function flat(p) {
        if (!p) return {};
        var r = {};
        Object.keys(p).forEach(function(k) {
          var v = p[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') r[k] = Math.round(v * 100) / 100;
        });
        return r;
      }

      var trades = [];
      if (Array.isArray(rd.trades)) {
        trades = rd.trades.slice(-20).map(function(t) {
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
        name, currency: rd.currency,
        totalTrades: rd.trades ? rd.trades.length : 0,
        all: flat(rd.performance && rd.performance.all),
        long: flat(rd.performance && rd.performance.long),
        short: flat(rd.performance && rd.performance.short),
        maxDD: rd.performance ? rd.performance.maxStrategyDrawDown : null,
        buyHold: rd.performance ? rd.performance.buyHoldReturn : null,
        recentTrades: trades
      };
    }
    return { error: 'strategy not found in sources' };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(perf, null, 2));

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
fs.writeFileSync('/tmp/tv_orb.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
