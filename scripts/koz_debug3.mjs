import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);

// Get tooltip text via React fiber for the unlabeled buttons in pine dialog
const tooltips = await ev(`(function() {
  var dialog = document.querySelector('[data-name="pine-dialog"]');
  if (!dialog) return 'no dialog';
  var btns = Array.from(dialog.querySelectorAll('button, [role="button"]'));
  return btns.map(function(b, i) {
    var tooltip = null;
    try {
      // Walk React fiber to find tooltip prop
      var fiberKey = Object.keys(b).find(k => k.startsWith('__reactFiber$'));
      if (fiberKey) {
        var fiber = b[fiberKey];
        for (var d = 0; d < 10; d++) {
          if (!fiber) break;
          var props = fiber.memoizedProps;
          if (props) {
            tooltip = props.title || props.tooltip || props['data-tooltip'] || props.tooltipText;
            if (tooltip) break;
          }
          fiber = fiber.return;
        }
      }
    } catch(e) {}
    return {
      idx: i,
      text: (b.textContent || '').trim().slice(0, 40),
      tooltip,
      className: (b.className || '').slice(0, 50)
    };
  });
})()`);

console.log('Pine dialog button tooltips:');
tooltips.forEach(t => console.log(JSON.stringify(t)));

// Also look at Pine editor via the react tree for "add to chart" functionality
const addToChartCheck = await ev(`(function() {
  // Look for elements with "add" related content in data attributes
  var all = document.querySelectorAll('[data-name*="add"], [class*="addToChart"], [class*="add-to-chart"], [title*="Add"], [title*="chart"]');
  return Array.from(all).map(e => ({
    tag: e.tagName,
    dataName: e.getAttribute('data-name'),
    title: e.getAttribute('title'),
    text: (e.textContent || '').trim().slice(0, 50),
    className: (e.className || '').slice(0, 60)
  }));
})()`);
console.log('\nAdd-related elements:', JSON.stringify(addToChartCheck, null, 2));

await client.close();
