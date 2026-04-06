import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const evAsync = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Step 1: Click Indicators button to open dialog
const openBtn = await ev(`(function() {
  var btn = document.querySelector('[data-name="open-indicators-dialog"]');
  if (btn) { btn.click(); return true; }
  return false;
})()`);
console.error('Opened indicators dialog:', openBtn);
await sleep(1500);

// Step 2: Find the search input and type KOZ
const searchResult = await ev(`(function() {
  var inputs = document.querySelectorAll('input[type="text"], input[placeholder*="earch"], input[placeholder*="ndicator"]');
  for (var i = 0; i < inputs.length; i++) {
    var p = inputs[i].placeholder || '';
    if (p.toLowerCase().includes('search') || p.toLowerCase().includes('indicator') || p.toLowerCase().includes('script')) {
      inputs[i].focus();
      return { found: true, placeholder: p };
    }
  }
  // Try any visible input
  if (inputs.length > 0) { inputs[0].focus(); return { found: true, placeholder: inputs[0].placeholder }; }
  return { found: false };
})()`);
console.error('Search input:', searchResult);
await sleep(300);

// Step 3: Type "KOZ" in the search
const { Runtime: R2 } = client;
await ev(`(function() {
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].offsetParent !== null) {
      var event = new Event('input', { bubbles: true });
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(inputs[i], 'KOZ');
      inputs[i].dispatchEvent(event);
      inputs[i].focus();
      return true;
    }
  }
  return false;
})()`);
await sleep(2000);

// Step 4: Look for KOZ results in the dialog
const results = await ev(`(function() {
  var items = document.querySelectorAll('[class*="listItem"], [class*="item-"], [role="option"], [class*="result"]');
  return Array.from(items).slice(0, 20).map(function(el) {
    return {
      text: (el.textContent || '').trim().slice(0, 100),
      className: (el.className || '').slice(0, 60),
      dataId: el.getAttribute('data-id'),
      role: el.getAttribute('role')
    };
  });
})()`);
console.error('Search results:', JSON.stringify(results.slice(0, 10)));

// Step 5: Find and click the KOZ Algo strategy
const clicked = await ev(`(function() {
  var items = document.querySelectorAll('[class*="listItem"], [class*="item-"], [role="option"], [class*="result"], [class*="cell-"]');
  for (var i = 0; i < items.length; i++) {
    var text = (items[i].textContent || '').trim();
    if (text.toLowerCase().includes('koz algo')) {
      items[i].click();
      return { clicked: true, text: text.slice(0, 80) };
    }
  }
  // Also try double-click
  for (var j = 0; j < items.length; j++) {
    var t2 = (items[j].textContent || '').trim();
    if (t2.toLowerCase().includes('koz')) {
      items[j].click();
      return { clicked: true, text: t2.slice(0, 80), partial: true };
    }
  }
  return { clicked: false, total: items.length };
})()`);
console.error('Clicked KOZ:', clicked);
await sleep(4000);

// Step 6: Check studies + get strategy results
const studies = await ev(`(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s => ({ id: s.id, name: s.name })); }
  catch(e) { return []; }
})()`);
console.error('Studies:', JSON.stringify(studies));

const kozStudy = studies.find(s => s.name && s.name.toLowerCase().includes('koz'));
console.error('KOZ study loaded:', !!kozStudy, kozStudy);

// Step 7: Probe for strategy tester data
const stratData = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var out = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { if (s.metaInfo) meta = s.metaInfo(); } catch(e) {}
      var name = meta ? (meta.description || meta.shortDescription || '') : '';
      var isStrat = meta && (meta.is_strategy === true || meta.is_price_study !== undefined);
      if (!isStrat && !name.toLowerCase().includes('koz')) continue;

      var reportVal = null, orderCount = 0;
      try {
        var rd = s.reportData;
        if (typeof rd === 'function') rd = rd();
        if (rd && typeof rd.value === 'function') rd = rd.value();
        if (rd && typeof rd === 'object') {
          reportVal = {};
          var keys = Object.keys(rd);
          for (var k = 0; k < keys.length; k++) {
            var v = rd[keys[k]];
            if (v !== null && v !== undefined && typeof v !== 'function') reportVal[keys[k]] = v;
          }
        }
      } catch(e) {}
      try {
        var orders = s.ordersData;
        if (typeof orders === 'function') orders = orders();
        if (orders && typeof orders.value === 'function') orders = orders.value();
        orderCount = Array.isArray(orders) ? orders.length : 0;
      } catch(e) {}

      out.push({ idx: i, name, reportVal, orderCount });
    }
    return { sources: sources.length, found: out };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(stratData, null, 2));

await client.close();
