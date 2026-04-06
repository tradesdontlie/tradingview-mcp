import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const evAsync = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FIND_MONACO = `(function findMonacoEditor() {
  var container = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (!container) return null;
  var el = container;
  var fiberKey;
  for (var i = 0; i < 20; i++) {
    if (!el) break;
    fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (fiberKey) break;
    el = el.parentElement;
  }
  if (!fiberKey) return null;
  var current = el[fiberKey];
  for (var d = 0; d < 15; d++) {
    if (!current) break;
    if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
      var env = current.memoizedProps.value.monacoEnv;
      if (env.editor && typeof env.editor.getEditors === 'function') {
        var editors = env.editor.getEditors();
        if (editors.length > 0) return { editor: editors[0], env: env };
      }
    }
    current = current.return;
  }
  return null;
})()`;

// Step 1: Switch to MNQ1! 15m
await ev(`(function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value();
  chart.setSymbol('MNQ1!', {});
  chart.setResolution('15', {});
})()`);
await sleep(2500);
console.error('Chart: MNQ1! 15m');

// Step 2: Fetch KOZ Algo source from pine-facade
const scriptData = await evAsync(`
  fetch('https://pine-facade.tradingview.com/pine-facade/get/USER;ba0405dbf0c749a49196ab77cd323045/3.0', { credentials: 'include' })
    .then(r => r.json())
    .then(d => ({ source: d.source || '', name: d.scriptName || 'KOZ Algo' }))
    .catch(e => ({ error: e.message }))
`);
if (!scriptData?.source) { console.error('No source'); await client.close(); process.exit(1); }
console.error(`Source: ${scriptData.source.split('\n').length} lines`);

// Step 3: Ensure Pine Editor open
await ev(`(function() {
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb) {
    if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
    else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
  }
  var btn = document.querySelector('[data-name="pine-dialog-button"]') || document.querySelector('[aria-label="Pine"]');
  if (btn) btn.click();
})()`);

// Wait for Monaco
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const ready = await ev(`(function() { return ${FIND_MONACO} !== null; })()`);
  if (ready) { console.error('Monaco ready'); break; }
}

// Step 4: Inject source
const src = JSON.stringify(scriptData.source);
await ev(`(function() {
  var m = ${FIND_MONACO};
  if (m) { m.editor.setValue(${src}); m.editor.focus(); }
})()`);
await sleep(800);
console.error('Source injected, sending Ctrl+Enter');

// Step 5: Focus the Monaco editor textarea and send Ctrl+Enter
await ev(`(function() {
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) ta.focus();
})()`);
await sleep(300);

// Ctrl+Enter = add to chart
await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
console.error('Ctrl+Enter sent');

await sleep(6000); // Wait for compile + add

// Step 6: Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', JSON.stringify(studies));

const kozStudy = studies.find(s => s.name && s.name.toLowerCase().includes('koz'));
if (!kozStudy) {
  console.error('KOZ Algo not found in studies after compile. Trying "Add to chart" button...');
  const addResult = await ev(`(function() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var text = (btns[i].textContent || '').trim();
      if (/save and add to chart/i.test(text)) { btns[i].click(); return 'Save and add to chart'; }
      if (/^add to chart$/i.test(text)) { btns[i].click(); return 'Add to chart'; }
      if (/update on chart/i.test(text)) { btns[i].click(); return 'Update on chart'; }
    }
    return null;
  })()`);
  console.error('Button click result:', addResult);
  await sleep(4000);
}

// Step 7: Get strategy results
const results = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var stratData = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.reportData && !s.ordersData && !s.performance) continue;
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';

      // Get report data
      var rd = null;
      try {
        rd = s.reportData;
        if (typeof rd === 'function') rd = rd();
        if (rd && typeof rd.value === 'function') rd = rd.value();
      } catch(e) {}

      // Get orders/trades
      var orders = null;
      try {
        orders = s.ordersData;
        if (typeof orders === 'function') orders = orders();
        if (orders && typeof orders.value === 'function') orders = orders.value();
      } catch(e) {}

      if (rd || orders) {
        stratData = { idx: i, name, reportData: rd, orderCount: Array.isArray(orders) ? orders.length : null };
        break;
      }
    }
    return { sources: sources.length, stratData };
  } catch(e) { return { error: e.message }; }
})()`);

if (results.stratData?.reportData) {
  const rd = results.stratData.reportData;
  console.log('\n=== KOZ Algo SMC/ICT Strategy — Trade Statistics ===');
  console.log('Study name:', results.stratData.name || 'unnamed');
  console.log('Report data keys:', Object.keys(rd));
  console.log(JSON.stringify(rd, null, 2));
} else {
  console.log(JSON.stringify(results, null, 2));
}

// Also try to get trades
const trades = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var orders = null;
      try {
        orders = s.ordersData;
        if (typeof orders === 'function') orders = orders();
        if (orders && typeof orders.value === 'function') orders = orders.value();
      } catch(e) {}
      if (Array.isArray(orders) && orders.length > 0) {
        var result = orders.slice(0, 20).map(function(o) {
          if (typeof o !== 'object' || !o) return null;
          var t = {};
          Object.keys(o).forEach(function(k) {
            var v = o[k];
            if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') t[k] = v;
          });
          return t;
        }).filter(Boolean);
        return { count: orders.length, trades: result };
      }
    }
    return { count: 0, trades: [] };
  } catch(e) { return { error: e.message }; }
})()`);

if (trades.count > 0) {
  console.log('\n=== Recent Trades (last 20) ===');
  console.log('Total trades:', trades.count);
  trades.trades.forEach((t, i) => console.log(`Trade ${i+1}:`, JSON.stringify(t)));
}

await client.close();
