import CDP from 'chrome-remote-interface';

const targets = await fetch('http://localhost:9222/json').then(r => r.json());
const newTab = targets.find(t => t.title === 'New tab');
const client = await CDP({ target: newTab.id });
await client.Runtime.enable();
// Click the NIFTY layout item
const result = await client.Runtime.evaluate({
  expression: `
    (function() {
      // Find the NIFTY layout card and click it
      const spans = Array.from(document.querySelectorAll('span'));
      const niftySpan = spans.find(s => s.textContent.includes('NIFTY'));
      if (!niftySpan) return 'NIFTY span not found';

      // Walk up to find a clickable parent
      let el = niftySpan;
      for (let i = 0; i < 6; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('tabindex') === '0') {
          el.click();
          return 'clicked: ' + el.tagName + ' ' + el.className.substring(0, 40);
        }
      }
      // If no clickable parent found, just click the span itself
      niftySpan.click();
      return 'clicked span: ' + niftySpan.textContent;
    })()
  `,
  returnByValue: true
});

console.log('Click result:', result.result.value);

await new Promise(r => setTimeout(r, 4000));

// Check what targets exist now
const newTargets = await fetch('http://localhost:9222/json').then(r => r.json());
console.log('Targets after click:');
newTargets.forEach(t => console.log(' -', t.title, '|', t.url.substring(0, 80)));

await client.close();
