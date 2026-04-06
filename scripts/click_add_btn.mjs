import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
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

// Focus Monaco textarea directly
const focused = await ev(`(function() {
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) { ta.click(); ta.focus(); return true; }
  return false;
})()`);
console.error('Monaco focused:', focused);
await sleep(500);

// Try the saveButton (class saveButton-*) which in unsaved state = "Add to chart"
const saveBtnResult = await ev(`(function() {
  var dialog = document.querySelector('[data-name="pine-dialog"]');
  if (!dialog) return 'no dialog';
  var btns = Array.from(dialog.querySelectorAll('button'));
  var info = btns.map(function(b, i) {
    var r = b.getBoundingClientRect();
    return {
      i: i,
      text: (b.textContent || '').trim(),
      cls: (b.className || '').slice(0, 40),
      visible: b.offsetParent !== null,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  });
  return info;
})()`);
console.error('Pine dialog buttons with positions:');
saveBtnResult.forEach(b => console.error(JSON.stringify(b)));

// The "Add to chart" button in TradingView Pine editor is the green run/play button
// Try clicking the button with saveButton class (it's the primary action button)
const clickResult = await ev(`(function() {
  var dialog = document.querySelector('[data-name="pine-dialog"]');
  if (!dialog) return 'no dialog';
  var btns = Array.from(dialog.querySelectorAll('button'));
  // Button with saveButton in class is the primary CTA
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].className || '').includes('saveButton') && btns[i].offsetParent !== null) {
      btns[i].click();
      return { clicked: i, cls: btns[i].className.slice(0, 50) };
    }
  }
  return { clicked: null };
})()`);
console.error('Clicked saveButton:', clickResult);
await sleep(2000);

// Check for confirmation dialogs
const dialogs = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button'));
  return btns.filter(b => b.offsetParent !== null).map(b => ({
    text: (b.textContent || '').trim(),
    cls: (b.className || '').slice(0, 30)
  })).filter(b => b.text && ['Yes','No','OK','Cancel','Add','Save'].some(w => b.text.includes(w)));
})()`);
console.error('Action buttons visible:', dialogs);

// If there's a confirmation, click Yes
if (dialogs.some(d => d.text === 'Yes')) {
  await ev(`(function() {
    var btns = Array.from(document.querySelectorAll('button'));
    for (var b of btns) { if ((b.textContent||'').trim() === 'Yes') { b.click(); return; } }
  })()`);
  console.error('Clicked Yes');
  await sleep(3000);
}

// Screenshot
const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
fs.writeFileSync('/tmp/tv_after_save.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

// Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

await client.close();
