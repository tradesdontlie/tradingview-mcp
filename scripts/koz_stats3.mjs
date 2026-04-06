import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const evAsync = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// First read strategy source to understand designed timeframe
const source = await evAsync(`
  fetch('https://pine-facade.tradingview.com/pine-facade/get/USER;ba0405dbf0c749a49196ab77cd323045/3.0', { credentials: 'include' })
    .then(r => r.json()).then(d => d.source || '')
`);
// Print first 50 lines
const lines = source.split('\n').slice(0, 60);
console.error('=== Strategy Source (first 60 lines) ===');
lines.forEach((l, i) => console.error(i+1, l));

// Check current bar count
const barCount = await ev(`(function() {
  var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
  return { size: bars.size(), first: bars.firstIndex(), last: bars.lastIndex() };
})()`);
console.error('\nBar count:', barCount);

// Get full performance data
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

      // Get performance.all
      var pa = rd.performance && rd.performance.all;
      if (!pa) return { error: 'no performance.all', rdKeys: Object.keys(rd) };

      var result = {};
      Object.keys(pa).forEach(function(k) {
        var v = pa[k];
        if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') result[k] = v;
        else if (v && typeof v === 'object') result[k + '_keys'] = Object.keys(v).slice(0,5);
      });

      // Also get long performance
      var pl = rd.performance && rd.performance.long;
      var longResult = {};
      if (pl) {
        Object.keys(pl).forEach(function(k) {
          var v = pl[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') longResult[k] = v;
        });
      }

      // Get openPL and maxDrawDown
      var openPL = null, maxDD = null, buyHold = null;
      try {
        openPL = rd.performance.openPL;
        maxDD = rd.performance.maxStrategyDrawDown;
        buyHold = rd.performance.buyHoldReturn;
        if (openPL && typeof openPL.value === 'function') openPL = openPL.value();
        if (maxDD && typeof maxDD.value === 'function') maxDD = maxDD.value();
        if (buyHold && typeof buyHold.value === 'function') buyHold = buyHold.value();
      } catch(e) {}

      return {
        name,
        tradesCount: rd.trades ? rd.trades.length : 0,
        filledOrdersCount: rd.filledOrders ? rd.filledOrders.length : 0,
        currency: rd.currency,
        performance_all: result,
        performance_long: longResult,
        openPL, maxDD, buyHold
      };
    }
    return { error: 'KOZ not found' };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('\n=== Performance Data ===');
console.log(JSON.stringify(perf, null, 2));

await client.close();
