import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Get viewport and device pixel ratio
const viewport = await ev(`(function() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight
  };
})()`);
console.error('Viewport:', viewport);

// Try Cmd+Enter (modifier 4 on Mac for Meta/Command key)
const ta = await ev(`(function() {
  var ta = document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if (ta) { ta.click(); ta.focus(); return 'focused'; }
  return 'not found';
})()`);
console.error('Textarea:', ta);
await sleep(300);

await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 4, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(100);
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
console.error('Cmd+Enter sent');
await sleep(2000);

// Check for dialog
const dialog = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
  return btns.filter(b => {
    var t = (b.textContent||'').trim();
    return t === 'Yes' || t === 'No' || t.includes('Add') || t.includes('Save');
  }).map(b => ({ text: (b.textContent||'').trim(), cls: (b.className||'').slice(0,40) }));
})()`);
console.error('Dialog buttons:', dialog);

const { data: ss } = await Page.captureScreenshot({ format: 'jpeg', quality: 50 });
fs.writeFileSync('/tmp/tv_cmd_enter.jpg', Buffer.from(ss, 'base64'));

// Also try finding "Add to chart" via the React component's internal actions
const chartActions = await ev(`(function() {
  try {
    // Look for pine editor component with addToChart method
    var pineEl = document.querySelector('[data-name="pine-dialog"]');
    if (!pineEl) return 'no pine dialog';
    var fiberKey = Object.keys(pineEl).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) return 'no fiber';
    var fiber = pineEl[fiberKey];
    // Walk up to find a component with handleAddToChart or similar
    var methods = [];
    for (var d = 0; d < 50; d++) {
      if (!fiber) break;
      var inst = fiber.stateNode;
      if (inst && typeof inst === 'object') {
        var keys = Object.keys(inst).filter(k => /add|chart|compile|run|apply/i.test(k) && typeof inst[k] === 'function');
        if (keys.length > 0) { methods = methods.concat(keys.map(k => ({ depth: d, key: k }))); }
      }
      fiber = fiber.return;
    }
    return methods.slice(0, 20);
  } catch(e) { return e.message; }
})()`);
console.error('Add-related React methods:', JSON.stringify(chartActions));

// Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

await client.close();
