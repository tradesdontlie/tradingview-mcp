/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serializes getQuote() calls that mutate chart symbol so concurrent callers
// can't race over the shared chart state. JS is single-threaded but our
// awaits interleave; without this every parallel quote_get(symbol) would
// read whichever symbol the chart happened to be on at evaluate() time.
let _quoteLock = Promise.resolve();

// Shared page-context JS: locate the strategy data source. Strategies are
// identified by metaInfo().isTVScriptStrategy / is_strategy — NOT by
// is_price_study===false (that was the #48/#173/#181 bug: strategies actually
// have is_price_study===true, so the old check excluded every one). Falls
// back to any source exposing reportData/ordersData.
const FIND_STRATEGY_JS = `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function findStrategies() {
    var chart = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var strategies = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
      if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
        strategies.push({ s: s, name: mi ? mi.description : null });
      }
    }
    return strategies;
  }
  // Returns { strat, report } — prefers a strategy whose report is actually
  // computed (the one selected in the Strategy Tester panel). With multiple
  // strategies on the chart, only the selected one has non-null reportData,
  // so returning the first strategy blindly reads the wrong (empty) one.
  function findStrategy() {
    var strategies = findStrategies();
    // Prefer one with a computed report (has .performance).
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
    }
    // None computed — return the first so callers can hint "open the panel".
    if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
    return null;
  }
  // TradingView never computes a report for a hidden strategy (crossed-out eye
  // in the legend), so a hidden one looks identical to "panel not opened yet".
  // Unhide any hidden strategies and report their names so callers can tell
  // the user what changed.
  function unhideStrategies() {
    var unhidden = [];
    var strategies = findStrategies();
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i].s;
      try {
        var vis = null;
        try { vis = s.properties().visible.value(); } catch (e) {}
        if (vis !== false) continue;
        var done = false;
        try { s.properties().visible.setValue(true); done = true; } catch (e) {}
        if (!done) {
          try { var st = ${CHART_API}.getStudyById(s.id()); if (st) { st.setVisible(true); done = true; } } catch (e) {}
        }
        if (done) unhidden.push(strategies[i].name || 'strategy');
      } catch (e) {}
    }
    return unhidden;
  }
`;

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
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
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

// #173: TradingView doesn't compute strategy report/orders until the Strategy
// Tester panel is opened — and never computes one for a hidden strategy.
// Ensure the panel is open (via bottomWidgetBar), unhide any hidden
// strategies, and wait for reportData to populate, so the strategy read tools
// work even when the panel started closed or the strategy was hidden.
// Returns { status, unhidden } — unhidden lists strategies made visible.
async function ensureStrategyTesterReady(maxWaitMs = 6000) {
  const unhidden = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
      return unhideStrategies();
    })()
  `);
  const deadline = Date.now() + maxWaitMs;
  let status = 'timeout';
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      (function() {
        ${FIND_STRATEGY_JS}
        var f = findStrategy();
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') { status = ready; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  return { status, unhidden: unhidden || [] };
}

export async function getStrategyResults() {
  const ready = await ensureStrategyTesterReady();
  const results = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy first (e.g. indicator_add with a "... Strategy" script).'};
        var rd = found.report;
        if (!rd || !rd.performance) return {metrics: {}, source: 'internal_api', error: 'Strategy report not computed yet. Retry in a few seconds; if it persists, check the Strategy Tester panel is open (ui_open_panel strategy-tester) and the strategy is not hidden on the chart.'};
        var perf = rd.performance;
        var all = perf.all || {};
        // Headline metrics, named to match the Strategy Tester "Key stats".
        var metrics = {
          net_profit: all.netProfit,
          net_profit_percent: all.netProfitPercent,
          gross_profit: all.grossProfit,
          gross_loss: all.grossLoss,
          profit_factor: all.profitFactor,
          max_drawdown: perf.maxStrategyDrawDown,
          max_drawdown_percent: perf.maxStrategyDrawDownPercent,
          total_trades: (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
          winning_trades: all.numberOfWiningTrades,
          losing_trades: all.numberOfLosingTrades,
          percent_profitable: all.percentProfitable,
          avg_trade: all.avgTrade,
          largest_win: all.largestWinTrade,
          largest_loss: all.largestLosTrade,
          commission_paid: all.commissionPaid,
          sharpe_ratio: perf.sharpeRatio,
          sortino_ratio: perf.sortinoRatio,
          buy_hold_return: perf.buyHoldReturn,
          open_pl: perf.openPL
        };
        var clean = {};
        for (var k in metrics) { if (metrics[k] !== null && metrics[k] !== undefined) clean[k] = metrics[k]; }
        var currency = rd.currency || null;
        return {metrics: clean, currency: currency, strategy: found.name, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: Object.keys(results?.metrics || {}).length > 0,
    metric_count: Object.keys(results?.metrics || {}).length,
    strategy: results?.strategy, currency: results?.currency, source: results?.source,
    metrics: results?.metrics || {},
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so the report could compute.' }),
    error: results?.error,
  };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const ready = await ensureStrategyTesterReady();
  const trades = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var strat = found.strat;
        var orders = strat.ordersData(); if (orders && typeof orders.value === 'function') orders = orders.value();
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', total_orders: 0, error: 'Strategy orders not computed yet. Open the Strategy Tester panel (ui_open_panel strategy-tester) and retry.'};
        var total = orders.length;
        // Return the most RECENT orders (tail) — that's what a trader wants to see.
        var start = Math.max(0, total - ${limit});
        var result = [];
        for (var t = start; t < total; t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            // Map TradingView's terse order keys to readable names.
            result.push({
              id: o.id,
              type: o.tp,
              side: o.b ? 'buy' : 'sell',
              entry: o.e,
              price: o.p,
              qty: o.q,
              time_index: o.tm
            });
          }
        }
        return {trades: result, total_orders: total, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: (trades?.trades?.length || 0) > 0,
    trade_count: trades?.trades?.length || 0, total_orders: trades?.total_orders ?? 0,
    source: trades?.source, trades: trades?.trades || [],
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so orders could compute.' }),
    error: trades?.error,
  };
}

export async function getEquity() {
  const ready = await ensureStrategyTesterReady();
  const equity = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var rd = found.report;
        if (!rd) return {data: [], source: 'internal_api', error: 'Strategy report not computed yet. Open the Strategy Tester panel and retry.'};
        // buyHold is the per-bar account curve; the equity curve is built from
        // filledOrders' cumulative P&L in reportData.
        var curve = rd.equity || rd.equityChart || null;
        if (Array.isArray(curve)) return {data: curve, source: 'internal_api'};
        if (Array.isArray(rd.buyHold)) {
          return {data: [], buy_hold_points: rd.buyHold.length, source: 'internal_api',
                  note: 'Per-bar equity curve not exposed directly; buyHold baseline has ' + rd.buyHold.length + ' points. Use data_get_strategy_results for summary P&L.'};
        }
        return {data: [], source: 'internal_api', note: 'Equity curve not available via API; use data_get_strategy_results.'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: (equity?.data?.length || 0) > 0,
    data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [],
    buy_hold_points: equity?.buy_hold_points, note: equity?.note,
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden }),
    error: equity?.error,
  };
}

export async function getQuote({ symbol } = {}) {
  // Serialize: chained on _quoteLock so parallel callers run one after another.
  // Catch on the lock chain prevents a single failure from poisoning the chain.
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol }));
  _quoteLock = run.then(() => {}, () => {});
  return run;
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try { originalSymbol = await evaluate(`${CHART_API}.symbol()`); } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
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
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
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
          // Include id + inputs so multiple instances of the same indicator
          // (e.g. two EMAs with different lengths) are distinguishable (#143).
          var id = null;
          try { id = s.id ? s.id() : null; } catch(e) {}
          var inputs = null;
          try { var ip = s.inputs ? s.inputs() : null; if (ip && Object.keys(ip).length) inputs = ip; } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ id: id, name: name, inputs: inputs, values: values });
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
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
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
      const price = roundPrice(v.y);
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
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
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

// ---------------------------------------------------------------------------
// Symbol data panels — Forecast, Technicals, Financials, Key stats, Seasonals,
// News, Options, ETF/Bond profiles.
//
// The chart's right sidebar renders every one of these sections into <canvas>,
// so unlike Pine graphics there is nothing in the DOM worth scraping: the
// panel's innerText yields only axis labels ("'21 '22 '23", "250.00 B") and
// never a single underlying value. We therefore issue TradingView's own data
// requests from page context via evaluateAsync() — same origin, same session
// cookies, no new dependency. DOM scraping is kept only where it genuinely is
// the better source: the Forecast consensus gauge encodes its rating as a CSS
// needle angle that no endpoint returns.
//
// These endpoints are private to TradingView and unversioned. They can change
// without notice, so every reader below degrades to an explicit error instead
// of guessing at a shape it did not get.
// ---------------------------------------------------------------------------

// The chart's display ticker is the *feed* venue (e.g. "BATS:AMZN"), which
// TradingView's data service does not recognise — it answers a bare `null`.
// symbolInfo().pro_name carries the listing venue ("NASDAQ:AMZN"), which does.
const SYMBOL_INFO_JS = `
  (function() {
    try {
      var si = ${CHART_API}._chartWidget.model().mainSeries().symbolInfo();
      if (!si) return null;
      return {
        pro_name: si.pro_name, name: si.name, full_name: si.full_name,
        listed_exchange: si.listed_exchange, type: si.type,
        currency: si.currency_code, description: si.description
      };
    } catch (e) { return null; }
  })()
`;

async function resolveSymbol(symbol) {
  if (symbol && String(symbol).trim()) {
    return { pro_name: String(symbol).trim().toUpperCase(), from_chart: false };
  }
  const info = await evaluate(SYMBOL_INFO_JS);
  if (!info || !info.pro_name) {
    throw new Error('Could not read the chart symbol. Make sure a chart is loaded, or pass symbol explicitly (e.g. "NASDAQ:AMZN").');
  }
  return { ...info, from_chart: true };
}

/** Run one scanner field request from page context and return the raw record. */
async function scannerFields(proSymbol, fields) {
  const data = await evaluateAsync(`
    (async function() {
      try {
        var url = 'https://scanner.tradingview.com/symbol?symbol=' + encodeURIComponent(${safeString(proSymbol)})
          + '&fields=' + encodeURIComponent(${safeString(fields.join(','))}) + '&no_404=true';
        var r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { __error: 'TradingView data service returned HTTP ' + r.status };
        var text = (await r.text()).trim();
        if (!text || text === 'null') return { __error: '__unknown_symbol__' };
        return JSON.parse(text);
      } catch (e) { return { __error: String((e && e.message) || e) }; }
    })()
  `);
  if (!data) throw new Error('No response from TradingView data service.');
  if (data.__error === '__unknown_symbol__') {
    throw new Error(`TradingView has no data record for "${proSymbol}". Use the exchange-qualified listing symbol (e.g. "NASDAQ:AMZN") — the chart's display ticker (e.g. "BATS:AMZN") is often a different venue and is not accepted.`);
  }
  if (data.__error) throw new Error(`TradingView data request failed: ${data.__error}`);
  return data;
}

// Recommend.* is a -1..1 score; these are TradingView's own gauge buckets.
function recommendLabel(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 0.5) return 'strong_buy';
  if (v >= 0.1) return 'buy';
  if (v >= -0.1) return 'neutral';
  if (v >= -0.5) return 'sell';
  return 'strong_sell';
}

// recommendation_mark is the *analyst* consensus on a 1..5 scale — note it
// runs the opposite direction to Recommend.* (1 = strong buy, 5 = strong sell).
function analystRatingLabel(mark) {
  if (mark == null || !Number.isFinite(mark)) return null;
  if (mark <= 1.5) return 'strong_buy';
  if (mark <= 2.5) return 'buy';
  if (mark <= 3.5) return 'neutral';
  if (mark <= 4.5) return 'sell';
  return 'strong_sell';
}

const isoDate = (unixSeconds) =>
  (unixSeconds == null || !Number.isFinite(unixSeconds) ? null : new Date(unixSeconds * 1000).toISOString().slice(0, 10));

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export async function getKeyStats({ symbol } = {}) {
  const sym = await resolveSymbol(symbol);
  const d = await scannerFields(sym.pro_name, [
    'description', 'type', 'currency', 'sector', 'industry', 'close', 'change',
    'market_cap_basic', 'volume', 'average_volume_10d_calc', 'average_volume_30d_calc',
    'earnings_release_next_date', 'earnings_per_share_forecast_next_fq',
    'dividends_yield_current', 'price_earnings_ttm', 'earnings_per_share_diluted_ttm',
    'beta_1_year', 'total_shares_outstanding', 'float_shares_outstanding',
  ]);
  return {
    success: true,
    symbol: sym.pro_name,
    description: d.description ?? null,
    instrument_type: d.type ?? null,
    currency: d.currency ?? null,
    sector: d.sector ?? null,
    industry: d.industry ?? null,
    price: d.close ?? null,
    change_pct: round2(d.change),
    market_cap: d.market_cap_basic ?? null,
    volume: d.volume ?? null,
    avg_volume_10d: Math.round(d.average_volume_10d_calc ?? 0) || null,
    avg_volume_30d: Math.round(d.average_volume_30d_calc ?? 0) || null,
    next_earnings_date: isoDate(d.earnings_release_next_date),
    next_earnings_eps_estimate: d.earnings_per_share_forecast_next_fq ?? null,
    dividend_yield_pct: d.dividends_yield_current ?? null,
    pe_ratio_ttm: round2(d.price_earnings_ttm),
    eps_ttm: d.earnings_per_share_diluted_ttm ?? null,
    beta_1y: round2(d.beta_1_year),
    shares_outstanding: d.total_shares_outstanding ?? null,
    float_shares: d.float_shares_outstanding ?? null,
  };
}

// Scanner timeframe suffixes. 1D is the unsuffixed default.
const TECHNICAL_TIMEFRAMES = {
  '1': '|1', '5': '|5', '15': '|15', '30': '|30', '60': '|60', '120': '|120', '240': '|240',
  'D': '', '1D': '', 'W': '|1W', '1W': '|1W', 'M': '|1M', '1M': '|1M',
};
const OSCILLATOR_FIELDS = ['RSI', 'Stoch.K', 'Stoch.D', 'Stoch.RSI.K', 'Stoch.RSI.D', 'CCI20', 'ADX', 'AO', 'Mom', 'MACD.macd', 'MACD.signal', 'W.R', 'BBPower', 'UO'];
const MA_FIELDS = ['EMA10', 'SMA10', 'EMA20', 'SMA20', 'EMA30', 'SMA30', 'EMA50', 'SMA50', 'EMA100', 'SMA100', 'EMA200', 'SMA200', 'Ichimoku.BLine', 'VWMA', 'HullMA9'];

export async function getTechnicals({ symbol, timeframe } = {}) {
  const sym = await resolveSymbol(symbol);
  const tfKey = String(timeframe || '1D').toUpperCase();
  const suffix = TECHNICAL_TIMEFRAMES[tfKey];
  if (suffix === undefined) {
    throw new Error(`Unsupported timeframe "${timeframe}". Use one of: ${Object.keys(TECHNICAL_TIMEFRAMES).join(', ')}.`);
  }
  const scoped = ['Recommend.All', 'Recommend.MA', 'Recommend.Other', ...OSCILLATOR_FIELDS, ...MA_FIELDS];
  const d = await scannerFields(sym.pro_name, [...scoped.map(f => f + suffix), 'close']);
  const at = (f) => d[f + suffix] ?? null;

  const gauge = (f) => ({ score: round2(at(f)), rating: recommendLabel(at(f)) });
  const values = {};
  for (const f of [...OSCILLATOR_FIELDS, ...MA_FIELDS]) values[f] = round2(at(f));

  return {
    success: true,
    symbol: sym.pro_name,
    timeframe: tfKey,
    price: d.close ?? null,
    summary: gauge('Recommend.All'),
    moving_averages: gauge('Recommend.MA'),
    oscillators: gauge('Recommend.Other'),
    indicators: values,
  };
}

export async function getForecast({ symbol } = {}) {
  const sym = await resolveSymbol(symbol);
  const d = await scannerFields(sym.pro_name, [
    'close', 'currency', 'price_target_1y', 'price_target_average', 'price_target_high',
    'price_target_low', 'price_target_estimates_num', 'recommendation_mark',
    'recommendation_total', 'recommendation_buy', 'recommendation_hold', 'recommendation_sell',
  ]);
  const price = d.close ?? null;
  const target = d.price_target_average ?? d.price_target_1y ?? null;
  const upside = (price && target) ? ((target - price) / price) * 100 : null;

  // Best-effort DOM enrichment: the sidebar gauge exposes the consensus as a
  // needle angle, which the data service does not return. Only meaningful when
  // we are looking at the symbol the chart is actually showing.
  let gaugeDegrees = null;
  if (sym.from_chart) {
    try {
      gaugeDegrees = await evaluate(`
        (function() {
          try {
            var nodes = document.querySelectorAll('.widgetbar-widget-detail [style*="recommendation-degrees"]');
            for (var i = 0; i < nodes.length; i++) {
              var m = (nodes[i].getAttribute('style') || '').match(/recommendation-degrees:\\s*([-\\d.]+)deg/);
              if (m) return parseFloat(m[1]);
            }
            return null;
          } catch (e) { return null; }
        })()
      `);
    } catch { gaugeDegrees = null; }
  }

  if (target == null && d.recommendation_mark == null) {
    throw new Error(`No analyst forecast is published for "${sym.pro_name}". TradingView only covers analyst estimates for stocks with research coverage.`);
  }

  return {
    success: true,
    symbol: sym.pro_name,
    currency: d.currency ?? null,
    price,
    price_target: {
      low: d.price_target_low ?? null,
      average: round2(d.price_target_average ?? d.price_target_1y),
      high: d.price_target_high ?? null,
      estimates: d.price_target_estimates_num ?? null,
    },
    upside_pct: round2(upside),
    consensus: {
      rating: analystRatingLabel(d.recommendation_mark),
      mark: round2(d.recommendation_mark),
      analysts: d.recommendation_total ?? null,
      buy: d.recommendation_buy ?? null,
      hold: d.recommendation_hold ?? null,
      sell: d.recommendation_sell ?? null,
      ...(gaugeDegrees != null && { gauge_needle_degrees: gaugeDegrees }),
    },
  };
}

const FINANCIAL_METRICS = ['total_revenue', 'gross_profit', 'net_income', 'earnings_per_share_diluted', 'ebitda', 'free_cash_flow', 'total_debt', 'total_assets'];

export async function getFinancials({ symbol, period, limit } = {}) {
  const sym = await resolveSymbol(symbol);
  const p = String(period || 'annual').toLowerCase();
  if (p !== 'annual' && p !== 'quarterly') throw new Error('period must be "annual" or "quarterly".');
  const sfx = p === 'annual' ? '_fy_h' : '_fq_h';
  const max = Math.min(limit || 8, 32);

  const fields = FINANCIAL_METRICS.map(m => m + sfx);
  fields.push('currency');
  if (p === 'annual') fields.push('fiscal_period_fy_h');
  const d = await scannerFields(sym.pro_name, fields);

  const series = (m) => (Array.isArray(d[m + sfx]) ? d[m + sfx] : []);
  const depth = Math.max(0, ...FINANCIAL_METRICS.map(m => series(m).length));
  if (!depth) {
    throw new Error(`No ${p} financial statements are published for "${sym.pro_name}". Indices, forex, crypto and most funds have no income statement.`);
  }
  const years = Array.isArray(d.fiscal_period_fy_h) ? d.fiscal_period_fy_h : null;

  // Every series is newest-first, so index 0 is the most recent report.
  const periods = [];
  for (let i = 0; i < Math.min(depth, max); i++) {
    const revenue = series('total_revenue')[i] ?? null;
    const netIncome = series('net_income')[i] ?? null;
    const grossProfit = series('gross_profit')[i] ?? null;
    periods.push({
      ...(p === 'annual' ? { fiscal_year: years?.[i] ?? null } : {}),
      periods_ago: i,
      revenue,
      gross_profit: grossProfit,
      net_income: netIncome,
      eps_diluted: series('earnings_per_share_diluted')[i] ?? null,
      ebitda: series('ebitda')[i] ?? null,
      free_cash_flow: series('free_cash_flow')[i] ?? null,
      total_debt: series('total_debt')[i] ?? null,
      total_assets: series('total_assets')[i] ?? null,
      gross_margin_pct: (revenue && grossProfit != null) ? round2((grossProfit / revenue) * 100) : null,
      net_margin_pct: (revenue && netIncome != null) ? round2((netIncome / revenue) * 100) : null,
    });
  }

  return {
    success: true,
    symbol: sym.pro_name,
    period: p,
    currency: d.currency ?? null,
    period_count: periods.length,
    periods,
    ...(p === 'quarterly' && {
      note: 'TradingView does not expose fiscal quarter labels through this feed; periods are ordered newest-first and identified by periods_ago (0 = most recently reported quarter).',
    }),
  };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function getSeasonals({ years } = {}) {
  const lookback = Math.min(Math.max(Number(years) || 10, 1), 30);
  const info = await evaluate(SYMBOL_INFO_JS);

  // TradingView renders seasonality to canvas and publishes no seasonality
  // endpoint, so we derive it from monthly bars. That means briefly switching
  // the chart to 1M and restoring the original resolution — the same
  // switch-and-restore trade-off getQuote() already makes for symbols.
  const data = await evaluateAsync(`
    (async function() {
      var chart = ${CHART_API};
      var original = null;
      try {
        original = chart.resolution();
        if (original !== '1M') chart.setResolution('1M', {});
        var series = chart._chartWidget.model().mainSeries();
        for (var attempt = 0; attempt < 40; attempt++) {
          await new Promise(function(r) { setTimeout(r, 250); });
          var bars = series.bars();
          if (!bars || typeof bars.lastIndex !== 'function' || bars.size() < 3) continue;
          var first = bars.firstIndex(), last = bars.lastIndex();
          var prev = bars.valueAt(last - 1), curr = bars.valueAt(last);
          if (!prev || !curr) continue;
          // Guard against reading the pre-switch series: consecutive monthly
          // bars are always more than 20 days apart, intraday/daily are not.
          if ((curr[0] - prev[0]) < 20 * 86400) continue;
          var rows = [];
          for (var i = first; i <= last; i++) {
            var v = bars.valueAt(i);
            if (v && v[1] && v[4]) rows.push([v[0], v[1], v[4]]);
          }
          return { bars: rows };
        }
        return { error: 'Monthly bars did not load within 10s.' };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      } finally {
        try { if (original && original !== '1M') chart.setResolution(original, {}); } catch (e2) {}
      }
    })()
  `);

  if (!data || data.error) {
    throw new Error(`Could not build seasonality: ${data?.error || 'no monthly data returned'}.`);
  }
  const rows = data.bars || [];
  if (rows.length < 12) {
    throw new Error(`Not enough monthly history for "${info?.pro_name || 'this symbol'}" to compute seasonality (got ${rows.length} monthly bars, need at least 12).`);
  }

  const currentYear = new Date().getUTCFullYear();
  const buckets = MONTH_NAMES.map(() => []);
  let earliest = null, latest = null;
  for (const [time, open, close] of rows) {
    const dt = new Date(time * 1000);
    const year = dt.getUTCFullYear();
    if (currentYear - year >= lookback) continue;
    const ret = ((close - open) / open) * 100;
    if (!Number.isFinite(ret)) continue;
    buckets[dt.getUTCMonth()].push({ year, ret });
    if (earliest == null || year < earliest) earliest = year;
    if (latest == null || year > latest) latest = year;
  }

  const months = buckets.map((samples, idx) => {
    if (!samples.length) return { month: idx + 1, name: MONTH_NAMES[idx], samples: 0, avg_return_pct: null, win_rate_pct: null };
    const avg = samples.reduce((a, s) => a + s.ret, 0) / samples.length;
    const wins = samples.filter(s => s.ret > 0).length;
    return {
      month: idx + 1,
      name: MONTH_NAMES[idx],
      samples: samples.length,
      avg_return_pct: round2(avg),
      win_rate_pct: round2((wins / samples.length) * 100),
      best_pct: round2(Math.max(...samples.map(s => s.ret))),
      worst_pct: round2(Math.min(...samples.map(s => s.ret))),
    };
  });

  const scored = months.filter(m => m.avg_return_pct != null);
  const byReturn = [...scored].sort((a, b) => b.avg_return_pct - a.avg_return_pct);

  return {
    success: true,
    symbol: info?.pro_name || null,
    source: 'derived from monthly bars',
    years_requested: lookback,
    years_covered: earliest != null ? { from: earliest, to: latest } : null,
    months,
    best_month: byReturn[0] ? { name: byReturn[0].name, avg_return_pct: byReturn[0].avg_return_pct } : null,
    worst_month: byReturn.length ? { name: byReturn[byReturn.length - 1].name, avg_return_pct: byReturn[byReturn.length - 1].avg_return_pct } : null,
    note: 'Monthly return is measured open-to-close of each monthly bar. The chart resolution is switched to 1M and restored automatically.',
  };
}

export async function getNews({ symbol, limit } = {}) {
  const sym = await resolveSymbol(symbol);
  const max = Math.min(Number(limit) || 15, 50);
  const data = await evaluateAsync(`
    (async function() {
      try {
        var url = 'https://news-headlines.tradingview.com/v2/headlines?client=overview&lang=en&symbol='
          + encodeURIComponent(${safeString(sym.pro_name)});
        var r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { __error: 'news service returned HTTP ' + r.status };
        var j = await r.json();
        return { items: (j && j.items) || [] };
      } catch (e) { return { __error: String((e && e.message) || e) }; }
    })()
  `);
  if (!data) throw new Error('No response from TradingView news service.');
  if (data.__error) throw new Error(`TradingView news request failed: ${data.__error}`);

  const items = (data.items || []).slice(0, max).map(it => ({
    title: it.title ?? null,
    source: it.source ?? it.provider ?? null,
    published_at: isoDate(it.published),
    // urgency 1 = breaking, 2 = regular story.
    breaking: it.urgency === 1,
    link: it.link || (it.storyPath ? `https://www.tradingview.com${it.storyPath}` : null),
    related_symbols: Array.isArray(it.relatedSymbols) ? it.relatedSymbols.map(s => s.symbol).filter(Boolean) : [],
  }));

  return { success: true, symbol: sym.pro_name, count: items.length, headlines: items };
}

export async function getOptions({ symbol, max_expirations } = {}) {
  const sym = await resolveSymbol(symbol);
  const maxExp = Math.min(Number(max_expirations) || 10, 30);

  const data = await evaluateAsync(`
    (async function() {
      try {
        var body = {
          columns: ['expiration', 'strike', 'option-type', 'iv', 'delta'],
          filter: [],
          index_filters: [{ name: 'underlying_symbol', values: [${safeString(sym.pro_name)}] }],
          range: [0, 4000],
          sort: { sortBy: 'expiration', sortOrder: 'asc' }
        };
        // content-type text/plain keeps this a CORS "simple request"; the
        // preflight triggered by application/json is rejected by this host.
        var r = await fetch('https://scanner.tradingview.com/options/scan', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body)
        });
        if (!r.ok) return { __error: 'options service returned HTTP ' + r.status };
        var j = await r.json();
        var rows = (j && j.data) || [];
        var byExpiry = {};
        for (var i = 0; i < rows.length; i++) {
          var d = rows[i].d;
          if (!d || d[3] == null || d[4] == null) continue;
          var key = d[0];
          if (!byExpiry[key]) byExpiry[key] = [];
          byExpiry[key].push({ strike: d[1], type: d[2], iv: d[3], delta: d[4] });
        }
        // Reduce in page context so we ship a term structure, not 2500 legs.
        var out = [];
        for (var expiry in byExpiry) {
          var legs = byExpiry[expiry], nearest = {};
          for (var n = 0; n < legs.length; n++) {
            var leg = legs[n];
            var offset = Math.abs(Math.abs(leg.delta) - 0.5);
            if (!nearest[leg.type] || offset < nearest[leg.type].offset) {
              nearest[leg.type] = { offset: offset, leg: leg };
            }
          }
          var ivs = [], strikes = [];
          for (var side in nearest) { ivs.push(nearest[side].leg.iv); strikes.push(nearest[side].leg.strike); }
          if (!ivs.length) continue;
          var sum = 0; for (var q = 0; q < ivs.length; q++) sum += ivs[q];
          out.push({
            expiration: Number(expiry),
            atm_strike: strikes[0],
            atm_iv: sum / ivs.length,
            contracts: legs.length
          });
        }
        out.sort(function(a, b) { return a.expiration - b.expiration; });
        return { total_contracts: rows.length, expirations: out };
      } catch (e) { return { __error: String((e && e.message) || e) }; }
    })()
  `);

  if (!data) throw new Error('No response from TradingView options service.');
  if (data.__error) throw new Error(`TradingView options request failed: ${data.__error}`);
  if (!data.expirations || !data.expirations.length) {
    throw new Error(`No listed options found for "${sym.pro_name}". Options data only exists for optionable US equities and ETFs.`);
  }

  const today = new Date();
  const termStructure = data.expirations.slice(0, maxExp).map(e => {
    const s = String(e.expiration);
    const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const dte = Math.round((new Date(`${date}T00:00:00Z`) - today) / 86400000);
    return { expiration: date, days_to_expiry: dte, atm_strike: e.atm_strike, atm_iv_pct: round2(e.atm_iv * 100), contracts: e.contracts };
  });

  return {
    success: true,
    symbol: sym.pro_name,
    total_contracts: data.total_contracts,
    expiration_count: data.expirations.length,
    term_structure: termStructure,
    note: 'ATM is the strike whose |delta| is closest to 0.50, averaged across calls and puts. IV spikes on the expiry that straddles an earnings date.',
  };
}

// Phase -1E: upgraded from /options/scan to /options/scan2, which additionally
// exposes theoPrice (theoretical price), pricescale, root, and currency —
// none of these were available on the v1 endpoint (Phase -1C discovery).
const OPTION_CHAIN_COLUMNS = ['expiration', 'strike', 'option-type', 'bid', 'ask', 'iv', 'bid_iv', 'ask_iv', 'delta', 'gamma', 'theta', 'vega', 'rho', 'theoPrice', 'pricescale', 'root', 'currency'];

const OPTION_CHAIN_NATIVE_FIELDS = ['contract', 'root', 'expiration', 'strike', 'option_type', 'currency', 'bid', 'ask', 'theoretical_price', 'iv', 'bid_iv', 'ask_iv', 'delta', 'gamma', 'theta', 'vega', 'rho'];
const OPTION_CHAIN_DERIVED_FIELDS = ['mid', 'spread', 'spread_pct', 'iv_spread'];

// Confirmed absent from the scanner (Phase -1C discovery) — every spelling
// variant tried returned null even on liquid ATM contracts with live bid/ask.
// Volume and last price DO exist, but only as best-effort WebSocket
// enrichment (Phase -1D/-1D.1/-1D.2) — never guaranteed, never snapshot-able
// on demand, and therefore never part of this synchronous scanner response.
// Never fabricate any of these.
const OPTION_CHAIN_UNAVAILABLE_FIELDS = ['last', 'volume', 'open_interest', 'bid_size', 'ask_size', 'multiplier'];

const WIDE_SPREAD_PCT = 15;

// The scan2 request below caps range at [0, 4000]. If the underlying has more
// contracts than that (observed for AMEX:SPY in Phase -1E), the response is
// silently truncated. Surface this explicitly rather than letting callers
// (e.g. the Phase 0A strategy engine) assume they saw the whole chain.
const SCANNER_ROW_CAP = 4000;

function parseIsoDateToYyyymmdd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) throw new Error(`Invalid expiration "${iso}". Expected ISO format YYYY-MM-DD.`);
  return Number(m[1] + m[2] + m[3]);
}

/** Pure — no network. YYYYMMDD int -> "YYYY-MM-DD". */
export function ymdToIsoDate(ymd) {
  const s = String(ymd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Pure — no network. Builds one normalized options_get_chain contract record
 * (native + derived fields + quality flags) from one scan2 row.
 * `d` is the field array in OPTION_CHAIN_COLUMNS order; `s` is the contract
 * ticker; `dte` is the pre-computed days-to-expiry.
 */
export function buildOptionChainContract({ s, d, dte }) {
  const [expYmd, strike, optionType, bid, ask, iv, bidIv, askIv, delta, gamma, theta, vega, rho, theoPrice, pricescale, root, currency] = d;

  const mid = (bid != null && ask != null) ? (bid + ask) / 2 : null;
  const spread = (bid != null && ask != null) ? ask - bid : null;
  const spreadPct = (spread != null && mid != null && mid > 0) ? round2((spread / mid) * 100) : null;
  const ivSpread = (askIv != null && bidIv != null) ? round2((askIv - bidIv) * 100) : null;

  const flags = [];
  if (bid === 0) flags.push('ZERO_BID');
  if (ask === 0) flags.push('ZERO_ASK');
  if (bid != null && ask != null && ask < bid) flags.push('CROSSED_MARKET');
  if (iv == null) flags.push('MISSING_IV');
  if (delta == null || gamma == null || theta == null || vega == null || rho == null) flags.push('MISSING_GREEKS');
  // Missing theoPrice is informational only — never treat a contract as
  // untradeable just because the scanner didn't return a theoretical price.
  if (theoPrice == null) flags.push('MISSING_THEORETICAL_PRICE');
  if (spreadPct != null && spreadPct > WIDE_SPREAD_PCT) flags.push('WIDE_SPREAD');

  return {
    contract: s,
    root: root ?? null,
    expiration: ymdToIsoDate(expYmd),
    days_to_expiry: dte,
    strike,
    option_type: optionType,
    currency: currency ?? null,
    bid: bid ?? null,
    ask: ask ?? null,
    theoretical_price: theoPrice ?? null,
    iv: iv != null ? round2(iv * 100) : null,
    bid_iv: bidIv != null ? round2(bidIv * 100) : null,
    ask_iv: askIv != null ? round2(askIv * 100) : null,
    delta: delta ?? null,
    gamma: gamma ?? null,
    theta: theta ?? null,
    vega: vega ?? null,
    rho: rho ?? null,
    mid: mid != null ? round2(mid) : null,
    spread: spread != null ? round2(spread) : null,
    spread_pct: spreadPct,
    iv_spread: ivSpread,
    quality_flags: flags,
  };
}

/** Pure — no network. Tallies dataQuality counts from built contract records. */
export function tallyOptionChainQuality(contracts) {
  const tally = {
    zero_bid_count: 0,
    crossed_market_count: 0,
    missing_iv_count: 0,
    missing_greeks_count: 0,
    missing_theoretical_price_count: 0,
    wide_spread_count: 0,
  };
  const flagToKey = {
    ZERO_BID: 'zero_bid_count',
    CROSSED_MARKET: 'crossed_market_count',
    MISSING_IV: 'missing_iv_count',
    MISSING_GREEKS: 'missing_greeks_count',
    MISSING_THEORETICAL_PRICE: 'missing_theoretical_price_count',
    WIDE_SPREAD: 'wide_spread_count',
  };
  for (const c of contracts) {
    for (const flag of c.quality_flags) {
      const key = flagToKey[flag];
      if (key) tally[key]++;
    }
  }
  return tally;
}

/** Pure — no network. Input validation shared by getOptionChain. Throws on invalid input. */
export function validateOptionChainInputs({ option_type, max_results, expiration, min_dte, max_dte, min_strike, max_strike, min_delta, max_delta }) {
  const HARD_MAX_RESULTS = 500;

  const type = option_type == null || option_type === '' ? 'all' : String(option_type).trim().toLowerCase();
  if (!['all', 'call', 'put'].includes(type)) {
    throw new Error(`Invalid option_type "${option_type}". Must be "call", "put", or "all".`);
  }

  const maxResults = max_results == null ? 200 : Number(max_results);
  if (!Number.isFinite(maxResults) || maxResults < 1) {
    throw new Error(`Invalid max_results "${max_results}". Must be a positive integer.`);
  }
  if (maxResults > HARD_MAX_RESULTS) {
    throw new Error(`max_results ${maxResults} exceeds the hard maximum of ${HARD_MAX_RESULTS}.`);
  }

  let expirationYmd = null;
  if (expiration != null && expiration !== '') {
    expirationYmd = parseIsoDateToYyyymmdd(expiration);
  }

  for (const [name, v] of [['min_dte', min_dte], ['max_dte', max_dte], ['min_strike', min_strike], ['max_strike', max_strike]]) {
    if (v != null && !Number.isFinite(Number(v))) throw new Error(`Invalid ${name} "${v}". Must be numeric.`);
  }
  for (const [name, v] of [['min_delta', min_delta], ['max_delta', max_delta]]) {
    if (v != null && (!Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1)) {
      throw new Error(`Invalid ${name} "${v}". Must be a number between -1 and 1.`);
    }
  }

  return { type, maxResults, expirationYmd };
}

export async function getOptionChain({
  symbol, expiration, min_dte, max_dte, option_type,
  min_strike, max_strike, min_delta, max_delta, max_results,
} = {}) {
  const { type, maxResults, expirationYmd } = validateOptionChainInputs({
    option_type, max_results, expiration, min_dte, max_dte, min_strike, max_strike, min_delta, max_delta,
  });

  const sym = await resolveSymbol(symbol);

  const today = new Date();
  const todayYmd = Number(`${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`);

  const data = await evaluateAsync(`
    (async function() {
      try {
        var body = {
          columns: ${JSON.stringify(OPTION_CHAIN_COLUMNS)},
          ignore_unknown_fields: false,
          index_filters: [{ name: 'underlying_symbol', values: [${safeString(sym.pro_name)}] }],
          filter2: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'option' } }] },
          range: [0, 4000]
        };
        var r = await fetch('https://scanner.tradingview.com/options/scan2?label-product=options-overlay', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body)
        });
        if (!r.ok) return { __error: 'options service returned HTTP ' + r.status };
        var j = await r.json();
        var rows = (j && j.symbols) || [];

        var todayYmd = ${todayYmd};
        var expirationYmd = ${expirationYmd == null ? 'null' : expirationYmd};
        var minDte = ${min_dte == null ? 'null' : Number(min_dte)};
        var maxDte = ${max_dte == null ? 'null' : Number(max_dte)};
        var wantType = ${JSON.stringify(type)};
        var minStrike = ${min_strike == null ? 'null' : Number(min_strike)};
        var maxStrike = ${max_strike == null ? 'null' : Number(max_strike)};
        var minDelta = ${min_delta == null ? 'null' : Number(min_delta)};
        var maxDelta = ${max_delta == null ? 'null' : Number(max_delta)};
        var maxResults = ${maxResults};

        function ymdToDte(ymd) {
          var s = String(ymd);
          var y = Number(s.slice(0,4)), mo = Number(s.slice(4,6)) - 1, d = Number(s.slice(6,8));
          var expiryMs = Date.UTC(y, mo, d);
          var todayS = String(todayYmd);
          var todayMs = Date.UTC(Number(todayS.slice(0,4)), Number(todayS.slice(4,6)) - 1, Number(todayS.slice(6,8)));
          return Math.round((expiryMs - todayMs) / 86400000);
        }

        var matched = [];
        for (var i = 0; i < rows.length; i++) {
          var d = rows[i].f;
          if (!d) continue;
          var exp = d[0], strike = d[1], otype = d[2];
          if (expirationYmd != null && exp !== expirationYmd) continue;
          var dte = ymdToDte(exp);
          if (minDte != null && dte < minDte) continue;
          if (maxDte != null && dte > maxDte) continue;
          if (wantType !== 'all' && otype !== wantType) continue;
          if (minStrike != null && strike < minStrike) continue;
          if (maxStrike != null && strike > maxStrike) continue;
          var delta = d[8];
          if (minDelta != null && (delta == null || delta < minDelta)) continue;
          if (maxDelta != null && (delta == null || delta > maxDelta)) continue;
          matched.push({ s: rows[i].s, d: d, dte: dte });
        }

        var matchedCount = matched.length;
        var returned = matched.slice(0, maxResults);

        return {
          total_contracts_scanned: rows.length,
          total_contracts_available: (j && typeof j.totalCount === 'number') ? j.totalCount : null,
          matched_contracts: matchedCount,
          returned_contracts: returned.length,
          rows: returned
        };
      } catch (e) { return { __error: String((e && e.message) || e) }; }
    })()
  `);

  if (!data) throw new Error('No response from TradingView options service.');
  if (data.__error) throw new Error(`TradingView options request failed: ${data.__error}`);

  const retrievedAtUtc = new Date().toISOString();
  const contracts = data.rows.map(row => buildOptionChainContract(row));
  const dataQuality = tallyOptionChainQuality(contracts);

  // Truncation signal: the scanner cap was hit AND (if we know the true
  // count) more contracts existed than we fetched. Treat an unknown true
  // count at the cap as possibly-truncated too, rather than assuming complete.
  const hitCap = data.total_contracts_scanned >= SCANNER_ROW_CAP;
  const knownLarger = data.total_contracts_available != null && data.total_contracts_available > data.total_contracts_scanned;
  const chainCompleteness = (hitCap && (knownLarger || data.total_contracts_available == null)) ? 'POSSIBLY_TRUNCATED' : 'COMPLETE';
  const warnings = chainCompleteness === 'POSSIBLY_TRUNCATED' ? ['CHAIN_POSSIBLY_TRUNCATED'] : [];

  return {
    success: true,
    symbol: sym.pro_name,
    source: 'TradingView Options Scanner',
    source_endpoint: '/options/scan2',
    // Request/retrieval time on our side — NOT a guaranteed exchange quote
    // timestamp. The scanner response carries no per-row quote timestamp;
    // this only marks when this tool asked for the data.
    retrieved_at_utc: retrievedAtUtc,
    filters: {
      expiration: expiration ?? null,
      min_dte: min_dte ?? null,
      max_dte: max_dte ?? null,
      option_type: type,
      min_strike: min_strike ?? null,
      max_strike: max_strike ?? null,
      min_delta: min_delta ?? null,
      max_delta: max_delta ?? null,
      max_results: maxResults,
    },
    total_contracts_scanned: data.total_contracts_scanned,
    total_contracts_available: data.total_contracts_available,
    matched_contracts: data.matched_contracts,
    returned_contracts: data.returned_contracts,
    chain_completeness: chainCompleteness,
    warnings,
    data_quality: dataQuality,
    contracts,
    native_fields: OPTION_CHAIN_NATIVE_FIELDS,
    derived_fields: OPTION_CHAIN_DERIVED_FIELDS,
    unavailable_fields: OPTION_CHAIN_UNAVAILABLE_FIELDS,
    note: 'mid, spread, spread_pct, and iv_spread are DERIVED client-side, not native TradingView fields. quality_flags are informational only — contracts are never dropped based on them (including MISSING_THEORETICAL_PRICE). volume and last price are not part of this response: TradingView\'s options scanner never returns them synchronously — see options_get_live_stats design note for the separate, best-effort WebSocket enrichment path.',
  };
}

// ---------------------------------------------------------------------------
// DESIGN NOTE (not implemented) — future optional enrichment: options_get_live_stats
//
// Phase -1D/-1D.1/-1D.2 confirmed that TradingView's options board pushes
// per-contract `last price` and `volume` over an already-open WebSocket
// (qs_multiplexer_options_* "qsd" messages), but ONLY as part of trade-driven
// updates — there is no guaranteed initial snapshot. A contract that hasn't
// traded since the browser subscribed to it may show bid/ask indefinitely
// with no last/volume value at all.
//
// A possible future tool:
//
//   options_get_live_stats({ symbol?, contracts?: string[] })
//     -> { contract, last, volume, change, change_pct, capture_timestamp }[]
//
// Rules any such tool MUST follow:
//   - `last` and `volume` may be null. Null means NOT OBSERVED IN CURRENT
//     LIVE STREAM — never interpret it as zero volume, no trades, or an
//     invalid contract.
//   - `capture_timestamp` is receipt time on our side, not an exchange
//     last-trade time (TradingView's own `lp_time` field was never observed
//     populated in any sampled message during discovery).
//   - This enrichment MUST NOT be a hard dependency of anything built on top
//     of options_get_chain (e.g. a future Strategy Engine). bid/ask/IV/Greeks
//     from options_get_chain must remain sufficient on their own.
//
// Not implemented in this phase.
// ---------------------------------------------------------------------------

export async function getEtfProfile({ symbol } = {}) {
  const sym = await resolveSymbol(symbol);
  const d = await scannerFields(sym.pro_name, [
    'description', 'type', 'typespecs', 'currency', 'close', 'change',
    'aum', 'expense_ratio', 'nav', 'asset_class', 'focus', 'market_cap_basic', 'volume',
  ]);
  if (d.type !== 'fund') {
    throw new Error(`"${sym.pro_name}" is not a fund/ETF (TradingView reports type "${d.type ?? 'unknown'}"). The ETF section only exists for funds — use data_get_key_stats for this instrument.`);
  }
  return {
    success: true,
    symbol: sym.pro_name,
    description: d.description ?? null,
    fund_type: Array.isArray(d.typespecs) ? d.typespecs.join(', ') : null,
    currency: d.currency ?? null,
    price: d.close ?? null,
    change_pct: round2(d.change),
    nav: d.nav ?? null,
    aum: d.aum ?? null,
    expense_ratio_pct: d.expense_ratio ?? null,
    volume: d.volume ?? null,
  };
}

export async function getBondInfo({ symbol } = {}) {
  const sym = await resolveSymbol(symbol);
  const d = await scannerFields(sym.pro_name, [
    'description', 'type', 'typespecs', 'currency', 'close', 'change', 'coupon', 'maturity_date',
  ]);
  if (d.type !== 'bond') {
    throw new Error(`"${sym.pro_name}" is not a bond (TradingView reports type "${d.type ?? 'unknown'}"). Try a yield symbol such as "TVC:US10Y".`);
  }
  const maturity = d.maturity_date != null ? String(d.maturity_date) : null;
  return {
    success: true,
    symbol: sym.pro_name,
    description: d.description ?? null,
    bond_type: Array.isArray(d.typespecs) ? d.typespecs.join(', ') : null,
    currency: d.currency ?? null,
    yield_pct: d.close ?? null,
    change_pct: round2(d.change),
    coupon_pct: d.coupon ?? null,
    maturity_date: maturity && maturity.length === 8 ? `${maturity.slice(0, 4)}-${maturity.slice(4, 6)}-${maturity.slice(6, 8)}` : null,
  };
}
