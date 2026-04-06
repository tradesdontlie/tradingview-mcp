import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Get chart center for mouse wheel events
const chartCenter = await ev(`(function() {
  var el = document.querySelector('.chart-container, .chart-gui-wrapper, [class*="chart-container"]');
  if (!el) return { x: 400, y: 300 };
  var r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height * 0.5) };
})()`);
console.error('Chart center:', chartCenter);

async function getBarCount() {
  return ev(`(function() {
    var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
    return bars.size();
  })()`);
}

console.error('Initial bars:', await getBarCount());

// Scroll left aggressively to load history
// Each scroll batch loads ~300 more bars
for (let batch = 0; batch < 10; batch++) {
  for (let i = 0; i < 20; i++) {
    await Input.dispatchMouseEvent({
      type: 'mouseWheel',
      x: chartCenter.x, y: chartCenter.y,
      deltaX: -500, deltaY: 0,
      modifiers: 0
    });
    await sleep(50);
  }
  await sleep(1500); // Wait for bars to load from server
  const count = await getBarCount();
  console.error(`Batch ${batch + 1}: ${count} bars`);
  if (count >= 5000) break; // Enough history for a good backtest
}

const finalCount = await getBarCount();
console.error('Final bar count:', finalCount);

// Wait for strategy to recompute
await sleep(5000);

// Get strategy stats
const perf = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var found = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (name.toLowerCase().includes('orb') || name.toLowerCase().includes('koz algo')) {
        found = s; break;
      }
    }
    if (!found) return { error: 'strategy not found' };

    var rd = found._reportData;
    if (rd && typeof rd.value === 'function') rd = rd.value();
    if (!rd) return { error: 'no reportData' };

    function flat(p) {
      if (!p) return {};
      var r = {};
      Object.keys(p).forEach(function(k) {
        var v = p[k];
        if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') r[k] = Math.round(v * 100) / 100;
      });
      return r;
    }

    var trades = [];
    if (Array.isArray(rd.trades)) {
      trades = rd.trades.slice(-10).map(function(t) {
        if (!t || typeof t !== 'object') return null;
        var tr = {};
        Object.keys(t).forEach(function(k) {
          var v = t[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') tr[k] = v;
        });
        return tr;
      }).filter(Boolean);
    }

    return {
      name: meta ? (meta.description || '') : 'strategy',
      currency: rd.currency,
      totalTrades: rd.trades ? rd.trades.length : 0,
      all: flat(rd.performance && rd.performance.all),
      long: flat(rd.performance && rd.performance.long),
      short: flat(rd.performance && rd.performance.short),
      maxDD: rd.performance ? rd.performance.maxStrategyDrawDown : 0,
      buyHold: rd.performance ? rd.performance.buyHoldReturn : 0,
      recentTrades: trades
    };
  } catch(e) { return { error: e.message }; }
})()`);

console.log(JSON.stringify(perf, null, 2));

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
fs.writeFileSync('/tmp/tv_loaded.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
