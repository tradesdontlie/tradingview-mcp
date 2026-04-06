import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helper: type a string via keyboard events
async function typeString(str) {
  for (const ch of str) {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: ch, text: ch });
    await Input.dispatchKeyEvent({ type: 'char', key: ch, text: ch });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
    await sleep(50);
  }
}

// Step 1: Click Indicators button
await ev(`document.querySelector('[data-name="open-indicators-dialog"]').click()`);
await sleep(1500);
console.error('Indicators dialog opened');

// Step 2: Find + focus search input
const focusResult = await ev(`(function() {
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].offsetParent !== null) {
      inputs[i].focus();
      inputs[i].select();
      return { focused: true, placeholder: inputs[i].placeholder };
    }
  }
  return { focused: false };
})()`);
console.error('Focus:', focusResult);
await sleep(300);

// Step 3: Type KOZ via keyboard
await typeString('KOZ');
await sleep(1500);

// Step 4: Find results
const items = await ev(`(function() {
  var all = Array.from(document.querySelectorAll('[class*="item-"], [class*="listItem"], [class*="cell-"], [class*="result-"]'));
  return all.slice(0, 30).map(function(el) {
    return {
      text: (el.textContent || '').trim().slice(0, 100),
      className: (el.className || '').slice(0, 50)
    };
  }).filter(function(x) { return x.text.length > 2; });
})()`);
console.error('Items found:', items.slice(0, 10).map(x => x.text));

// Step 5: Click item with KOZ
const clickResult = await ev(`(function() {
  var all = Array.from(document.querySelectorAll('[class*="item-"], [class*="listItem"], [class*="cell-"], [class*="result-"]'));
  for (var i = 0; i < all.length; i++) {
    var text = (all[i].textContent || '').trim();
    if (/koz algo/i.test(text)) { all[i].click(); return { clicked: text.slice(0, 80) }; }
  }
  // Try broader
  for (var j = 0; j < all.length; j++) {
    var t = (all[j].textContent || '').trim();
    if (/koz/i.test(t)) { all[j].click(); return { clicked: t.slice(0, 80), partial: true }; }
  }
  return { clicked: null, total: all.length };
})()`);
console.error('Click:', clickResult);

// Close dialog with Escape
await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
await sleep(3000);

// Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies after:', studies.map(s => s.name));

await client.close();
