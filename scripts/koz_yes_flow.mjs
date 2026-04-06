import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
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

// Fetch source
const scriptData = await evAsync(`
  fetch('https://pine-facade.tradingview.com/pine-facade/get/USER;ba0405dbf0c749a49196ab77cd323045/3.0', { credentials: 'include' })
    .then(r => r.json())
    .then(d => ({ source: d.source || '' }))
`);
console.error('Source lines:', scriptData.source.split('\n').length);

// Inject source into Monaco
const src = JSON.stringify(scriptData.source);
const injected = await ev(`(function() {
  var m = ${FIND_MONACO};
  if (!m) return false;
  m.editor.setValue(${src});
  m.editor.focus();
  // Focus the textarea so keyboard events work
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) ta.focus();
  return true;
})()`);
console.error('Injected:', injected);
await sleep(500);

// Also ensure Monaco textarea is physically focused
await ev(`(function() {
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) { ta.click(); ta.focus(); }
})()`);
await sleep(300);

// Send Ctrl+Enter to add to chart
await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(100);
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
console.error('Ctrl+Enter sent');
await sleep(1500);

// Check if confirmation dialog appeared, click "Yes" this time
const dialog = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
  var hasYes = btns.some(b => (b.textContent||'').trim() === 'Yes');
  var hasNo = btns.some(b => (b.textContent||'').trim() === 'No');
  return { hasYes, hasNo };
})()`);
console.error('Dialog:', dialog);

if (dialog.hasYes) {
  // Click Yes = save and add to chart
  await ev(`(function() {
    var btns = Array.from(document.querySelectorAll('button'));
    for (var b of btns) { if ((b.textContent||'').trim() === 'Yes' && b.offsetParent) { b.click(); return; } }
  })()`);
  console.error('Clicked Yes');
  await sleep(2000);

  // Check if "Save Script" name dialog appeared
  const saveDialog = await ev(`(function() {
    var inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent);
    var hasSave = Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim() === 'Save' && b.offsetParent);
    return { inputs: inputs.length, hasSave };
  })()`);
  console.error('Save dialog:', saveDialog);

  if (saveDialog.hasSave) {
    // Type a name in the input and click Save
    await ev(`(function() {
      var inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent);
      if (inputs.length > 0) {
        inputs[0].focus();
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inputs[0], 'KOZ Algo SMC/ICT Strategy');
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await sleep(300);

    // Click Save button
    await ev(`(function() {
      var btns = Array.from(document.querySelectorAll('button'));
      for (var b of btns) { if ((b.textContent||'').trim() === 'Save' && b.offsetParent) { b.click(); return; } }
    })()`);
    console.error('Clicked Save with name');
    await sleep(4000);
  }
} else {
  // No confirmation dialog — might have been added directly
  console.error('No confirmation dialog appeared');
  await sleep(3000);
}

// Final check
const { data: ss } = await Page.captureScreenshot({ format: 'jpeg', quality: 50 });
fs.writeFileSync('/tmp/tv_final.jpg', Buffer.from(ss, 'base64'));

const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

// Check strategy tester
const stratData = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var info = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      var hasReport = !!(s.reportData);
      var hasOrders = !!(s.ordersData);

      var reportVal = null, orderCount = 0;
      try {
        var r = s.reportData; if (typeof r === 'function') r = r();
        if (r && typeof r.value === 'function') r = r.value();
        if (r && typeof r === 'object') {
          var keys = Object.keys(r);
          reportVal = {};
          for (var k = 0; k < keys.length; k++) {
            var v = r[keys[k]];
            if (v !== null && v !== undefined && typeof v !== 'function') reportVal[keys[k]] = v;
          }
          if (Object.keys(reportVal).length === 0) reportVal = null;
        }
      } catch(e) {}
      try {
        var o = s.ordersData; if (typeof o === 'function') o = o();
        if (o && typeof o.value === 'function') o = o.value();
        orderCount = Array.isArray(o) ? o.length : 0;
      } catch(e) {}

      if (reportVal || orderCount > 0) {
        info.push({ idx: i, name, reportVal, orderCount });
      }
    }
    return { sources: sources.length, stratData: info };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(stratData, null, 2));

await client.close();
