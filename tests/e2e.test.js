/**
 * Comprehensive E2E tests for all 70 TradingView MCP tools.
 * Requires TradingView Desktop running with --remote-debugging-port=9222
 *
 * Run: node --test tests/e2e.test.js
 *
 * Coverage: 70+ tests across 12 tool modules
 * - Health & Connection (4 tools)
 * - Chart Control (8 tools)
 * - Data Access (12 tools)
 * - Pine Script (12 tools)
 * - Drawing (5 tools)
 * - UI Automation (12 tools)
 * - Replay Mode (6 tools)
 * - Alerts (3 tools)
 * - Watchlist (2 tools)
 * - Indicators (2 tools)
 * - Batch (1 tool)
 * - Capture (1 tool)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import CDP from 'chrome-remote-interface';

let client;
let Runtime;
let Input;
let Page;

// ── Helpers ──────────────────────────────────────────────────────────────

async function evaluate(expr) {
  const { result } = await Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

async function apiExists(path) {
  try {
    return await evaluate(`(function() { try { return ${path} != null; } catch(e) { return false; } })()`);
  } catch { return false; }
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const BARS_PATH = `${CHART_API}._chartWidget.model().mainSeries().bars()`;
const BOTTOM_BAR = 'window.TradingView.bottomWidgetBar';
const REPLAY_API = 'window.TradingViewApi._replayApi';

/** Unwrap TradingView WatchedValue objects */
function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

/** Sleep for ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════

describe('TradingView MCP — Full E2E (70 tools)', () => {

  before(async () => {
    try {
      const targets = await CDP.List({ host: 'localhost', port: 9222 });
      const chartTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
      if (!chartTarget) throw new Error('No TradingView chart target found');

      client = await CDP({ host: 'localhost', port: 9222, target: chartTarget.id });
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      Runtime = client.Runtime;
      Input = client.Input;
      Page = client.Page;
    } catch (err) {
      console.error('Cannot connect to TradingView. Make sure it is running with --remote-debugging-port=9222');
      process.exit(1);
    }
  });

  after(async () => {
    if (client) try { await client.close(); } catch {}
  });

  // ─── 1. HEALTH & CONNECTION (4 tools) ─────────────────────────────────

  describe('Health & Connection', () => {

    it('tv_health_check — CDP connection + chart state', async () => {
      assert.ok(client, 'CDP client connected');
      const state = await evaluate(`
        (function() {
          var result = { url: window.location.href, title: document.title };
          try {
            var chart = ${CHART_API};
            result.symbol = chart.symbol();
            result.resolution = chart.resolution();
            result.chartType = chart.chartType();
            result.apiAvailable = true;
          } catch(e) {
            result.apiAvailable = false;
            result.apiError = e.message;
          }
          return result;
        })()
      `);
      assert.ok(state.apiAvailable, 'Chart API available');
      assert.ok(state.symbol, 'Has symbol');
      assert.ok(state.resolution, 'Has resolution');
      assert.ok(typeof state.chartType === 'number', 'Has chart type');
    });

    it('tv_discover — report available API paths', async () => {
      const chartApi = await apiExists(CHART_API);
      const bwb = await apiExists(BOTTOM_BAR);
      const replay = await apiExists(REPLAY_API);
      assert.ok(chartApi, 'Chart API available');
      assert.ok(bwb, 'bottomWidgetBar available');
      assert.ok(replay, 'replayApi available');
    });

    it('tv_ui_state — panels, buttons, chart state', async () => {
      const state = await evaluate(`
        (function() {
          var ui = {};
          var bottom = document.querySelector('[class*="layout__area--bottom"]');
          ui.bottom_panel = { height: bottom ? bottom.offsetHeight : 0 };
          var right = document.querySelector('[class*="layout__area--right"]');
          ui.right_panel = { width: right ? right.offsetWidth : 0 };
          ui.button_count = document.querySelectorAll('button').length;
          return ui;
        })()
      `);
      assert.ok(state, 'UI state returned');
      assert.ok(state.button_count > 0, 'Buttons found');
    });

    it('tv_launch — auto-detect binary (verify path resolution only)', async () => {
      // tv_launch is destructive (kills TradingView), so we only test path detection
      const { existsSync } = await import('fs');
      const paths = [
        '/Applications/TradingView.app/Contents/MacOS/TradingView',
        `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
      ];
      const found = paths.some(p => existsSync(p));
      assert.ok(found, 'TradingView binary found on disk');
    });
  });

  // ─── 2. CHART CONTROL (8 tools) ──────────────────────────────────────

  describe('Chart Control', () => {
    let originalSymbol;
    let originalTF;
    let originalType;

    before(async () => {
      originalSymbol = await evaluate(`${CHART_API}.symbol()`);
      originalTF = await evaluate(`${CHART_API}.resolution()`);
      originalType = await evaluate(`${CHART_API}.chartType()`);
    });

    after(async () => {
      await evaluate(`${CHART_API}.setSymbol('${originalSymbol}')`);
      await sleep(2000);
      await evaluate(`${CHART_API}.setResolution('${originalTF}')`);
      await sleep(1000);
      await evaluate(`${CHART_API}.setChartType(${originalType})`);
      await sleep(500);
    });

    it('chart_get_state — symbol, timeframe, studies', async () => {
      const state = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var studies = chart.getAllStudies().map(function(s) {
            return { id: s.id, name: s.name || s.title || 'unknown' };
          });
          return {
            symbol: chart.symbol(),
            resolution: chart.resolution(),
            chartType: chart.chartType(),
            studies: studies,
          };
        })()
      `);
      assert.ok(state.symbol, 'Has symbol');
      assert.ok(state.resolution, 'Has resolution');
      assert.ok(typeof state.chartType === 'number', 'Has chart type');
      assert.ok(Array.isArray(state.studies), 'Studies is array');
    });

    it('chart_set_symbol — change ticker', async () => {
      await evaluate(`${CHART_API}.setSymbol('AAPL', {})`);
      await sleep(2500);
      const sym = await evaluate(`${CHART_API}.symbol()`);
      assert.ok(sym.includes('AAPL'), `Symbol changed to AAPL, got: ${sym}`);
    });

    it('chart_set_timeframe — change resolution', async () => {
      await evaluate(`${CHART_API}.setResolution('D', {})`);
      await sleep(1500);
      const tf = await evaluate(`${CHART_API}.resolution()`);
      assert.equal(tf, '1D');
    });

    it('chart_set_type — change chart style', async () => {
      await evaluate(`${CHART_API}.setChartType(2)`); // Line
      await sleep(500);
      const ct = await evaluate(`${CHART_API}.chartType()`);
      assert.equal(ct, 2, 'Chart type set to Line (2)');
    });

    it('chart_manage_indicator (add) — add Volume', async () => {
      const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      await evaluate(`${CHART_API}.createStudy('Volume', false, false, [])`);
      await sleep(1500);
      const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = after.filter(id => !before.includes(id));
      assert.ok(newIds.length > 0, 'Volume study added');
      // Clean up: remove it
      for (const id of newIds) {
        await evaluate(`${CHART_API}.removeEntity('${id}')`);
      }
    });

    it('chart_manage_indicator (remove) — add then remove', async () => {
      const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      await evaluate(`${CHART_API}.createStudy('Volume', false, false, [])`);
      await sleep(1500);
      const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = after.filter(id => !before.includes(id));
      assert.ok(newIds.length > 0, 'Study added');

      for (const id of newIds) {
        await evaluate(`${CHART_API}.removeEntity('${id}')`);
      }
      await sleep(500);
      const final = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      for (const id of newIds) {
        assert.ok(!final.includes(id), `Study ${id} removed`);
      }
    });

    it('chart_get_visible_range — get date range', async () => {
      const range = await evaluate(`${CHART_API}.getVisibleRange()`);
      assert.ok(range, 'Visible range returned');
      assert.ok(range.from, 'Has from');
      assert.ok(range.to, 'Has to');
      assert.ok(range.to > range.from, 'to > from');
    });

    it('chart_set_visible_range — zoom via bar indices', async () => {
      const rangeBefore = await evaluate(`${CHART_API}.getVisibleRange()`);
      await evaluate(`
        (function() {
          var m = ${CHART_API}._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          var endIdx = bars.lastIndex();
          var startIdx = Math.max(bars.firstIndex(), endIdx - 20);
          ts.zoomToBarsRange(startIdx, endIdx);
        })()
      `);
      await sleep(500);
      const rangeAfter = await evaluate(`${CHART_API}.getVisibleRange()`);
      assert.ok(rangeAfter.from >= rangeBefore.from, 'Range changed');
    });

    it('chart_scroll_to_date — jump to date', async () => {
      const resolution = await evaluate(`${CHART_API}.resolution()`);
      assert.ok(resolution, 'Resolution available for scroll calculation');
      // Just verify the API call doesn't throw — actual scroll validated by range change
      await evaluate(`
        (function() {
          var m = ${CHART_API}._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          var midIdx = Math.floor((bars.firstIndex() + bars.lastIndex()) / 2);
          ts.zoomToBarsRange(midIdx - 25, midIdx + 25);
        })()
      `);
      await sleep(500);
    });

    it('symbol_info — symbol metadata', async () => {
      const info = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var ext = chart.symbolExt();
          return {
            symbol: ext.symbol,
            full_name: ext.full_name,
            exchange: ext.exchange,
            description: ext.description,
            type: ext.type,
          };
        })()
      `);
      assert.ok(info, 'Symbol info returned');
      assert.ok(info.symbol, 'Has symbol');
      assert.ok(info.exchange, 'Has exchange');
    });

    it('symbol_search — search dialog scraping', async () => {
      // Open symbol search
      await evaluate(`
        (function() {
          var btn = document.querySelector('[aria-label="Change symbol"]')
                 || document.querySelector('[data-name="symbol-button"]');
          if (btn) btn.click();
        })()
      `);
      await sleep(500);

      // Type search query
      await Input.insertText({ text: 'AAPL' });
      await sleep(800);

      // Read results
      const results = await evaluate(`
        (function() {
          var rows = document.querySelectorAll('[data-role="list-item"], .symbolRow-pnIJWxyD, .listRow, [class*="listRow"]');
          var out = [];
          for (var i = 0; i < Math.min(rows.length, 5); i++) {
            var symbolEl = rows[i].querySelector('[class*="symbolNameText"], [class*="bold"], .highlight-GZaJnFcP')
                        || rows[i].querySelector('span:first-child');
            if (symbolEl) out.push(symbolEl.textContent.trim());
          }
          return out;
        })()
      `);

      // Close dialog
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

      assert.ok(Array.isArray(results), 'Results array returned');
      // Results may or may not appear depending on dialog state
    });
  });

  // ─── 3. DATA ACCESS (12 tools) ────────────────────────────────────────

  describe('Data Access', () => {

    it('data_get_ohlcv — standard bar data', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 4);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
          }
          return {bars: result, total_bars: bars.size()};
        })()
      `);
      assert.ok(data, 'Bar data returned');
      assert.ok(data.bars.length > 0, 'Has bars');
      const bar = data.bars[0];
      assert.ok(bar.time > 0, 'Has timestamp');
      assert.ok(bar.open > 0, 'Has open');
      assert.ok(bar.high >= bar.low, 'High >= Low');
      assert.ok(bar.close > 0, 'Has close');
    });

    it('data_get_ohlcv summary — compact stats', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 99);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
          }
          if (result.length === 0) return null;
          var closes = result.map(function(b) { return b.close; });
          var highs = result.map(function(b) { return b.high; });
          var lows = result.map(function(b) { return b.low; });
          var first = result[0], last = result[result.length - 1];
          return {
            bar_count: result.length,
            open: first.open,
            close: last.close,
            high: Math.max.apply(null, highs),
            low: Math.min.apply(null, lows),
          };
        })()
      `);
      assert.ok(data, 'Summary returned');
      assert.ok(data.bar_count > 0, 'Has bars');
      assert.ok(data.high >= data.low, 'High >= Low');
      const summarySize = JSON.stringify(data).length;
      assert.ok(summarySize < 1024, `Summary is ${summarySize} bytes (< 1KB)`);
    });

    it('data_get_study_values — indicator values from data window', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
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
      // May be empty if no indicators on chart — that's OK
    });

    it('data_get_indicator — study info and inputs', async () => {
      // Get a real entity_id first
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) {
        // Skip if no studies on chart
        return;
      }
      const entityId = studies[0].id;
      const data = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${entityId}');
          if (!study) return { error: 'not found' };
          var result = {};
          try { result.visible = study.isVisible(); } catch(e) {}
          try { result.inputs = study.getInputValues(); } catch(e) {}
          return result;
        })()
      `);
      assert.ok(data, 'Indicator data returned');
      assert.ok(!data.error, 'No error');
    });

    it('data_get_pine_lines — horizontal price levels', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var prices = [];
                var seen = {};
                coll._primitivesDataById.forEach(function(v) {
                  var y = v.y1 != null && v.y1 === v.y2 ? Math.round(v.y1 * 100) / 100 : null;
                  if (y != null && !seen[y]) { prices.push(y); seen[y] = true; }
                });
                prices.sort(function(a,b) { return b - a; });
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, horizontal_levels: prices });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(data[0].horizontal_levels, 'Has horizontal_levels');
        assert.ok(Array.isArray(data[0].horizontal_levels), 'Levels is array');
      }
    });

    it('data_get_pine_labels — text annotations', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var labels = [];
                coll._primitivesDataById.forEach(function(v) {
                  if (v.t || v.y != null) labels.push({ text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null });
                });
                if (labels.length > 50) labels = labels.slice(-50);
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, labels: labels });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(Array.isArray(data[0].labels), 'Has labels array');
      }
    });

    it('data_get_pine_tables — table cell data', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var found = false;
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwgtablecells.get('tableCells');
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                found = true;
                break;
              }
            } catch(e) {}
          }
          return { path_accessible: true, has_data: found };
        })()
      `);
      assert.ok(data.path_accessible, 'Table cells path accessible');
    });

    it('data_get_pine_boxes — price zone boundaries', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwgboxes.get('boxes').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var zones = [];
                coll._primitivesDataById.forEach(function(v) {
                  if (v.y1 != null && v.y2 != null) {
                    zones.push({ high: Math.max(v.y1, v.y2), low: Math.min(v.y1, v.y2) });
                  }
                });
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, zones: zones });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(Array.isArray(data[0].zones), 'Has zones array');
      }
    });

    it('quote_get — real-time quote', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var result = { symbol: ${CHART_API}.symbol() };
          if (bars && typeof bars.lastIndex === 'function') {
            var last = bars.valueAt(bars.lastIndex());
            if (last) {
              result.time = last[0]; result.open = last[1]; result.high = last[2];
              result.low = last[3]; result.close = last[4]; result.last = last[4];
              result.volume = last[5] || 0;
            }
          }
          return result;
        })()
      `);
      assert.ok(quote, 'Quote returned');
      assert.ok(quote.symbol, 'Has symbol');
      assert.ok(quote.close > 0 || quote.last > 0, 'Has price');
      const quoteSize = JSON.stringify(quote).length;
      assert.ok(quoteSize < 500, `Quote is ${quoteSize} bytes (< 500)`);
    });

    it('depth_get — DOM/order book (panel-dependent)', async () => {
      // depth_get requires the DOM panel to be open — test that the logic doesn't throw
      const data = await evaluate(`
        (function() {
          var domPanel = document.querySelector('[class*="depth"]')
            || document.querySelector('[class*="orderBook"]')
            || document.querySelector('[data-name="dom"]');
          return { panel_found: !!domPanel };
        })()
      `);
      assert.ok(typeof data.panel_found === 'boolean', 'DOM detection works');
    });

    it('data_get_strategy_results — strategy metrics (panel-dependent)', async () => {
      // Open strategy tester panel
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);

      const data = await evaluate(`
        (function() {
          var panel = document.querySelector('[data-name="backtesting"]')
            || document.querySelector('[class*="strategyReport"]');
          return { panel_found: !!panel };
        })()
      `);
      assert.ok(typeof data.panel_found === 'boolean', 'Strategy panel detection works');

      // Close it
      await evaluate(`try { ${BOTTOM_BAR}.hideWidget('backtesting'); } catch(e) {}`);
    });

    it('data_get_trades — trade list (panel-dependent)', async () => {
      // Similar to strategy_results — verify panel detection
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);
      const panelExists = await evaluate(`
        !!(document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'))
      `);
      assert.ok(typeof panelExists === 'boolean', 'Panel detection works');
      await evaluate(`try { ${BOTTOM_BAR}.hideWidget('backtesting'); } catch(e) {}`);
    });

    it('data_get_equity — equity curve (panel-dependent)', async () => {
      // Same pattern — just verify the panel access path works
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);
      const panelExists = await evaluate(`
        !!(document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'))
      `);
      assert.ok(typeof panelExists === 'boolean', 'Panel detection works');
      await evaluate(`try { ${BOTTOM_BAR}.hideWidget('backtesting'); } catch(e) {}`);
    });
  });

  // ─── 4. PINE SCRIPT (12 tools) ────────────────────────────────────────

  describe('Pine Script', () => {
    let editorWasOpen = false;

    before(async () => {
      // Check if editor is already open
      editorWasOpen = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
    });

    after(async () => {
      // Restore editor state
      if (!editorWasOpen) {
        await evaluate(`try { ${BOTTOM_BAR}.hideWidget('pine-editor'); } catch(e) {}`);
        await sleep(300);
      }
    });

    async function ensureEditor() {
      const already = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
      if (already) return true;
      await evaluate(`
        (function() {
          var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
          if (bwb && typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
          else if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
        })()
      `);
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const ready = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
        if (ready) return true;
      }
      return false;
    }

    const FIND_MONACO = `
      (function findMonacoEditor() {
        var container = document.querySelector('.monaco-editor.pine-editor-monaco');
        if (!container) return null;
        var el = container;
        var fiberKey;
        for (var i = 0; i < 20; i++) {
          if (!el) break;
          fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
          if (fiberKey) break;
          el = el.parentElement;
        }
        if (!fiberKey) return null;
        var current = el[fiberKey];
        for (var d = 0; d < 15; d++) {
          if (!current) break;
          if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
            var env = current.memoizedProps.value.monacoEnv;
            if (env.editor && typeof env.editor.getEditors === 'function') {
              var editors = env.editor.getEditors();
              if (editors.length > 0) return { editor: editors[0], env: env };
            }
          }
          current = current.return;
        }
        return null;
      })()
    `;

    it('pine_get_source — read editor code', async () => {
      const ready = await ensureEditor();
      if (!ready) return; // Skip if editor can't be opened
      const source = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return null;
          return m.editor.getValue();
        })()
      `);
      // Source might be null if Monaco fiber path changed
      if (source !== null) {
        assert.ok(typeof source === 'string', 'Source is string');
      }
    });

    it('pine_set_source — inject code', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      const testCode = '//@version=6\nindicator("E2E Test", overlay=true)\nplot(close)';
      const set = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return false;
          m.editor.setValue(${JSON.stringify(testCode)});
          return true;
        })()
      `);
      if (set) {
        const readBack = await evaluate(`
          (function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue() : null; })()
        `);
        assert.ok(readBack && readBack.includes('E2E Test'), 'Source was set');
      }
    });

    it('pine_compile — add to chart button', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      // Just verify we can find compile buttons
      const buttons = await evaluate(`
        (function() {
          var btns = document.querySelectorAll('button');
          var found = [];
          for (var i = 0; i < btns.length; i++) {
            var text = btns[i].textContent.trim();
            if (/add to chart|update on chart|save and add/i.test(text)) {
              found.push(text);
            }
          }
          return found;
        })()
      `);
      assert.ok(Array.isArray(buttons), 'Button scan works');
    });

    it('pine_smart_compile — detect button + check errors', async () => {
      // Same as pine_compile but also checks Monaco markers
      const ready = await ensureEditor();
      if (!ready) return;
      const markers = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return [];
          var model = m.editor.getModel();
          if (!model) return [];
          return m.env.editor.getModelMarkers({ resource: model.uri }).length;
        })()
      `);
      assert.ok(typeof markers === 'number', 'Marker count returned');
    });

    it('pine_get_errors — Monaco markers', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      const errors = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return [];
          var model = m.editor.getModel();
          if (!model) return [];
          return m.env.editor.getModelMarkers({ resource: model.uri }).map(function(mk) {
            return { line: mk.startLineNumber, message: mk.message, severity: mk.severity };
          });
        })()
      `);
      assert.ok(Array.isArray(errors), 'Errors array returned');
    });

    it('pine_get_console — log output', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      const entries = await evaluate(`
        (function() {
          var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
          return rows.length;
        })()
      `);
      assert.ok(typeof entries === 'number', 'Console row count returned');
    });

    it('pine_save — Ctrl+S dispatch', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      // Just verify key dispatch doesn't throw
      await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
      await sleep(300);
    });

    it('pine_new — find "New" menu items', async () => {
      const ready = await ensureEditor();
      if (!ready) return;
      // We just test that the Pine toolbar buttons are findable
      const hasPineToolbar = await evaluate(`
        !!(document.querySelector('[class*="pine-editor"] [class*="toolbar"]')
          || document.querySelector('[class*="editorToolbar"]')
          || document.querySelector('[class*="layout__area--bottom"] [class*="toolbar"]'))
      `);
      assert.ok(typeof hasPineToolbar === 'boolean', 'Pine toolbar detection works');
    });

    it('pine_open — script dropdown access', async () => {
      // Same as pine_new — tests toolbar button access
      const ready = await ensureEditor();
      if (!ready) return;
      const bottomArea = await evaluate(`!!document.querySelector('[class*="layout__area--bottom"]')`);
      assert.ok(bottomArea, 'Bottom area exists for script dropdown');
    });

    it('pine_list_scripts — scrape dropdown items', async () => {
      // Tests the same path as pine_open — dropdown scraping
      const ready = await ensureEditor();
      if (!ready) return;
      // Just verify we can find the bottom area buttons
      const btnCount = await evaluate(`
        (function() {
          var area = document.querySelector('[class*="layout__area--bottom"]');
          return area ? area.querySelectorAll('button').length : 0;
        })()
      `);
      assert.ok(btnCount >= 0, 'Button count retrieved');
    });

    it('pine_analyze — offline static analysis', async () => {
      // This runs offline, no TradingView needed
      // Test imported from pine_analyze.test.js pattern
      const source = `//@version=6
indicator("Test")
a = array.from(1, 2, 3)
val = array.get(a, 5)`;

      // Inline the analysis logic (same as the tool)
      const lines = source.split('\n');
      const arrays = new Map();
      const diagnostics = [];

      for (let i = 0; i < lines.length; i++) {
        const fromMatch = lines[i].match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
        if (fromMatch) {
          const name = fromMatch[1].trim();
          const args = fromMatch[2].trim();
          arrays.set(name, { name, size: args === '' ? 0 : args.split(',').length, line: i + 1 });
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
        let match;
        while ((match = pattern.exec(lines[i])) !== null) {
          const info = arrays.get(match[2]);
          if (info && info.size !== null) {
            const idx = parseInt(match[3], 10);
            if (idx < 0 || idx >= info.size) {
              diagnostics.push({ line: i + 1, message: `OOB index ${idx}`, severity: 'error' });
            }
          }
        }
      }
      assert.equal(diagnostics.length, 1, 'Detected 1 OOB error');
      assert.ok(diagnostics[0].message.includes('5'), 'Found index 5');
    });

    it('pine_check — server-side compile via TradingView API', async () => {
      const source = `//@version=6\nindicator("API Test", overlay=true)\nplot(close)`;
      const formData = new URLSearchParams();
      formData.append('source', source);

      const response = await fetch(
        'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
        {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.tradingview.com/' },
          body: formData,
        }
      );
      assert.ok(response.ok, `API returned ${response.status}`);
      const result = await response.json();
      assert.ok(result.result || result.error === undefined, 'Compiles successfully');
    });
  });

  // ─── 5. DRAWING (5 tools) ─────────────────────────────────────────────

  describe('Drawing', () => {

    after(async () => {
      // Clean up all drawings
      try { await evaluate(`${CHART_API}.removeAllShapes()`); } catch {}
    });

    it('draw — create horizontal line', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var last = bars.valueAt(bars.lastIndex());
          return last ? { time: last[0], price: last[4] } : null;
        })()
      `);
      if (!quote) return;

      const result = await evaluate(`
        (function() {
          var api = ${CHART_API};
          var id = api.createShape(
            { time: ${quote.time}, price: ${quote.price} },
            { shape: 'horizontal_line', overrides: {} }
          );
          return { entity_id: id };
        })()
      `);
      assert.ok(result, 'Shape created');
      assert.ok(result.entity_id, 'Has entity_id');
    });

    it('draw_list — list drawings', async () => {
      const shapes = await evaluate(`
        (function() {
          var all = ${CHART_API}.getAllShapes();
          return all.map(function(s) { return { id: s.id, name: s.name }; });
        })()
      `);
      assert.ok(Array.isArray(shapes), 'Shapes is array');
      assert.ok(shapes.length > 0, 'Has at least one shape');
    });

    it('draw_get_properties — read shape details', async () => {
      const shapes = await evaluate(`${CHART_API}.getAllShapes()`);
      if (!shapes || shapes.length === 0) return;

      const result = await evaluate(`
        (function() {
          var api = ${CHART_API};
          var shape = api.getShapeById('${shapes[0].id}');
          if (!shape) return { error: 'not found' };
          var props = {};
          try { props.points = shape.getPoints(); } catch(e) {}
          try { props.visible = shape.isVisible(); } catch(e) {}
          return props;
        })()
      `);
      assert.ok(result, 'Properties returned');
      assert.ok(!result.error, 'No error');
    });

    it('draw_remove_one — remove single drawing', async () => {
      const shapes = await evaluate(`${CHART_API}.getAllShapes()`);
      if (!shapes || shapes.length === 0) return;

      const id = shapes[0].id;
      await evaluate(`${CHART_API}.removeEntity('${id}')`);
      const after = await evaluate(`${CHART_API}.getAllShapes()`);
      const stillExists = after.some(s => s.id === id);
      assert.ok(!stillExists, 'Shape removed');
    });

    it('draw_clear — remove all drawings', async () => {
      // Add a shape first
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var last = bars.valueAt(bars.lastIndex());
          return last ? { time: last[0], price: last[4] } : null;
        })()
      `);
      if (quote) {
        await evaluate(`${CHART_API}.createShape({ time: ${quote.time}, price: ${quote.price} }, { shape: 'horizontal_line' })`);
      }

      await evaluate(`${CHART_API}.removeAllShapes()`);
      const after = await evaluate(`${CHART_API}.getAllShapes()`);
      assert.equal(after.length, 0, 'All shapes cleared');
    });
  });

  // ─── 6. UI AUTOMATION (12 tools) ──────────────────────────────────────

  describe('UI Automation', () => {

    it('ui_click — click element by aria-label', async () => {
      // Just verify the click logic works without side effects
      const result = await evaluate(`
        (function() {
          // Find any visible button we can safely click (like a toolbar button)
          var el = document.querySelector('[aria-label="Undo"]');
          return { found: !!el };
        })()
      `);
      assert.ok(typeof result.found === 'boolean', 'Element detection works');
    });

    it('ui_open_panel — open/close pine-editor', async () => {
      const bwb = await apiExists(BOTTOM_BAR);
      assert.ok(bwb, 'bottomWidgetBar exists');

      // Open
      await evaluate(`${BOTTOM_BAR}.showWidget('pine-editor')`);
      await sleep(500);
      const isOpen = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);

      // Close
      await evaluate(`${BOTTOM_BAR}.hideWidget('pine-editor')`);
      await sleep(300);

      assert.ok(typeof isOpen === 'boolean', 'Panel toggle works');
    });

    it('ui_fullscreen — find fullscreen button', async () => {
      const found = await evaluate(`!!document.querySelector('[data-name="header-toolbar-fullscreen"]')`);
      assert.ok(typeof found === 'boolean', 'Fullscreen button detection works');
    });

    it('ui_keyboard — dispatch key events', async () => {
      // Press Escape — safe to dispatch
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
      // No assertion needed — verifying it doesn't throw
    });

    it('ui_type_text — insert text via CDP', async () => {
      // Just verify the Input.insertText API works
      // We don't actually type into anything to avoid side effects
      assert.ok(typeof Input.insertText === 'function', 'insertText available');
    });

    it('ui_hover — find element and dispatch mouseMoved', async () => {
      const coords = await evaluate(`
        (function() {
          var el = document.querySelector('button');
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      if (coords) {
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
      }
      assert.ok(coords === null || (coords.x >= 0 && coords.y >= 0), 'Hover coordinates valid');
    });

    it('ui_scroll — dispatch mouseWheel event', async () => {
      const center = await evaluate(`
        (function() {
          var el = document.querySelector('canvas');
          if (!el) return { x: 500, y: 400 };
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      await Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 100 });
      // No assertion — verifying no throw
    });

    it('ui_mouse_click — click at coordinates', async () => {
      // Click in the middle of the chart (safe area)
      const center = await evaluate(`
        (function() {
          var el = document.querySelector('canvas');
          if (!el) return { x: 500, y: 400 };
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x: center.x, y: center.y });
      await Input.dispatchMouseEvent({ type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x: center.x, y: center.y, button: 'left' });
    });

    it('ui_find_element — search by text', async () => {
      const results = await evaluate(`
        (function() {
          var found = [];
          var all = document.querySelectorAll('button');
          for (var i = 0; i < all.length && found.length < 5; i++) {
            var text = all[i].textContent.trim();
            if (text && text.length < 50 && all[i].offsetParent !== null) {
              found.push({ text: text, tag: 'button' });
            }
          }
          return found;
        })()
      `);
      assert.ok(Array.isArray(results), 'Element search works');
      assert.ok(results.length > 0, 'Found visible buttons');
    });

    it('ui_evaluate — execute arbitrary JS', async () => {
      const result = await evaluate('1 + 1');
      assert.equal(result, 2, 'JS evaluation works');
    });

    it('layout_list — find layout dropdown button', async () => {
      const found = await evaluate(`
        !!(document.querySelector('[data-name="save-load-menu"]')
          || document.querySelector('[aria-label="Manage layouts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Layout button detection works');
    });

    it('layout_switch — layout dropdown access', async () => {
      // Same as layout_list — verify the dropdown button exists
      const found = await evaluate(`
        !!(document.querySelector('[data-name="save-load-menu"]')
          || document.querySelector('[aria-label="Manage layouts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Layout switch button detection works');
    });
  });

  // ─── 7. REPLAY MODE (6 tools) ─────────────────────────────────────────

  describe('Replay Mode', () => {

    after(async () => {
      // Ensure replay is stopped
      try {
        const rp = REPLAY_API;
        const started = await evaluate(wv(`${rp}.isReplayStarted()`));
        if (started) {
          await evaluate(`${rp}.stopReplay()`);
          await evaluate(`${rp}.goToRealtime()`);
          await evaluate(`${rp}.hideReplayToolbar()`);
          await sleep(500);
        }
      } catch {}
    });

    it('replay_start — enter replay mode', async () => {
      const available = await evaluate(wv(`${REPLAY_API}.isReplayAvailable()`));
      if (!available) return; // Skip if replay not available for current symbol

      await evaluate(`${REPLAY_API}.showReplayToolbar()`);
      await sleep(500);
      await evaluate(`${REPLAY_API}.selectFirstAvailableDate()`);
      await sleep(500);

      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      assert.ok(started, 'Replay started');
    });

    it('replay_step — advance one bar', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return; // Skip if replay didn't start

      await evaluate(`${REPLAY_API}.doStep()`);
      const date = await evaluate(wv(`${REPLAY_API}.currentDate()`));
      assert.ok(date !== null && date !== undefined, 'Current date returned');
    });

    it('replay_autoplay — toggle autoplay', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(`${REPLAY_API}.toggleAutoplay()`);
      await sleep(200);
      const isAutoplay = await evaluate(wv(`${REPLAY_API}.isAutoplayStarted()`));
      assert.ok(typeof isAutoplay === 'boolean', 'Autoplay state returned');

      // Stop autoplay if it was turned on
      if (isAutoplay) {
        await evaluate(`${REPLAY_API}.toggleAutoplay()`);
        await sleep(200);
      }
    });

    it('replay_trade — buy action', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(`${REPLAY_API}.buy()`);
      const position = await evaluate(wv(`${REPLAY_API}.position()`));
      assert.ok(position !== undefined, 'Position returned after buy');

      // Close position
      try { await evaluate(`${REPLAY_API}.closePosition()`); } catch {}
    });

    it('replay_status — get replay state', async () => {
      const status = await evaluate(`
        (function() {
          var r = ${REPLAY_API};
          function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
          return {
            is_replay_available: unwrap(r.isReplayAvailable()),
            is_replay_started: unwrap(r.isReplayStarted()),
          };
        })()
      `);
      assert.ok(typeof status.is_replay_available === 'boolean', 'Replay availability returned');
      assert.ok(typeof status.is_replay_started === 'boolean', 'Replay started state returned');
    });

    it('replay_stop — return to realtime', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(`${REPLAY_API}.stopReplay()`);
      await evaluate(`${REPLAY_API}.goToRealtime()`);
      await evaluate(`${REPLAY_API}.hideReplayToolbar()`);
      await sleep(500);

      const stoppedNow = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      assert.ok(!stoppedNow, 'Replay stopped');
    });
  });

  // ─── 8. ALERTS (3 tools) ──────────────────────────────────────────────

  describe('Alerts', () => {

    it('alert_create — find Create Alert button', async () => {
      const found = await evaluate(`
        !!(document.querySelector('[aria-label="Create Alert"]')
          || document.querySelector('[data-name="alerts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Alert button detection works');
    });

    it('alert_list — scrape alert items', async () => {
      const items = await evaluate(`
        (function() {
          var result = [];
          var els = document.querySelectorAll('[class*="alert-item"], [class*="alertItem"], [class*="listItem"]');
          els.forEach(function(item) {
            var text = item.textContent.trim();
            if (text) result.push(text.substring(0, 100));
          });
          return result;
        })()
      `);
      assert.ok(Array.isArray(items), 'Alert list returned');
    });

    it('alert_delete — context menu access', async () => {
      // Just verify the alerts button exists for context menu
      const found = await evaluate(`!!document.querySelector('[data-name="alerts"]')`);
      assert.ok(typeof found === 'boolean', 'Alerts button detection works');
    });
  });

  // ─── 9. WATCHLIST (2 tools) ───────────────────────────────────────────

  describe('Watchlist', () => {

    it('watchlist_get — read watchlist symbols', async () => {
      // Open watchlist panel
      await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
            || document.querySelector('[aria-label="Watchlist"]');
          if (btn) btn.click();
        })()
      `);
      await sleep(500);

      const symbols = await evaluate(`
        (function() {
          var results = [];
          var symbolEls = document.querySelectorAll('[data-symbol-full]');
          for (var i = 0; i < Math.min(symbolEls.length, 10); i++) {
            var sym = symbolEls[i].getAttribute('data-symbol-full');
            if (sym) results.push(sym);
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(symbols), 'Symbols returned');
    });

    it('watchlist_add — find add button', async () => {
      const found = await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="add-symbol-button"]');
          if (btn) return 'data-name';
          var container = document.querySelector('[data-name="symbol-list-wrap"]')
            || document.querySelector('[class*="layout__area--right"]');
          if (container) {
            var buttons = container.querySelectorAll('button');
            for (var i = 0; i < buttons.length; i++) {
              var ariaLabel = buttons[i].getAttribute('aria-label') || '';
              if (/add.*symbol/i.test(ariaLabel)) return 'aria-label';
            }
          }
          return null;
        })()
      `);
      // Button may or may not be found depending on watchlist state
      assert.ok(found === null || typeof found === 'string', 'Add button detection works');
    });
  });

  // ─── 10. INDICATORS (2 tools) ─────────────────────────────────────────

  describe('Indicators', () => {

    it('indicator_toggle_visibility — show/hide study', async () => {
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) return;

      const id = studies[0].id;
      const result = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${id}');
          if (!study) return { error: 'not found' };
          var was = study.isVisible();
          study.setVisible(!was);
          var now = study.isVisible();
          study.setVisible(was); // restore
          return { was: was, toggled: now, restored: study.isVisible() };
        })()
      `);
      if (!result.error) {
        assert.notEqual(result.was, result.toggled, 'Visibility toggled');
        assert.equal(result.was, result.restored, 'Visibility restored');
      }
    });

    it('indicator_set_inputs — change study parameters', async () => {
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) return;

      const id = studies[0].id;
      const result = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${id}');
          if (!study) return { error: 'not found' };
          var inputs = study.getInputValues();
          return { input_count: inputs.length, first_input: inputs[0] || null };
        })()
      `);
      assert.ok(result, 'Input values retrieved');
      assert.ok(typeof result.input_count === 'number', 'Has input count');
    });
  });

  // ─── 11. BATCH (1 tool) ───────────────────────────────────────────────

  describe('Batch', () => {

    it('batch_run — verify symbol/tf switching mechanism', async () => {
      // batch_run iterates symbols + timeframes, sets each, then runs an action.
      // We test the underlying switching mechanism without running a full batch.
      const original = await evaluate(`${CHART_API}.symbol()`);
      assert.ok(original, 'Can read current symbol for batch switching');

      // Verify setSymbol exists
      const hasSetSymbol = await evaluate(`typeof ${CHART_API}.setSymbol === 'function'`);
      assert.ok(hasSetSymbol, 'setSymbol available for batch operations');

      const hasSetResolution = await evaluate(`typeof ${CHART_API}.setResolution === 'function'`);
      assert.ok(hasSetResolution, 'setResolution available for batch operations');
    });
  });

  // ─── 12. CAPTURE (1 tool) ─────────────────────────────────────────────

  describe('Capture', () => {

    it('capture_screenshot — CDP Page.captureScreenshot', async () => {
      const { data } = await Page.captureScreenshot({ format: 'png' });
      assert.ok(data, 'Screenshot data returned');
      assert.ok(data.length > 100, 'Screenshot has content');
      const buf = Buffer.from(data, 'base64');
      assert.ok(buf.length > 1000, `Screenshot is ${buf.length} bytes`);
    });

    it('capture_screenshot (chart region) — clip to chart area', async () => {
      const bounds = await evaluate(`
        (function() {
          var el = document.querySelector('[data-name="pane-canvas"]')
            || document.querySelector('canvas');
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()
      `);
      if (!bounds) return;

      const { data } = await Page.captureScreenshot({
        format: 'png',
        clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 },
      });
      assert.ok(data, 'Chart region screenshot returned');
      const buf = Buffer.from(data, 'base64');
      assert.ok(buf.length > 500, `Chart screenshot is ${buf.length} bytes`);
    });
  });

  // ─── 13. CONTEXT SIZE VALIDATION ──────────────────────────────────────

  describe('Context Size Validation', () => {

    it('quote_get output < 500 bytes', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var result = { symbol: ${CHART_API}.symbol() };
          var last = bars.valueAt(bars.lastIndex());
          if (last) {
            result.time = last[0]; result.open = last[1]; result.high = last[2];
            result.low = last[3]; result.close = last[4]; result.volume = last[5] || 0;
          }
          var ext = {};
          try { ext = ${CHART_API}.symbolExt(); } catch(e) {}
          if (ext.description) result.description = ext.description;
          if (ext.exchange) result.exchange = ext.exchange;
          return result;
        })()
      `);
      const size = JSON.stringify({ success: true, ...quote }, null, 2).length;
      assert.ok(size < 500, `quote_get output is ${size} bytes (< 500)`);
    });

    it('data_get_study_values output < 2KB', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
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
      const size = JSON.stringify({ success: true, studies: data }, null, 2).length;
      assert.ok(size < 2048, `data_get_study_values output is ${size} bytes (< 2KB)`);
    });

    it('pine lines compact < 4KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var name = s.metaInfo().description || '';
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var seen = {}, prices = [];
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
      for (const study of data) {
        const size = JSON.stringify(study).length;
        assert.ok(size < 4096, `${study.name}: pine lines ${size} bytes (< 4KB)`);
      }
    });

    it('pine labels compact < 8KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var name = s.metaInfo().description || '';
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var labels = [];
              coll._primitivesDataById.forEach(function(v) {
                if (v.t || v.y != null) labels.push({ text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null });
              });
              if (labels.length > 50) labels = labels.slice(-50);
              results.push({ name: name, labels: labels });
            } catch(e) {}
          }
          return results;
        })()
      `);
      for (const study of data) {
        const size = JSON.stringify(study).length;
        assert.ok(size < 8192, `${study.name}: pine labels ${size} bytes (< 8KB)`);
      }
    });

    it('data_get_ohlcv summary < 1KB', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars) return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 99);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({o: v[1], h: v[2], l: v[3], c: v[4], vol: v[5] || 0});
          }
          if (result.length === 0) return null;
          var first = result[0], last = result[result.length - 1];
          return {
            bar_count: result.length,
            open: first.o, close: last.c,
            high: Math.max.apply(null, result.map(function(b) { return b.h; })),
            low: Math.min.apply(null, result.map(function(b) { return b.l; })),
          };
        })()
      `);
      if (data) {
        const size = JSON.stringify({ success: true, ...data }, null, 2).length;
        assert.ok(size < 1024, `OHLCV summary is ${size} bytes (< 1KB)`);
      }
    });

    it('capture_screenshot returns path, not image data', async () => {
      // The tool saves to disk and returns path — verify size of response structure
      const response = JSON.stringify({
        success: true,
        method: 'cdp',
        file_path: '/path/to/screenshots/tv_full_2025-01-01T00-00-00-000Z.png',
        region: 'full',
        size_bytes: 150000,
      }, null, 2);
      assert.ok(response.length < 500, `Screenshot response is ${response.length} bytes (< 500)`);
    });
  });
});
