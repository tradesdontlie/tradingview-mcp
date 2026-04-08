/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
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
  } catch { data = null; }

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

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  // Phase 1: find strategy source and inspect its properties
  const inspection = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        // Strategy detection: ordersData is the definitive marker (only strategies have it)
        // Pass 1: check for ordersData (most reliable)
        for (var i = 0; i < sources.length; i++) {
          if (sources[i].ordersData) { strat = sources[i]; break; }
        }
        // Pass 2: check metaInfo for strategy markers
        if (!strat) {
          var skip = ['volume','dividends','splits','earnings','dates calculator'];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            try {
              if (!s.metaInfo) continue;
              var mi = s.metaInfo();
              var desc = (mi.description || mi.shortDescription || '').toLowerCase();
              var isBuiltIn = false;
              for (var sk = 0; sk < skip.length; sk++) { if (desc.indexOf(skip[sk]) !== -1) { isBuiltIn = true; break; } }
              if (isBuiltIn) continue;
              if (mi.pine && mi.pine.scriptType === 'strategy') { strat = s; break; }
              if (mi.scriptType === 'strategy') { strat = s; break; }
              // is_price_study=false AND has reportData → likely strategy
              if (mi.is_price_study === false && s.reportData) { strat = s; break; }
            } catch(e) {}
          }
        }
        if (!strat) return { found: false, error: 'No strategy found on chart.' };

        // Detect which properties exist and strategy state
        var has = {};
        var check = ['reportData','performance','strategyReport','_strategyReport','_report','reportManager'];
        for (var c = 0; c < check.length; c++) {
          if (strat[check[c]] !== undefined) has[check[c]] = typeof strat[check[c]];
        }
        var state = { completed: false, failed: false, loading: false };
        try { state.completed = strat.isCompleted(); } catch(e) {}
        try { state.failed = strat.isFailed(); } catch(e) {}
        try { state.loading = strat.isLoading(); } catch(e) {}
        return { found: true, has: has, state: state, source_count: sources.length };
      } catch(e) { return { found: false, error: e.message }; }
    })()
  `);

  if (!inspection || !inspection.found) {
    return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, error: inspection?.error || 'No strategy found on chart.' };
  }

  // Check strategy state — if failed or not completed, metrics won't be available
  const state = inspection.state || {};
  if (state.failed) {
    return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, error: 'Strategy is in failed state (compilation error or runtime error). Recompile the strategy.', state };
  }
  if (state.loading) {
    return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, error: 'Strategy is still loading/computing. Wait and retry.', state };
  }

  // Phase 2: extract metrics via reportData() — the authoritative source
  let metrics = {};
  const tried = [];

  try {
    tried.push('reportData');
    const data = await evaluate(`
      (function() {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) { if (sources[i].ordersData) { strat = sources[i]; break; } }
        if (!strat || typeof strat.reportData !== 'function') return null;
        var rd = strat.reportData();
        if (!rd || !rd.performance) return null;
        var perf = rd.performance;
        var out = {};
        // Top-level performance metrics
        var topKeys = ['maxStrategyDrawDown','maxStrategyDrawDownPercent','maxStrategyRunUp','maxStrategyRunUpPercent',
                       'sharpeRatio','sortinoRatio','openPL','openPLPercent','buyHoldReturn','buyHoldReturnPercent'];
        for (var t = 0; t < topKeys.length; t++) {
          if (perf[topKeys[t]] !== undefined) out[topKeys[t]] = perf[topKeys[t]];
        }
        // Flatten performance.all (combined long+short metrics)
        if (perf.all && typeof perf.all === 'object') {
          var ak = Object.keys(perf.all);
          for (var a = 0; a < ak.length; a++) {
            var v = perf.all[ak[a]];
            if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') out[ak[a]] = v;
          }
        }
        // Add settings info
        if (rd.settings && rd.settings.dateRange) out._dateRange = JSON.stringify(rd.settings.dateRange);
        out._currency = rd.currency || '';
        out._tradeCount = rd.trades ? (Array.isArray(rd.trades) ? rd.trades.length : 0) : 0;
        // Get strategy name from metaInfo
        try {
          var mi = strat.metaInfo();
          out.strategyName = mi.description || mi.shortDescription || '';
        } catch(e) {}
        return out;
      })()
    `);
    if (data && typeof data === 'object' && Object.keys(data).length > 0) metrics = data;
  } catch (e) {
    tried.push('reportData error: ' + (e.message || '').substring(0, 100));
  }

  // Phase 3: if still empty, collect debug info about strategy source properties
  let debug;
  if (Object.keys(metrics).length === 0) {
    try {
      debug = await evaluate(`
        (function() {
          var chart = ${CHART_API}._chartWidget;
          var sources = chart.model().model().dataSources();
          var strat = null;
          for (var i = 0; i < sources.length; i++) { if (sources[i].ordersData) { strat = sources[i]; break; } }
          if (!strat) return null;
          var own = Object.getOwnPropertyNames(strat).slice(0, 50);
          var proto = Object.getPrototypeOf(strat);
          var protoNames = proto ? Object.getOwnPropertyNames(proto).filter(function(n) { return /report|perf|strat|result|metric|stat/i.test(n); }) : [];
          return { own_props: own, report_proto_methods: protoNames };
        })()
      `);
    } catch (e) { debug = { error: e.message }; }
    if (debug) debug.tried = tried;
  }

  return { success: true, metric_count: Object.keys(metrics).length, source: 'internal_api', metrics, error: Object.keys(metrics).length === 0 ? 'Strategy found but metrics extraction failed' : undefined, debug };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.ordersData || s.reportData)) { strat = s; break; }
        }
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
  return { success: true, trade_count: trades?.trades?.length || 0, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
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
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

export async function getQuote({ symbol } = {}) {
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

export async function getDepth() {
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

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
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
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

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
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

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
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

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
  return { success: true, study_count: studies.length, studies };
}

export async function evaluateJs({ expression }) {
  if (!expression) {
    return { success: false, error: 'expression is required' };
  }
  try {
    const result = await evaluate(expression);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getStrategyMetricsFromDom() {
  try {
    // First, ensure the "지표" (metrics) tab is active in the strategy tester
    await evaluate(`
      (function() {
        var bottom = document.querySelector('.layout__area--bottom');
        if (!bottom) return;
        var buttons = bottom.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var t = buttons[i].textContent.trim();
          if (t === '지표' || t === 'Performance Summary' || t === 'Overview') {
            buttons[i].click();
            break;
          }
        }
      })()
    `);
    // Wait for tab switch
    await new Promise(r => setTimeout(r, 500));

    const raw = await evaluate(`
      (function() {
        var bottom = document.querySelector('.layout__area--bottom');
        if (!bottom) return { error: 'Strategy tester panel not found. Open it via the bottom panel.' };

        var bRect = bottom.getBoundingClientRect();
        var yMin = bRect.top;
        var yMax = bRect.bottom;

        var all = bottom.querySelectorAll('*');
        var m = {};
        var prev = '';

        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length !== 0) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.y < yMin || rect.y > yMax) continue;

          var t = el.textContent.trim();
          if (!t) continue;

          // Strategy name detection
          if (t.includes('HEX') || t.includes('v5.') || t.includes('v4.') || t.includes('[AR]')
              || t.includes('Strategy') || t.includes('strategy'))
            m.name = t;
          // Korean + English labels
          else if (t === '총 손익' || t === 'Net Profit') prev = 'np';
          else if (t === '최대 자본 감소' || t === 'Max Drawdown') prev = 'dd';
          else if (t === '총 거래횟수' || t === 'Total Closed Trades') prev = 'tr';
          else if (t === '수익성 거래' || t === 'Percent Profitable') prev = 'wr';
          else if (t === '수익지수' || t === 'Profit Factor') prev = 'pf';
          else if (t === 'CAGR' || t === 'Compounding Annual Return') prev = 'cagr';
          else if (t === 'Sharpe Ratio' || t === '샤프 레이쇼') prev = 'sharpe';
          else if (t === 'Sortino Ratio' || t === '소르티노 레이쇼') prev = 'sortino';
          else if (t === 'Max Run-up' || t === '최대 실현 수익') prev = 'runup';
          else if (t === 'Avg Trade' || t === '평균 거래' || t === '평균 손익') prev = 'avg_trade';
          else if (prev && /[\\d.+\\-,]+%/.test(t)) {
            if (prev === 'np') m.net_profit_pct = t;
            else if (prev === 'dd') m.max_dd_pct = t;
            else if (prev === 'wr') m.win_rate = t;
            else if (prev === 'cagr') m.cagr = t;
            else if (prev === 'avg_trade' && !m.avg_trade_pct) m.avg_trade_pct = t;
            prev = '';
          }
          else if (prev === 'tr' && /^[\\d,]+$/.test(t)) { m.trades = t.replace(/,/g, ''); prev = ''; }
          else if (prev === 'pf' && /^[\\d.]+$/.test(t)) { m.profit_factor = t; prev = ''; }
          else if (prev === 'sharpe' && /^[\\-\\d.]+$/.test(t)) { m.sharpe_ratio = t; prev = ''; }
          else if (prev === 'sortino' && /^[\\-\\d.]+$/.test(t)) { m.sortino_ratio = t; prev = ''; }
          else if (prev === 'np' && /^[+\\-][\\d,]/.test(t)) m.net_profit_usdt = t;
          else if (prev === 'dd' && /^[\\d,]/.test(t)) m.max_dd_usdt = t;
          else if (prev === 'runup' && /^[+\\-]?[\\d,]/.test(t)) { m.max_runup = t; prev = ''; }
          else if (prev === 'avg_trade' && /^[+\\-]?[\\d,.]/.test(t)) { m.avg_trade = t; }
        }
        return m;
      })()
    `);

    if (raw?.error) {
      return { success: false, error: raw.error };
    }

    const metricCount = Object.keys(raw || {}).length;
    if (metricCount === 0) {
      return { success: false, error: 'No strategy metrics found in DOM. Make sure the Strategy Tester panel is open and a strategy is loaded.' };
    }

    return { success: true, source: 'dom', metric_count: metricCount, metrics: raw };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

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
  return { success: true, study_count: studies.length, studies };
}
