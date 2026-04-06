import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Switch to 5m
await ev(`(function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value();
  chart.setResolution('5', {});
})()`);
await sleep(5000);

const barCount = await ev(`(function() {
  var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
  return bars.size();
})()`);
console.error('Bars on 5m chart:', barCount);

// Wait for strategy to recalculate
await sleep(4000);

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

      var pa = rd.performance && rd.performance.all;
      var pl_long = rd.performance && rd.performance.long;
      var pl_short = rd.performance && rd.performance.short;

      function flattenPerf(p) {
        if (!p) return {};
        var r = {};
        Object.keys(p).forEach(function(k) {
          var v = p[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') r[k] = v;
        });
        return r;
      }

      // Get actual trades
      var trades = [];
      if (rd.trades && Array.isArray(rd.trades)) {
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

      // Get filled orders
      var orders = [];
      if (rd.filledOrders && Array.isArray(rd.filledOrders)) {
        orders = rd.filledOrders.slice(0, 20).map(function(o) {
          if (!o || typeof o !== 'object') return null;
          var or = {};
          Object.keys(o).forEach(function(k) {
            var v = o[k];
            if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') or[k] = v;
          });
          return or;
        }).filter(Boolean);
      }

      return {
        name,
        currency: rd.currency,
        totalTrades: rd.trades ? rd.trades.length : 0,
        totalOrders: rd.filledOrders ? rd.filledOrders.length : 0,
        performance_all: flattenPerf(pa),
        performance_long: flattenPerf(pl_long),
        performance_short: flattenPerf(pl_short),
        openPL: rd.performance ? rd.performance.openPL : null,
        maxDrawdown: rd.performance ? rd.performance.maxStrategyDrawDown : null,
        recentTrades: trades,
        recentOrders: orders
      };
    }
    return { error: 'KOZ not found' };
  } catch(e) { return { error: e.message }; }
})()`);

console.log(JSON.stringify(perf, null, 2));

// Screenshot
const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 55 });
fs.writeFileSync('/tmp/tv_koz_5m.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
