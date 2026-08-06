/**
 * Get stock data via CDP - switch symbol, get OHLCV + Pine tables + labels
 * Usage: node get_stock.mjs HOSE:VIB D 60
 */
import CDP from 'chrome-remote-interface';

const SYMBOL    = process.argv[2] || 'HOSE:VIB';
const TIMEFRAME = process.argv[3] || 'D';
const BAR_COUNT = parseInt(process.argv[4] || '65');

const CHART_API  = 'window.TradingViewApi._activeChartWidgetWV.value()';
const BARS_PATH  = `${CHART_API}._chartWidget.model().mainSeries().bars()`;
const STUDY_PATH = `${CHART_API}._chartWidget.model().model().dataSources()`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ host: 'localhost', port: 9222 });
    const chartTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
    if (!chartTarget) throw new Error('No TradingView chart tab found');

    client = await CDP({ target: chartTarget.id, host: 'localhost', port: 9222 });
    const { Runtime } = client;

    const evaluate = async (expression) => {
      const res = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    };

    // Step 1: Switch symbol
    console.log(`\n[1] Switching to ${SYMBOL} ${TIMEFRAME}...`);
    await evaluate(`${CHART_API}.setSymbol(${JSON.stringify(SYMBOL)}, ${JSON.stringify(TIMEFRAME)})`);
    await new Promise(r => setTimeout(r, 4000));

    // Step 2: Get OHLCV bars
    console.log(`\n[2] Getting ${BAR_COUNT} OHLCV bars...`);
    const ohlcvRaw = await evaluate(`
      (function() {
        try {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return JSON.stringify({error: 'bars not ready'});
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - ${BAR_COUNT} + 1);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
          }
          return JSON.stringify({bars: result, total: bars.size()});
        } catch(e) { return JSON.stringify({error: e.message}); }
      })()`);

    // Step 3: Get Pine tables (Footprint data)
    console.log('\n[3] Getting Pine tables (Footprint)...');
    const tablesRaw = await evaluate(`
      (function() {
        var chart = ${CHART_API}._chartWidget;
        var model = chart.model();
        var sources = model.model().dataSources();
        var results = [];
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (!s.metaInfo) continue;
          try {
            var meta = s.metaInfo();
            var name = meta.description || meta.shortDescription || '';
            if (!name) continue;
            // Get table cells
            var g = s._graphics;
            if (!g || !g._primitivesCollection) continue;
            var pc = g._primitivesCollection;
            var cells = [];
            try {
              var tc = pc.dwgtablecells;
              if (tc) {
                var tcColl = tc.get('tableCells');
                if (!tcColl) tcColl = tc.get(Object.keys(Object.fromEntries ? Object.fromEntries(tc) : {})[0]);
                if (tcColl && tcColl._primitivesDataById) {
                  tcColl._primitivesDataById.forEach(function(v) {
                    if (v && v.text !== undefined) cells.push(v.text);
                  });
                }
              }
            } catch(e) {}
            if (cells.length > 0) results.push({name: name, cells: cells});
          } catch(e) {}
        }
        return JSON.stringify(results);
      })()`);

    // Step 4: Get Pine labels
    console.log('\n[4] Getting Pine labels...');
    const labelsRaw = await evaluate(`
      (function() {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var results = [];
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (!s.metaInfo) continue;
          try {
            var meta = s.metaInfo();
            var name = meta.description || meta.shortDescription || '';
            if (!name) continue;
            var g = s._graphics;
            if (!g || !g._primitivesCollection) continue;
            var labels = [];
            try {
              var lc = g._primitivesCollection.dwglabels;
              if (lc) {
                var inner = lc.get('labels');
                if (inner && inner.get) {
                  var coll = inner.get(false);
                  if (coll && coll._primitivesDataById) {
                    coll._primitivesDataById.forEach(function(v) {
                      if (v && v.text) labels.push({text: v.text, price: v.price || v.y});
                    });
                  }
                }
              }
            } catch(e) {}
            if (labels.length > 0) results.push({name: name, labels: labels.slice(0, 20)});
          } catch(e) {}
        }
        return JSON.stringify(results);
      })()`);

    // Step 5: Get study values
    console.log('\n[5] Getting study numeric values...');
    const studyRaw = await evaluate(`
      (function() {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var results = [];
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (!s.metaInfo) continue;
          try {
            var meta = s.metaInfo();
            var name = meta.description || meta.shortDescription || '';
            if (!name) continue;
            var lastVals = null;
            try {
              if (s.data) {
                var d = s.data();
                if (d && d.bars) {
                  var sbars = d.bars();
                  if (sbars && typeof sbars.lastIndex === 'function') {
                    var li = sbars.lastIndex();
                    var v = sbars.valueAt(li);
                    lastVals = v;
                  }
                }
              }
            } catch(e2) {}
            results.push({name: name, values: lastVals});
          } catch(e) {}
        }
        return JSON.stringify(results);
      })()`);

    // Output all raw data
    console.log('\n=== OHLCV ===');
    console.log(ohlcvRaw);
    console.log('\n=== TABLES ===');
    console.log(tablesRaw);
    console.log('\n=== LABELS ===');
    console.log(labelsRaw);
    console.log('\n=== STUDIES ===');
    console.log(studyRaw);

    // Parse and calculate SMAs from OHLCV
    const ohlcv = JSON.parse(ohlcvRaw || '{}');
    if (ohlcv.bars && ohlcv.bars.length > 0) {
      const bars = ohlcv.bars; // [time, open, high, low, close, vol]
      const closes = bars.map(b => b[4]);
      const n = closes.length;

      const calcSMA = (period) => {
        if (n < period) return null;
        return closes.slice(-period).reduce((a,b) => a+b, 0) / period;
      };

      const lastBar = bars[n-1];
      const prevBar = bars[n-2];
      const date = new Date(lastBar[0] * 1000).toISOString().substring(0, 10);

      console.log('\n=== CALCULATED FROM OHLCV ===');
      console.log(`Date: ${date}`);
      console.log(`Close: ${lastBar[4].toFixed(0)}`);
      console.log(`Open: ${lastBar[1].toFixed(0)}, High: ${lastBar[2].toFixed(0)}, Low: ${lastBar[3].toFixed(0)}`);
      console.log(`Volume: ${lastBar[5].toFixed(0)}`);
      console.log(`Change: ${((lastBar[4]-prevBar[4])/prevBar[4]*100).toFixed(2)}%`);
      console.log(`SMA20: ${calcSMA(20)?.toFixed(2)}`);
      console.log(`AvgVol20: ${(bars.slice(-20).reduce((a,b)=>a+b[5],0)/20).toFixed(0)}`);

      // Last 10 bars for wave analysis
      console.log('\n=== LAST 10 BARS ===');
      bars.slice(-10).forEach(b => {
        const d = new Date(b[0]*1000).toISOString().substring(0,10);
        console.log(`${d}  O:${b[1].toFixed(0)}  H:${b[2].toFixed(0)}  L:${b[3].toFixed(0)}  C:${b[4].toFixed(0)}  V:${b[5].toFixed(0)}`);
      });

      // Full bars for wave analysis (output structured)
      console.log('\n=== ALL BARS JSON (for wave calc) ===');
      const structured = bars.map(b => ({
        date: new Date(b[0]*1000).toISOString().substring(0,10),
        o: b[1], h: b[2], l: b[3], c: b[4], v: b[5]
      }));
      console.log(JSON.stringify(structured));
    }

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    if (client) await client.close();
    process.exit(0);
  }
}

run();
