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

// Step 1: Cancel the "Save Script" dialog
const cancelled = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button'));
  for (var b of btns) {
    if ((b.textContent||'').trim() === 'Cancel' && b.offsetParent) { b.click(); return true; }
  }
  return false;
})()`);
console.error('Cancelled save dialog:', cancelled);
await sleep(800);

// Step 2: Try opening the SAVED KOZ Algo script (already saved as USER;ba04...)
// Use the pine-facade open mechanism via the correct approach
// The button at position (964, 62) = button index 2 in the Pine dialog
// Let's try using mouse click at that coordinate
const { data: ss1 } = await Page.captureScreenshot({ format: 'jpeg', quality: 50 });
fs.writeFileSync('/tmp/tv_before_click.jpg', Buffer.from(ss1, 'base64'));

// Use the "Open" mechanism - load the existing saved script
const openResult = await evAsync(`
  (function() {
    return fetch('https://pine-facade.tradingview.com/pine-facade/get/USER;ba0405dbf0c749a49196ab77cd323045/3.0', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        // Try to use TradingView internal API to open the script
        var tv = window.TradingView;
        if (!tv) return { error: 'No TradingView global' };

        // Try bottomWidgetBar
        var bwb = tv.bottomWidgetBar;
        if (bwb && typeof bwb.getScriptEditorWidget === 'function') {
          var editor = bwb.getScriptEditorWidget();
          if (editor && typeof editor.loadScript === 'function') {
            editor.loadScript('USER;ba0405dbf0c749a49196ab77cd323045', d.source);
            return { ok: true, via: 'loadScript' };
          }
        }
        return { source_length: (d.source || '').length };
      });
  })()
`);
console.error('Open result:', JSON.stringify(openResult));

// Step 3: Try clicking button at position (964, 62) in the pine editor
// That's the unknown button before the saveButton
await Input.dispatchMouseEvent({
  type: 'mousePressed', x: 964, y: 62, button: 'left', clickCount: 1
});
await Input.dispatchMouseEvent({
  type: 'mouseReleased', x: 964, y: 62, button: 'left', clickCount: 1
});
console.error('Clicked at (964, 62)');
await sleep(1000);

const { data: ss2 } = await Page.captureScreenshot({ format: 'jpeg', quality: 50 });
fs.writeFileSync('/tmp/tv_after_964.jpg', Buffer.from(ss2, 'base64'));

// Check what happened
const dialogs = await ev(`(function() {
  var visible = Array.from(document.querySelectorAll('[role="dialog"], [class*="dialog"]')).filter(d => d.offsetParent);
  return visible.map(d => ({ name: d.getAttribute('data-name'), text: (d.textContent||'').trim().slice(0,80) }));
})()`);
console.error('Dialogs after click:', dialogs);

// Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

await client.close();
