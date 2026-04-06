import CDP from 'chrome-remote-interface';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime } = client;
await Runtime.enable();
const ev = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await sleep(3000); // Let strategy compute

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
    if (!kozSrc) return { error: 'KOZ not found' };

    // Try _reportData directly
    var rd = null;
    var rdErr = null;
    try {
      var raw = kozSrc._reportData;
      if (raw && typeof raw.value === 'function') raw = raw.value();
      if (raw && typeof raw === 'object') {
        rd = {};
        Object.keys(raw).forEach(function(k) {
          var v = raw[k];
          if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') rd[k] = v;
          else if (Array.isArray(v)) rd[k + '_len'] = v.length;
          else if (v && typeof v === 'object') rd[k + '_keys'] = Object.keys(v).slice(0,5);
        });
      } else {
        rdErr = 'raw type: ' + typeof raw + ', value: ' + JSON.stringify(raw);
      }
    } catch(e) { rdErr = e.message; }

    // Try _reportDataBuffer
    var buf = null;
    try {
      var b = kozSrc._reportDataBuffer;
      if (b) {
        if (typeof b.value === 'function') b = b.value();
        if (b && typeof b === 'object') {
          buf = {};
          Object.keys(b).slice(0, 30).forEach(function(k) {
            var v = b[k];
            if (v !== null && v !== undefined && typeof v !== 'function') {
              if (typeof v === 'object' && !Array.isArray(v)) buf[k + '_keys'] = Object.keys(v).slice(0, 5);
              else buf[k] = Array.isArray(v) ? '[len:' + v.length + ']' : v;
            }
          });
        }
      }
    } catch(e) {}

    // Try _signlePerformanceValue (intentional typo in TV source)
    var perf = null;
    try {
      var p = kozSrc._signlePerformanceValue;
      if (p !== undefined && p !== null) perf = p;
    } catch(e) {}

    // Try _status
    var status = null;
    try {
      var st = kozSrc._status;
      if (st && typeof st.value === 'function') status = st.value();
      else status = st;
    } catch(e) {}

    // Try reportData() method (from the parent prototype)
    var reportDataMethod = null;
    try {
      var proto = Object.getPrototypeOf(kozSrc);
      if (proto && typeof proto.reportData === 'function') {
        reportDataMethod = proto.reportData.call(kozSrc);
        if (reportDataMethod && typeof reportDataMethod.value === 'function') reportDataMethod = reportDataMethod.value();
      }
    } catch(e) { reportDataMethod = 'proto err: ' + e.message; }

    return {
      rdData: rd, rdErr, buf, perf, status,
      reportDataMethod: typeof reportDataMethod === 'object' ? Object.keys(reportDataMethod || {}).slice(0,20) : reportDataMethod
    };
  } catch(e) { return { error: e.message }; }
})()`);

console.log(JSON.stringify(result, null, 2));

await client.close();
