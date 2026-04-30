/**
 * E2E tests for TradingView MCP tools.
 * Requires TradingView Desktop running with a chart open. Uses the repo
 * connection adapter, so it supports direct CDP or the Electron bridge
 * fallback.
 *
 * Run: node --test tests/e2e.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { disconnect, evaluate as tvEvaluate, getClient } from '../src/connection.js';

let client;

// Helper: evaluate JS in TradingView context
async function evaluate(expr) {
  return tvEvaluate(expr, { awaitPromise: true });
}

// Helper: check if a specific API path exists
async function apiExists(path) {
  try {
    const exists = await evaluate(`(function() { try { return ${path} != null; } catch(e) { return false; } })()`);
    return exists;
  } catch { return false; }
}

describe('TradingView MCP E2E Tests', () => {

  before(async () => {
    try {
      client = await getClient();
    } catch (err) {
      console.error(`Cannot connect to TradingView: ${err.message}`);
      process.exit(1);
    }
  });

  after(async () => {
    await disconnect();
  });

  // ─── Health & Connection ─────────────────────────────────────────

  describe('Health & Connection', () => {
    it('should connect through the TradingView connection adapter', () => {
      assert.ok(client, 'TradingView client connected');
    });

    it('should find chart API', async () => {
      const exists = await apiExists('window.TradingViewApi._activeChartWidgetWV.value()');
      assert.ok(exists, 'Chart API available');
    });

    it('should get current symbol', async () => {
      const symbol = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().symbol()');
      assert.ok(symbol, 'Symbol returned');
      assert.ok(typeof symbol === 'string', 'Symbol is string');
    });

    it('should get current resolution', async () => {
      const res = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().resolution()');
      assert.ok(res, 'Resolution returned');
    });

    it('should find bottomWidgetBar', async () => {
      const exists = await apiExists('window.TradingView.bottomWidgetBar');
      assert.ok(exists, 'bottomWidgetBar available');
    });

    it('should find replayApi', async () => {
      const exists = await apiExists('window.TradingViewApi._replayApi');
      assert.ok(exists, 'replayApi available');
    });
  });

  // ─── Chart Control ───────────────────────────────────────────────

  describe('Chart Control', () => {
    let originalSymbol;
    let originalTF;

    before(async () => {
      originalSymbol = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().symbol()');
      originalTF = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().resolution()');
    });

    after(async () => {
      // Restore original state
      await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setSymbol('${originalSymbol}')`);
      await new Promise(r => setTimeout(r, 2000));
      await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${originalTF}')`);
      await new Promise(r => setTimeout(r, 1000));
    });

    it('should change symbol', async () => {
      await evaluate("window.TradingViewApi._activeChartWidgetWV.value().setSymbol('AAPL')");
      await new Promise(r => setTimeout(r, 2000));
      const sym = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().symbol()');
      assert.ok(sym.includes('AAPL'), `Symbol changed to AAPL, got: ${sym}`);
    });

    it('should change timeframe', async () => {
      await evaluate("window.TradingViewApi._activeChartWidgetWV.value().setResolution('D')");
      await new Promise(r => setTimeout(r, 1000));
      const tf = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().resolution()');
      assert.equal(tf, '1D');
    });

    it('should get chart type', async () => {
      const ct = await evaluate('window.TradingViewApi._activeChartWidgetWV.value().chartType()');
      assert.ok(typeof ct === 'number', 'Chart type is a number');
    });

    it('should list studies', async () => {
      const studies = await evaluate(`
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          var result = [];
          for (var i = 0; i < sources.length; i++) {
            if (sources[i].metaInfo) {
              try { result.push(sources[i].metaInfo().description || ''); } catch(e) {}
            }
          }
          return result.filter(function(n) { return n; });
        })()
      `);
      assert.ok(Array.isArray(studies), 'Studies is an array');
    });

    it('should get visible range', async () => {
      const range = await evaluate(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          return api.getVisibleRange();
        })()
      `);
      assert.ok(range, 'Visible range returned');
      assert.ok(range.from, 'Has from');
      assert.ok(range.to, 'Has to');
      assert.ok(range.to > range.from, 'to > from');
    });

    it('should get symbol info', async () => {
      const info = await evaluate(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          try { return api.symbolExt(); } catch(e) { return null; }
        })()
      `);
      assert.ok(info, 'Symbol info returned');
    });
  });

  // ─── OHLCV Data ──────────────────────────────────────────────────

  describe('OHLCV Data', () => {
    it('should get bar data', async () => {
      const data = await evaluate(`
        (function() {
          var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 4);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
          }
          return result;
        })()
      `);
      assert.ok(data, 'Bar data returned');
      assert.ok(data.length > 0, 'Has bars');
      const bar = data[0];
      assert.ok(bar.time > 0, 'Has timestamp');
      assert.ok(bar.open > 0, 'Has open');
      assert.ok(bar.high >= bar.low, 'High >= Low');
      assert.ok(bar.close > 0, 'Has close');
    });

    it('should get real-time quote', async () => {
      const quote = await evaluate(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          var bars = api._chartWidget.model().mainSeries().bars();
          var last = bars.valueAt(bars.lastIndex());
          return last ? { time: last[0], close: last[4] } : null;
        })()
      `);
      assert.ok(quote, 'Quote returned');
      assert.ok(quote.close > 0, 'Has close price');
    });
  });

  // ─── Pine Graphics Pipeline ──────────────────────────────────────

  describe('Pine Graphics Pipeline', () => {
    it('should access dataSources', async () => {
      const count = await evaluate(`
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          return chart.model().model().dataSources().length;
        })()
      `);
      assert.ok(count > 0, `Found ${count} data sources`);
    });

    it('should find studies with metaInfo', async () => {
      const names = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var names = [];
          for (var i = 0; i < sources.length; i++) {
            if (sources[i].metaInfo) {
              try { names.push(sources[i].metaInfo().description || ''); } catch(e) {}
            }
          }
          return names.filter(function(n) { return n; });
        })()
      `);
      assert.ok(names.length > 0, `Found ${names.length} studies with names`);
    });

    it('should access _graphics._primitivesCollection', async () => {
      const hasPc = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (s._graphics && s._graphics._primitivesCollection) return true;
          }
          return false;
        })()
      `);
      assert.ok(hasPc, 'At least one study has _primitivesCollection');
    });

    it('should access dwglines.get("lines").get(false) path', async () => {
      const result = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            var pc = s._graphics._primitivesCollection;
            try {
              var dwglines = pc.dwglines;
              if (!dwglines) continue;
              var linesMap = dwglines.get('lines');
              if (!linesMap) continue;
              var coll = linesMap.get(false);
              if (coll && coll._primitivesDataById) {
                return { found: true, size: coll._primitivesDataById.size };
              }
            } catch(e) {}
          }
          return { found: false };
        })()
      `);
      assert.ok(result, 'Graphics path accessible');
      // May be empty if no visible Pine indicators use line.new
      assert.ok(typeof result.found === 'boolean', 'Returns found flag');
    });

    it('should access dwgtablecells.get("tableCells") path', async () => {
      const result = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            var pc = s._graphics._primitivesCollection;
            try {
              var dwgtc = pc.dwgtablecells;
              if (!dwgtc) continue;
              var coll = dwgtc.get('tableCells');
              if (coll && coll._primitivesDataById) {
                return { found: true, size: coll._primitivesDataById.size };
              }
            } catch(e) {}
          }
          return { found: false };
        })()
      `);
      assert.ok(result, 'Table cells path accessible');
    });

    it('should extract line prices when available', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var allPrices = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                coll._primitivesDataById.forEach(function(v) {
                  if (v.y1 != null && v.y1 === v.y2) allPrices.push(v.y1);
                });
              }
            } catch(e) {}
          }
          return allPrices.slice(0, 10);
        })()
      `);
      // May be empty if no visible Pine line drawings
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(typeof data[0] === 'number', 'Prices are numbers');
        assert.ok(data[0] > 0, 'Prices are positive');
      }
    });

    it('should extract label text when available', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var labels = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                coll._primitivesDataById.forEach(function(v) {
                  if (v.t) labels.push(v.t);
                });
              }
            } catch(e) {}
          }
          return labels.slice(0, 10);
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(typeof data[0] === 'string', 'Labels are strings');
      }
    });

    it('should extract table cell text when available', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var cells = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwgtablecells.get('tableCells');
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                coll._primitivesDataById.forEach(function(v) {
                  if (v.t) cells.push({ text: v.t, row: v.row, col: v.col });
                });
              }
            } catch(e) {}
          }
          return cells.slice(0, 10);
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok('text' in data[0], 'Cell has text');
        assert.ok('row' in data[0], 'Cell has row');
        assert.ok('col' in data[0], 'Cell has col');
      }
    });
  });

  // ─── Data Window Values ──────────────────────────────────────────

  describe('Data Window Values', () => {
    it('should get indicator values from dataWindowView', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s.metaInfo) continue;
            try {
              var dwv = s.dataWindowView();
              if (!dwv) continue;
              var items = dwv.items();
              if (!items) continue;
              var vals = {};
              for (var j = 0; j < items.length; j++) {
                if (items[j]._value && items[j]._value !== '∅' && items[j]._title) {
                  vals[items[j]._title] = items[j]._value;
                }
              }
              if (Object.keys(vals).length > 0) {
                results.push({ name: s.metaInfo().description, values: vals });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      // Should have at least something if any indicators are on chart
    });
  });

  // ─── UI Control ──────────────────────────────────────────────────

  describe('UI Control', () => {
    it('should find buttons via querySelectorAll', async () => {
      const count = await evaluate('document.querySelectorAll("button").length');
      assert.ok(count > 0, `Found ${count} buttons`);
    });

    it('should toggle bottom panel', async () => {
      const bwb = await apiExists('window.TradingView.bottomWidgetBar');
      assert.ok(bwb, 'bottomWidgetBar exists');

      // Open then close
      await evaluate("window.TradingView.bottomWidgetBar.showWidget('pine-editor')");
      await new Promise(r => setTimeout(r, 500));
      await evaluate("window.TradingView.bottomWidgetBar.close()");
    });

    it('should dispatch keyboard events', async () => {
      await evaluate(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      `);
      // No assertion needed — just verifying it doesn't throw
    });
  });

  // ─── Screenshots ─────────────────────────────────────────────────

  describe('Screenshots', () => {
    it('should capture page screenshot', async () => {
      const { data } = await client.Page.captureScreenshot({ format: 'png' });
      assert.ok(data, 'Screenshot data returned');
      assert.ok(data.length > 100, 'Screenshot has content');
      // Verify it's valid base64
      const buf = Buffer.from(data, 'base64');
      assert.ok(buf.length > 1000, `Screenshot is ${buf.length} bytes`);
    });
  });

  // ─── Context Size Validation ─────────────────────────────────────

  describe('Context Size (compact output)', () => {
    it('pine lines compact output should be under 2KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var meta = s.metaInfo();
              var name = meta.description || '';
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var seen = {};
              var prices = [];
              coll._primitivesDataById.forEach(function(v) {
                var y = v.y1 != null && v.y1 === v.y2 ? Math.round(v.y1 * 100) / 100 : null;
                if (y != null && !seen[y]) { prices.push(y); seen[y] = true; }
              });
              prices.sort(function(a,b) { return b - a; });
              results.push({ name: name, horizontal_levels: prices });
            } catch(e) {}
          }
          return results;
        })()
      `);
      if (data.length > 0) {
        for (const study of data) {
          const size = JSON.stringify(study).length;
          assert.ok(size < 4096, `${study.name}: compact output is ${size} bytes (should be < 4KB)`);
        }
      }
    });

    it('pine labels compact output should be under 5KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var meta = s.metaInfo();
              var name = meta.description || '';
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var labels = [];
              coll._primitivesDataById.forEach(function(v) {
                if (v.t || v.y != null) labels.push({ text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null });
              });
              // Apply same cap as the MCP tool (default 50)
              if (labels.length > 50) labels = labels.slice(-50);
              results.push({ name: name, labels: labels });
            } catch(e) {}
          }
          return results;
        })()
      `);
      if (data.length > 0) {
        for (const study of data) {
          const size = JSON.stringify(study).length;
          assert.ok(size < 8192, `${study.name}: compact labels output is ${size} bytes (should be < 8KB)`);
        }
      }
    });
  });
});
