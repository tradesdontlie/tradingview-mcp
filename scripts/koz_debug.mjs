import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const evAsync = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Dump all buttons in the Pine editor bottom bar area
const btns = await ev(`(function() {
  var all = Array.from(document.querySelectorAll('button, [role="button"]'));
  return all.map(b => ({
    text: (b.textContent || '').trim().slice(0, 60),
    dataName: b.getAttribute('data-name'),
    ariaLabel: b.getAttribute('aria-label'),
    className: (b.className || '').slice(0, 80),
    id: b.id || null
  })).filter(b => b.text || b.dataName || b.ariaLabel);
})()`);

console.log('All interactive buttons:');
btns.forEach((b, i) => {
  if (b.dataName || b.ariaLabel || b.text.toLowerCase().includes('add') || b.text.toLowerCase().includes('compile') || b.text.toLowerCase().includes('chart')) {
    console.log(i, JSON.stringify(b));
  }
});

// Also check for any pine-editor-specific elements
const pineEls = await ev(`(function() {
  var els = document.querySelectorAll('[class*="pine"], [data-name*="pine"], [data-name*="script"]');
  return Array.from(els).slice(0, 30).map(e => ({
    tag: e.tagName,
    dataName: e.getAttribute('data-name'),
    ariaLabel: e.getAttribute('aria-label'),
    className: (e.className || '').slice(0, 80),
    text: (e.textContent || '').trim().slice(0, 50)
  }));
})()`);
console.log('\nPine-related elements:');
pineEls.forEach(e => console.log(JSON.stringify(e)));

await client.close();
