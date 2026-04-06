import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();

function evaluate(expr) {
  return Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true })
    .then(r => r.result.value);
}

// Switch to MNQ1! daily
await evaluate(`
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    chart.setSymbol('MNQ1!', {});
    chart.setResolution('D', {});
  })()
`);

// Wait for chart to load
await new Promise(r => setTimeout(r, 3000));

// Get last 45 bars (~2 months of trading days)
const data = await evaluate(`
  (function() {
    var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var result = [];
    var end = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - 44);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
    }
    return result;
  })()
`);

await client.close();

if (!data || !data.length) {
  console.error('No data returned');
  process.exit(1);
}

console.log(`\nMNQ1! Daily % Movement — Last ${data.length} trading days\n`);
console.log('Date'.padEnd(14) + 'Open'.padStart(10) + 'Close'.padStart(10) + 'Change%'.padStart(10) + '  Bar');

let totalUp = 0, totalDown = 0, bigMoves = [];

for (const bar of data) {
  const date = new Date(bar.time * 1000).toISOString().slice(0, 10);
  const pct = ((bar.close - bar.open) / bar.open) * 100;
  const dir = pct >= 0 ? '+' : '';
  const vis = pct >= 0 ? '▲'.repeat(Math.min(Math.round(Math.abs(pct) * 2), 20)) : '▼'.repeat(Math.min(Math.round(Math.abs(pct) * 2), 20));
  if (pct >= 0) totalUp++; else totalDown++;
  if (Math.abs(pct) >= 1) bigMoves.push({ date, pct });
  console.log(
    date.padEnd(14) +
    bar.open.toFixed(2).padStart(10) +
    bar.close.toFixed(2).padStart(10) +
    `${dir}${pct.toFixed(2)}%`.padStart(10) +
    '  ' + vis
  );
}

console.log(`\nSummary: ${totalUp} up days / ${totalDown} down days`);
console.log(`\nBig moves (≥1%):`);
bigMoves.forEach(m => console.log(`  ${m.date}  ${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%`));
