import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const evAsync = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Scroll chart back to ~6 months ago to load more historical bars
// Use scrollToDate to go back far enough
const scrollResult = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    // Go back 6 months on 5m chart = ~50000+ bars
    var sixMonthsAgo = Math.floor(Date.now() / 1000) - (180 * 24 * 60 * 60);
    chart.scrollToDate(sixMonthsAgo);
    return { ok: true, date: new Date(sixMonthsAgo * 1000).toISOString() };
  } catch(e) { return { error: e.message }; }
})()`);
console.error('Scroll result:', scrollResult);
await sleep(5000);

// Check how many bars loaded now
let barCount = await ev(`(function() {
  var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
  return bars.size();
})()`);
console.error('Bars after scroll:', barCount);

// Also set the visible range to show the full history
await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var from = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60); // 3 months ago
    var to = Math.floor(Date.now() / 1000);
    chart.setVisibleRange({ from, to });
    return true;
  } catch(e) { return e.message; }
})()`);
await sleep(8000);

barCount = await ev(`(function() {
  var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
  return bars.size();
})()`);
console.error('Bars after setVisibleRange:', barCount);

// Wait for strategy to recalculate with more data
await sleep(5000);

// Get strategy stats
const perf = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (!name.toLowerCase().includes('koz')) continue;

      var rd = s._reportData;
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
        trades = rd.trades.slice(0, 20).map(function(t) {
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
        name, currency: rd.currency,
        totalTrades: rd.trades ? rd.trades.length : 0,
        all: flat(rd.performance && rd.performance.all),
        long: flat(rd.performance && rd.performance.long),
        short: flat(rd.performance && rd.performance.short),
        openPL: rd.performance ? rd.performance.openPL : null,
        maxDrawdown: rd.performance ? rd.performance.maxStrategyDrawDown : null,
        buyHoldReturn: rd.performance ? rd.performance.buyHoldReturn : null,
        recentTrades: trades
      };
    }
    return { error: 'KOZ not found' };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(perf, null, 2));

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 55 });
fs.writeFileSync('/tmp/tv_koz_history.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
