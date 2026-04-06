import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wait for strategy tester to load
await sleep(4000);

const result = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var kozSrc = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (name.toLowerCase().includes('koz')) { kozSrc = s; break; }
    }
    if (!kozSrc) return { error: 'KOZ source not found', sources: sources.length };

    // Deep probe the source object for strategy data
    var allKeys = Object.getOwnPropertyNames(kozSrc);
    var stratKeys = allKeys.filter(k => /report|order|trade|perf|equity|stat|result|backtest/i.test(k));

    var reportData = null;
    try {
      var r = kozSrc.reportData;
      if (typeof r === 'function') r = r();
      if (r && typeof r.value === 'function') r = r.value();
      if (r && typeof r === 'object') {
        reportData = {};
        Object.keys(r).forEach(function(k) {
          var v = r[k];
          if (v !== null && v !== undefined && typeof v !== 'function') reportData[k] = v;
        });
      }
    } catch(e) { reportData = { error: e.message }; }

    var ordersData = null;
    var orderCount = 0;
    try {
      var o = kozSrc.ordersData;
      if (typeof o === 'function') o = o();
      if (o && typeof o.value === 'function') o = o.value();
      if (Array.isArray(o)) {
        orderCount = o.length;
        ordersData = o.slice(0, 20).map(function(order) {
          if (!order || typeof order !== 'object') return null;
          var t = {};
          Object.keys(order).forEach(function(k) {
            var v = order[k];
            if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') t[k] = v;
          });
          return t;
        }).filter(Boolean);
      }
    } catch(e) { ordersData = { error: e.message }; }

    return {
      name: Object.keys(kozSrc).includes('metaInfo') ? kozSrc.metaInfo().description : 'KOZ',
      strategyKeys: stratKeys,
      reportData,
      orderCount,
      recentTrades: ordersData
    };
  } catch(e) { return { error: e.message }; }
})()`);

console.log(JSON.stringify(result, null, 2));

await client.close();
