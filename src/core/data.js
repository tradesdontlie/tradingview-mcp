/**
 * Core data access logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

/**
 * Pure helper: case-insensitive substring study-name match used by all
 * pine-graphics readers and getStudyValues. Empty/absent filter matches all.
 * Exported for unit testing the early-filter predicate without a CDP seam.
 */
export function studyMatchesFilter(name, filter) {
  if (!filter) return true;
  if (name == null) return false;
  return String(name).toLowerCase().indexOf(String(filter).toLowerCase()) !== -1;
}

/**
 * Pure helper: round a numeric study value to 2 decimals while KEEPING the
 * `number` type (no `.toFixed` stringification). Non-finite numbers return null.
 * Exported for unit testing.
 */
export function roundValue(v) {
  if (typeof v !== 'number') return v;
  if (!isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

// Map of pine-graphics primitive types → their (collection, mapKey) addresses
// in study._graphics._primitivesCollection. Used by buildGraphicsJS and
// buildAllGraphicsJS so the single-round-trip helper and per-reader helpers
// stay in sync.
const GRAPHICS_KINDS = {
  lines: { collection: 'dwglines', mapKey: 'lines' },
  labels: { collection: 'dwglabels', mapKey: 'labels' },
  tables: { collection: 'dwgtablecells', mapKey: 'tableCells' },
  boxes: { collection: 'dwgboxes', mapKey: 'boxes' },
};

// JS snippet (statements) shared by buildGraphicsJS / buildAllGraphicsJS that
// performs the EARLY case-insensitive filter on a source `s` and, on a match,
// resolves the study display name into `name`. Emits `continue` for skips so
// non-matching studies never reach the deep primitive walk.
const GRAPHICS_SOURCE_PRELUDE = `
        if (!s.metaInfo) continue;
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name) continue;
        if (filter && name.toLowerCase().indexOf(filter.toLowerCase()) === -1) continue;`;

// JS snippet that, given `pc` (primitivesCollection), `collName`, `mapKey`,
// and a `name` (for warnings), pushes parsed primitives into `items`.
function graphicsExtractSnippet() {
  return `
          var items = [];
          try {
            var outer = pc[collName];
            if (outer) {
              var inner = outer.get(mapKey);
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) { warnings.push({study: name, reason: 'primitives parse failed: ' + (e && e.message ? e.message : String(e))}); }
          if (items.length === 0 && collName === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) { warnings.push({study: name, reason: 'tableCells parse failed: ' + (e && e.message ? e.message : String(e))}); }
          }`;
}

export function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var warnings = [];
      var filter = ${safeString(filter || '')};
      var collName = ${safeString(collectionName)};
      var mapKey = ${safeString(mapKey)};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        // EARLY FILTER: skip non-matching studies before reading _graphics.
        ${GRAPHICS_SOURCE_PRELUDE}
        try {
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          ${graphicsExtractSnippet()}
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) { warnings.push({study: name || 'unknown', reason: 'study scan failed: ' + (e && e.message ? e.message : String(e))}); }
      }
      return { results: results, warnings: warnings };
    })()
  `;
}

/**
 * Builds a single evaluate() payload that extracts ALL four primitive types
 * ({lines, labels, tables, boxes}) for the (filtered) studies in ONE CDP
 * round-trip. The early filter runs once per source; the deep primitive walk
 * runs once per matched study (four kinds, no extra source iteration).
 */
function buildAllGraphicsJS(filter) {
  return `
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var KINDS = ${JSON.stringify(GRAPHICS_KINDS)};
      var out = { lines: [], labels: [], tables: [], boxes: [] };
      var warnings = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        // EARLY FILTER: skip non-matching studies before reading _graphics.
        ${GRAPHICS_SOURCE_PRELUDE}
        try {
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          for (var kind in KINDS) {
            if (!KINDS.hasOwnProperty(kind)) continue;
            var collName = KINDS[kind].collection;
            var mapKey = KINDS[kind].mapKey;
            ${graphicsExtractSnippet()}
            if (items.length > 0) out[kind].push({name: name, count: items.length, items: items});
          }
        } catch(e) { warnings.push({study: name || 'unknown', reason: 'study scan failed: ' + (e && e.message ? e.message : String(e))}); }
      }
      return { lines: out.lines, labels: out.labels, tables: out.tables, boxes: out.boxes, warnings: warnings };
    })()
  `;
}

/**
 * INTERNAL helper: fetch all four pine-graphics primitive types for the
 * (optionally filtered) studies in a single CDP evaluate(). Returns the raw
 * per-type arrays plus the collected warnings, so a caller that needs more
 * than one type (e.g. a full report pass) pays for ONE round-trip instead of
 * four. The four public readers below remain thin per-type wrappers for
 * backward compatibility, but can be re-pointed at this when only one
 * round-trip is desired.
 */
export async function getAllGraphics({ study_filter, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const payload = await evaluate(buildAllGraphicsJS(study_filter || ''));
  return {
    lines: payload?.lines || [],
    labels: payload?.labels || [],
    tables: payload?.tables || [],
    boxes: payload?.boxes || [],
    warnings: payload?.warnings || [],
  };
}

/**
 * Splits a single getAllGraphics() result into the same per-type tool outputs
 * the four readers return, in one round-trip. Warnings are attached to each
 * slice so `_warnings` behavior is preserved per type.
 */
export async function getAllGraphicsShaped({ study_filter, max_labels, verbose, _deps } = {}) {
  const all = await getAllGraphics({ study_filter, _deps });
  return {
    lines: shapeLines(all.lines, all.warnings, { verbose }),
    labels: shapeLabels(all.labels, all.warnings, { max_labels, verbose }),
    tables: shapeTables(all.tables, all.warnings),
    boxes: shapeBoxes(all.boxes, all.warnings, { verbose }),
  };
}

export async function getOhlcv({ count, summary, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  // Let evaluate() errors (CDP drop, moved API path, page error) propagate so
  // the real cause reaches the caller. The "chart may still be loading" hint is
  // reserved for the case where extraction SUCCEEDED but returned no bars.
  const data = await evaluate(`
    (function() {
      var bars = ${BARS_PATH};
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var result = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
      }
      return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
    })()
  `);

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id, _deps }) {
  const { evaluate } = _resolve(_deps);
  // Built-in studies (Moving Average, RSI, etc.) return [] from
  // study.getInputValues() — that API only populates for Pine scripts.
  // The properties().inputs.state() path works for both, so we read from
  // there and normalize to the same {id, value} array shape callers expect.
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: [], visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try {
        var inner = study._study;
        var mi = inner && inner.metaInfo && inner.metaInfo();
        result.name = (mi && (mi.description || mi.shortDescription)) || null;
      } catch(e) {}
      try {
        var state = study.properties().inputs.state();
        var arr = [];
        for (var k in state) {
          if (!state.hasOwnProperty(k)) continue;
          var entry = state[k];
          // Inputs are either Property objects ({id, value}) or raw values
          // (TV inlines string defaults like source="close"). Normalize.
          if (entry && typeof entry === 'object' && 'id' in entry) {
            arr.push({ id: entry.id, value: entry.value });
          } else {
            arr.push({ id: k, value: entry });
          }
        }
        result.inputs = arr;
      } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  // Trim payloads that include large encoded blobs (encrypted Pine inputs).
  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, name: data?.name, visible: data?.visible, inputs };
}

/**
 * Returns a JS snippet (statements, not an expression) that scans the active
 * chart's data sources for a strategy object and assigns it to `var strat`.
 * `predicate` is a JS boolean expression over a candidate source `s` selecting
 * which strategy-bearing fields qualify (e.g. 's.reportData || s.performance').
 * Shared by getStrategyResults/getTrades/getEquity so the scan lives in one place.
 */
export function findStrategy(predicate) {
  return `
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (${predicate})) { strat = s; break; }
        }`;
}

export async function getStrategyResults({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const results = await evaluate(`
    (function() {
      try {
        ${findStrategy('s.reportData || s.performance')}
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) { var keys = Object.keys(rd); for (var k = 0; k < keys.length; k++) { var val = rd[keys[k]]; if (val !== null && val !== undefined && typeof val !== 'function') metrics[keys[k]] = val; } }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { var pval = perf[pkeys[p]]; if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval; } }
        }
        return {metrics: metrics, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  if (results?.error) throw new Error(results.error);
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {} };
}

export async function getTrades({ max_trades, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        ${findStrategy('s.ordersData || s.reportData')}
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'ordersData() returned non-array.'};
        var result = [];
        for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  if (trades?.error) throw new Error(trades.error);
  return { success: true, trade_count: trades?.trades?.length || 0, source: trades?.source, trades: trades?.trades || [] };
}

export async function getEquity({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const equity = await evaluate(`
    (function() {
      try {
        ${findStrategy('s.reportData || s.performance')}
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  if (equity?.error) throw new Error(equity.error);
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note };
}

export async function getQuote({ symbol, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = ${safeString(symbol || '')};
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

/**
 * Builds the page-side study-values extraction snippet. Reads the LAST BAR value
 * of every plot in every study, directly from each study's computed series. We
 * deliberately don't use dataWindowView() here — that path mirrors the on-screen
 * "Data Window" sidebar, which only populates when the user's crosshair is over a
 * bar, so values were empty (or stale at whatever bar the cursor last hovered) for
 * headless callers. Reading from `_study.data()._items` gives a deterministic
 * current value; `entity_id` is included so callers can disambiguate studies that
 * share a name (e.g. two "Moving Average" with different lengths). Exported so the
 * streaming module reuses the EXACT same extraction (no drift from this surface).
 */
export function buildStudyValuesJS(filter) {
  return `
    (function() {
      var chart = ${CHART_API};
      var studies = chart.getAllStudies();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var i = 0; i < studies.length; i++) {
        var meta = studies[i];
        // EARLY FILTER: skip non-matching studies before reading series data.
        if (filter && (meta.name || '').toLowerCase().indexOf(filter.toLowerCase()) === -1) continue;
        try {
          var s = chart.getStudyById(meta.id);
          if (!s || !s._study) continue;
          var inner = s._study;
          var seriesData = inner.data && inner.data();
          var items = seriesData && seriesData._items;
          if (!items || items.length === 0) continue;
          var last = items[items.length - 1];
          var vals = last && last.value;
          if (!vals || vals.length < 2) continue;
          var mi = inner.metaInfo && inner.metaInfo();
          var plots = (mi && mi.plots) || [];
          var styles = (mi && mi.styles) || {};
          var values = {};
          // vals[0] is the bar time; vals[1..] are per-plot values in
          // metaInfo.plots declaration order. Skip plot types that carry
          // styling instead of data — colorer/bg_colorer plots produce ARGB
          // integers (e.g. 4285982208), shape/char/arrow plots produce
          // marker codes — neither is useful as a "current value" reading.
          var DATA_PLOT_TYPES = { line:1, line_break:1, area:1, histogram:1, stepline:1, cross:1, circles:1, columns:1, polyline:1 };
          for (var j = 0; j < plots.length; j++) {
            var v = vals[j + 1];
            if (v == null || v === '∅') continue;
            var plot = plots[j];
            if (plot.type && !DATA_PLOT_TYPES[plot.type]) continue;
            var style = styles[plot.id];
            if (style && style.isHidden) continue;
            var title = (style && style.title) || plot.id;
            if (typeof v === 'number') {
              if (!isFinite(v)) continue;
              // Return a NUMBER (rounded to 2 decimals), not a .toFixed string,
              // so consumers don't have to re-parse. BREAKING change vs prior
              // stringified output.
              v = Math.round(v * 100) / 100;
            }
            values[title] = v;
          }
          if (Object.keys(values).length > 0) {
            results.push({ entity_id: meta.id, name: meta.name, values: values });
          }
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getStudyValues({ study_filter, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const data = await evaluate(buildStudyValuesJS(study_filter));
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

// ── Pure shapers: turn raw {name, count, items} arrays into tool output. ──
// Shared by the per-type readers AND by getAllGraphics consumers so a single
// round-trip can be split client-side with identical output shape.

export function shapeLines(raw, warnings = [], { verbose } = {}) {
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [], ...(warnings.length && { _warnings: warnings }) };
  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies, ...(warnings.length && { _warnings: warnings }) };
}

export async function getPineLines({ study_filter, verbose, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const payload = await evaluate(buildGraphicsJS('dwglines', 'lines', study_filter || ''));
  return shapeLines(payload?.results || [], payload?.warnings || [], { verbose });
}

export function shapeLabels(raw, warnings = [], { max_labels, verbose } = {}) {
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [], ...(warnings.length && { _warnings: warnings }) };
  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies, ...(warnings.length && { _warnings: warnings }) };
}

export async function getPineLabels({ study_filter, max_labels, verbose, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const payload = await evaluate(buildGraphicsJS('dwglabels', 'labels', study_filter || ''));
  return shapeLabels(payload?.results || [], payload?.warnings || [], { max_labels, verbose });
}

export function shapeTables(raw, warnings = []) {
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [], ...(warnings.length && { _warnings: warnings }) };
  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies, ...(warnings.length && { _warnings: warnings }) };
}

export async function getPineTables({ study_filter, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const payload = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', study_filter || ''));
  return shapeTables(payload?.results || [], payload?.warnings || []);
}

export function shapeBoxes(raw, warnings = [], { verbose } = {}) {
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [], ...(warnings.length && { _warnings: warnings }) };
  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies, ...(warnings.length && { _warnings: warnings }) };
}

export async function getPineBoxes({ study_filter, verbose, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const payload = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', study_filter || ''));
  return shapeBoxes(payload?.results || [], payload?.warnings || [], { verbose });
}
