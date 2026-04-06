import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Click "No" in the confirmation dialog to add to chart without saving
const clickNo = await ev(`(function() {
  var btns = Array.from(document.querySelectorAll('button'));
  for (var i = 0; i < btns.length; i++) {
    var text = (btns[i].textContent || '').trim();
    if (text === 'No') { btns[i].click(); return { clicked: 'No' }; }
  }
  return { found: false };
})()`);
console.error('Clicked:', clickNo);
await sleep(5000);

// Check studies
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', studies.map(s => s.name));

const kozStudy = studies.find(s => s.name && s.name.toLowerCase().includes('koz'));

if (!kozStudy) {
  // Take a screenshot to see what happened
  const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
  fs.writeFileSync('/tmp/tv_after_no.jpg', Buffer.from(data, 'base64'));
  console.error('No KOZ study found, screenshot at /tmp/tv_after_no.jpg');
  await client.close();
  process.exit(0);
}

console.error('KOZ Strategy loaded! ID:', kozStudy.id);
await sleep(3000); // Wait for strategy tester to populate

// Get strategy performance data
const perfData = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      if (!name.toLowerCase().includes('koz')) continue;

      var rd = null;
      try {
        rd = s.reportData;
        if (typeof rd === 'function') rd = rd();
        if (rd && typeof rd.value === 'function') rd = rd.value();
      } catch(e) {}

      var orders = [];
      try {
        var od = s.ordersData;
        if (typeof od === 'function') od = od();
        if (od && typeof od.value === 'function') od = od.value();
        if (Array.isArray(od)) {
          orders = od.slice(0, 20).map(function(o) {
            if (!o || typeof o !== 'object') return null;
            var t = {};
            Object.keys(o).forEach(function(k) {
              var v = o[k];
              if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') t[k] = v;
            });
            return t;
          }).filter(Boolean);
        }
      } catch(e) {}

      return { name, reportData: rd, trades: orders, tradeCount: orders.length };
    }
    return { error: 'KOZ strategy not found in data sources' };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(perfData, null, 2));

await client.close();
