import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);

// Find buttons inside pine dialog
const pineDialogBtns = await ev(`(function() {
  var dialog = document.querySelector('[data-name="pine-dialog"]');
  if (!dialog) return { error: 'no pine dialog' };
  var btns = Array.from(dialog.querySelectorAll('button, [role="button"]'));
  return btns.map(b => ({
    text: (b.textContent || '').trim().slice(0, 80),
    dataName: b.getAttribute('data-name'),
    ariaLabel: b.getAttribute('aria-label'),
    className: (b.className || '').slice(0, 80)
  }));
})()`);

console.log('Pine dialog buttons:');
pineDialogBtns.forEach((b, i) => console.log(i, JSON.stringify(b)));

await client.close();
