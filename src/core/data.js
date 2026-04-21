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

// Identify the chart's user strategy source.
//
// TV Desktop 3.1.0 exposes overlay strategies with `metaInfo().is_price_study: true`
// — the old filter `is_price_study === false` misidentifies them. The authoritative
// marker is `metaInfo().id` starting with `StrategyScript` (e.g.
// "StrategyScript$USER;<uuid>@tv-scripts"). We prefer that marker and fall back
// to the legacy filter for older TV builds.
const FIND_STRATEGY_SRC = `
  function __findStrategy(sources) {
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      try {
        var id = s.metaInfo && (s.metaInfo() || {}).id;
        if (id && /^StrategyScript/.test(String(id))) return s;
      } catch(e) {}
    }
    // Legacy TV fallback
    for (var j = 0; j < sources.length; j++) {
      var t = sources[j];
      try {
        if (t.metaInfo && t.metaInfo().is_price_study === false &&
            (t.ordersData || t.reportData || t._reportData)) return t;
      } catch(e) {}
    }
    return null;
  }
`;

export async function getStrategyResults() {
  const results = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        // TV 3.1.0+: _reportData.performance is where metrics actually live.
        if (strat._reportData && strat._reportData.performance) {
          var perf1 = strat._reportData.performance;
          for (var k1 in perf1) {
            var v1 = perf1[k1];
            if (v1 === null || v1 === undefined) continue;
            if (typeof v1 === 'object') {
              for (var k2 in v1) {
                var v2 = v1[k2];
                if (v2 !== null && v2 !== undefined && typeof v2 !== 'object' && typeof v2 !== 'function') {
                  metrics[k1 + '.' + k2] = v2;
                }
              }
            } else if (typeof v1 !== 'function') {
              metrics[k1] = v1;
            }
          }
        }
        // Legacy paths (older TV)
        if (Object.keys(metrics).length === 0 && strat.reportData) {
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
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};

        // TV 3.1.0+: _reportData.trades is the canonical closed-trade-pair list.
        // Each entry: {e: entry, x: exit, q, tp, cp, rn, dd} with nested {v, p}.
        if (strat._reportData && Array.isArray(strat._reportData.trades)) {
          var rtrades = strat._reportData.trades;
          var flat = [];
          var cap = Math.min(rtrades.length, ${limit});
          for (var t = 0; t < cap; t++) {
            var tr = rtrades[t];
            if (!tr) continue;
            var e = tr.e || {}, x = tr.x || {};
            flat.push({
              entry_order_id: e.c || null,
              entry_price: e.p,
              entry_time_ms: e.tm,
              entry_type: e.tp,
              exit_order_id: x.c || null,
              exit_price: x.p,
              exit_time_ms: x.tm,
              exit_type: x.tp,
              quantity: tr.q,
              pnl: tr.tp ? tr.tp.v : null,
              pnl_pct: tr.tp ? tr.tp.p : null,
              cum_pnl: tr.cp ? tr.cp.v : null,
              cum_pnl_pct: tr.cp ? tr.cp.p : null,
              runup: tr.rn ? tr.rn.v : null,
              runup_pct: tr.rn ? tr.rn.p : null,
              drawdown: tr.dd ? tr.dd.v : null,
              drawdown_pct: tr.dd ? tr.dd.p : null
            });
          }
          return {trades: flat, source: 'internal_api', total_trade_count: rtrades.length};
        }

        // Legacy TV fallback
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'no trade data (_reportData.trades or ordersData).'};
        var result = [];
        for (var t2 = 0; t2 < Math.min(orders.length, ${limit}); t2++) {
          var o = orders[t2];
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
  return { success: true, trade_count: trades?.trades?.length || 0, total_trade_count: trades?.total_trade_count, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        // TV 3.1.0+: _reportData.buyHold holds per-bar equity points
        if (strat._reportData && Array.isArray(strat._reportData.buyHold)) {
          var bh = strat._reportData.buyHold;
          for (var bi = 0; bi < bh.length; bi++) {
            var bv = bh[bi];
            if (typeof bv === 'number') data.push({index: bi, value: bv});
            else if (bv && typeof bv === 'object') data.push(Object.assign({index: bi}, bv));
          }
          if (data.length) return {data: data, source: 'internal_api'};
        }
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

// Fetch a quote via the public scanner REST endpoint. Used when the caller
// asks for a symbol that isn't the active chart — reading bars/symbolExt in
// that case would return the WRONG ticker's data with the requested symbol
// pasted into the envelope. (T35 — live-caught 2026-04-23.)
//
// Endpoint: POST https://scanner.tradingview.com/america/scan (cross-origin).
// Per CLAUDE.md CORS gotcha: send JSON as a plain-string body with NO
// Content-Type header — TV rejects the preflight otherwise.
async function getQuoteViaScanner(symbol) {
  const ticker = String(symbol).trim();
  const body = JSON.stringify({
    symbols: { tickers: [ticker] },
    columns: ['close', 'open', 'high', 'low', 'volume', 'description', 'exchange', 'type'],
  });
  const escapedBody = body.replace(/[\\`$]/g, '\\$&');
  const expr = `
    fetch('https://scanner.tradingview.com/america/scan', {
      method: 'POST',
      body: \`${escapedBody}\`
    })
      .then(function(r) {
        return r.text().then(function(t) {
          var parsed = null;
          try { parsed = t ? JSON.parse(t) : null; } catch(e) {}
          return { status: r.status, ok: r.ok, body: t, json: parsed };
        });
      })
      .catch(function(e) { return { error: e.message }; })
  `;
  const resp = await evaluateAsync(expr);
  if (!resp || resp.error) {
    throw new Error(`quote_get scanner fetch failed: ${resp?.error || 'no response'}`);
  }
  if (!resp.ok) {
    throw new Error(`quote_get scanner HTTP ${resp.status}: ${String(resp.body || '').slice(0, 200)}`);
  }
  const rows = resp.json?.data;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0]?.d)) {
    throw new Error(
      `quote_get: no scanner data for "${ticker}". Use a fully-qualified symbol like "NASDAQ:TSCO".`
    );
  }
  const [close, open, high, low, volume, description, exchange, type] = rows[0].d;
  return {
    success: true,
    symbol: rows[0].s || ticker,
    open,
    high,
    low,
    close,
    last: close,
    volume: volume || 0,
    description: description || '',
    exchange: exchange || '',
    type: type || '',
    source: 'scanner_rest',
  };
}

export async function getQuote({ symbol } = {}) {
  // T35: if caller requested a specific symbol, route through REST unless it
  // matches the active chart. The active-chart path reads bars/symbolExt for
  // whatever's loaded, which returns the wrong ticker's data when the caller
  // passes a different symbol. Bid/ask DOM scraping only works for the active
  // chart anyway, so there's nothing to lose by routing non-active reads
  // through the scanner endpoint.
  if (symbol) {
    const activeSym = await evaluate(`
      (function() {
        try {
          var api = ${CHART_API};
          var s = '';
          try { s = api.symbol() || ''; } catch(e) {}
          if (!s) { try { s = (api.symbolExt() || {}).symbol || ''; } catch(e) {} }
          return s;
        } catch(e) { return ''; }
      })()
    `);
    const active = String(activeSym || '').toUpperCase().trim();
    const requested = String(symbol).toUpperCase().trim();
    if (requested && requested !== active) {
      return await getQuoteViaScanner(symbol);
    }
  }
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
  return { success: true, ...data, source: 'active_chart' };
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

  // Default raised from 50 → 500: real indicators (ASTA 3Cs, volume profilers, multi-EMA dashboards)
  // routinely emit 100+ labels, and a 50-label cap silently drops the earliest ones — which are
  // often the foundational labels (Fib levels, pivot prices, EMA tags) while keeping dynamic
  // later-bar signals. Caller can still override with max_labels.
  const limit = max_labels || 500;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    const truncated = labels.length > limit;
    if (truncated) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, truncated, labels };
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
