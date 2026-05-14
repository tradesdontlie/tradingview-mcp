/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { isFallbackActive } from '../fallback/state.js';
import * as fallback from '../fallback/adapter.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// v2 patch (Lesson #37 → Lesson #36 v2): when `_waitForSeriesLoaded` times
// out, instead of either silently returning stale data or throwing a generic
// error, we return a sentinel object that callers (EIT skill, bulten
// pipeline) can recognise and use to short-circuit into a non-TV fallback
// (CCXT for crypto, services.yahoo_fallback for forex/metals/indices).
const STALE_FEED_TIMEOUT_MS = 5000;
function _staleFeedSentinel(requestedSymbol, currentChartSymbol) {
  return {
    __TV_STALE_FEED__: true,
    requested_symbol: requestedSymbol || null,
    current_chart_symbol: currentChartSymbol || null,
    reason:
      'mainSeries.isLoading() timeout after ' +
      (STALE_FEED_TIMEOUT_MS / 1000) +
      's — TV Chrome WS feed appears frozen',
  };
}
function _isStaleSentinel(x) {
  return !!(x && typeof x === 'object' && x.__TV_STALE_FEED__ === true);
}
function _staleFallbackResponse(sentinel) {
  return {
    success: false,
    stale_feed: true,
    reason: sentinel.reason,
    fallback_advice:
      'Use CCXT MCP for crypto or services.yahoo_fallback for forex/metals/indices',
    requested_symbol: sentinel.requested_symbol,
    current_chart_symbol: sentinel.current_chart_symbol,
  };
}

// Upstream issue #140 / MKO Lesson #36 — getQuote() and getOhlcv() accept a
// `symbol` parameter, but the underlying JS reads from BARS_PATH (the active
// chart's main series bars). The `symbol` argument was previously cosmetic:
// it was echoed back in the response object but never used to fetch data for
// a different ticker. Consecutive calls with different symbols therefore all
// returned the data of whichever symbol was last active on the chart.
//
// Fix (Approach A — wrapper pattern):
//   1. Read the chart's current symbol.
//   2. If the caller asked for a different symbol, switch the chart to it
//      and wait for bars to stabilise.
//   3. Run the read.
//   4. In a finally block, restore the original symbol on a best-effort
//      basis so we don't permanently mutate the user's chart.
//
// Trade-offs: causes brief UI flicker, and is serialised. A future iteration
// (Approach B) could open a TradingView internal quote session via
// `TradingViewApi.factory.createQuoteSession` to read quote data without
// touching the visible chart at all.

async function _getCurrentSymbol() {
  try {
    return await evaluate(`(function() {
      try { return ${CHART_API}.symbol(); } catch(e) { return null; }
    })()`);
  } catch {
    return null;
  }
}

function _symbolsMatch(a, b) {
  if (!a || !b) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

async function _setChartSymbol(symbol) {
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  // DOM-level wait (spinner + symbol header). Capped at the stale-feed
  // timeout so we don't sit on a frozen UI for tens of seconds.
  await waitForChartReady(symbol, null, STALE_FEED_TIMEOUT_MS);
  // Internal state wait — mainSeries.isLoading() flips to false and bars
  // settle on the new symbol. Without this, bars.valueAt() still returns
  // the previous symbol's cached values for several seconds after the
  // chart UI has visually switched.
  //
  // v2 (Lesson #37): if this poll times out, we treat the TV WS feed as
  // frozen and signal the caller (via STALE_FEED sentinel propagated by
  // `_withSymbol`) so it can fall back to CCXT/yahoo without returning
  // stale data. Returns true on success, false on timeout.
  return await _waitForSeriesLoaded(symbol, STALE_FEED_TIMEOUT_MS);
}

// Poll until mainSeries.isLoading() === false AND bars.lastIndex() is
// stable for two consecutive samples. Returns true on success, false on
// timeout. Errors during polling are treated as "not ready yet".
async function _waitForSeriesLoaded(expectedSymbol, timeoutMs = STALE_FEED_TIMEOUT_MS) {
  const start = Date.now();
  let lastIdx = -1;
  let stableCount = 0;
  while (Date.now() - start < timeoutMs) {
    let state = null;
    try {
      state = await evaluate(`(function() {
        try {
          var ms = ${CHART_API}._chartWidget.model().mainSeries();
          var bars = ms.bars();
          var li = (bars && typeof bars.lastIndex === 'function') ? bars.lastIndex() : null;
          return { loading: !!ms.isLoading(), symbol: ms.symbol(), lastIdx: li, size: bars ? bars.size() : 0 };
        } catch(e) { return { err: e.message }; }
      })()`);
    } catch {
      state = null;
    }
    if (state && !state.err && !state.loading && state.size > 0) {
      // Confirm symbol matches what we asked for (case-insensitive,
      // substring — handles exchange prefixes like "OANDA:XAUUSD" vs "XAUUSD").
      const symOk = !expectedSymbol
        || (state.symbol
            && (String(state.symbol).toUpperCase().includes(String(expectedSymbol).toUpperCase())
              || String(expectedSymbol).toUpperCase().includes(String(state.symbol).toUpperCase())));
      if (symOk && state.lastIdx === lastIdx) {
        stableCount++;
        if (stableCount >= 2) return true;
      } else {
        stableCount = 0;
      }
      lastIdx = state.lastIdx;
    } else {
      stableCount = 0;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// Switch the chart to `symbol` (if different from current) for the duration
// of `fn`, then restore the original symbol. Returns whatever `fn` returns.
// If `symbol` is falsy or equal to the current symbol, `fn` is called as-is.
//
// v2 (Lesson #37): if `_setChartSymbol` reports the series never finished
// loading within `STALE_FEED_TIMEOUT_MS`, return a STALE_FEED sentinel
// instead of running `fn` on stale bars. The public wrappers (`getQuote`,
// `getOhlcv`) detect this sentinel and translate it into a structured
// `{ success: false, stale_feed: true, ... }` response so callers can fall
// back to a non-TV data source immediately.
async function _withSymbol(symbol, fn) {
  if (!symbol) return fn();

  const originalSymbol = await _getCurrentSymbol();
  const needsSwitch = originalSymbol && !_symbolsMatch(originalSymbol, symbol);
  if (!needsSwitch) return fn();

  let switchedOk = false;
  try {
    switchedOk = await _setChartSymbol(symbol);
  } catch (err) {
    // If we can't switch, fall through and let `fn` run on whatever the
    // chart is showing. The caller will still see incorrect data, but at
    // least we surface a real read instead of a silent cache hit.
    throw new Error(`Failed to switch chart to ${symbol}: ${err.message}`);
  }

  if (switchedOk === false) {
    // v2 silent fallback: WS feed appears frozen. Do NOT run `fn` (it would
    // return stale cached bars from the previous symbol). Restore the
    // original symbol on best-effort and return the sentinel.
    if (originalSymbol) {
      try { await _setChartSymbol(originalSymbol); } catch { /* ignore */ }
    }
    return _staleFeedSentinel(symbol, originalSymbol);
  }

  try {
    return await fn();
  } finally {
    // Best-effort restore. We deliberately swallow errors here so the
    // primary read result is not lost if the restore itself fails.
    if (originalSymbol) {
      try {
        await _setChartSymbol(originalSymbol);
      } catch {
        // ignore — chart is left on `symbol`; user can restore manually
      }
    }
  }
}

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

export async function getOhlcv({ count, summary, symbol, timeframe } = {}) {
  if (isFallbackActive()) {
    return fallback.getOhlcv({ count, summary, symbol, timeframe });
  }
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);

  // Wrap the read so that an explicit `symbol` actually fetches that
  // symbol's bars instead of returning whatever the chart was already on
  // (issue #140 / Lesson #36).
  const data = await _withSymbol(symbol, async () => {
    try {
      return await evaluate(`
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
    } catch { return null; }
  });

  // v2 silent fallback (Lesson #37): WS feed frozen, surface a structured
  // response so caller can pivot to CCXT / yahoo without polling further.
  if (_isStaleSentinel(data)) return _staleFallbackResponse(data);

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
  if (isFallbackActive()) return fallback.getIndicator();
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
  if (isFallbackActive()) return fallback.getStrategyResults();
  const results = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
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
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  if (isFallbackActive()) return fallback.getTrades();
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
  if (isFallbackActive()) return fallback.getEquity();
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
  if (isFallbackActive()) {
    return fallback.getQuote({ symbol });
  }

  // Wrap the read so that an explicit `symbol` actually fetches that
  // symbol's quote instead of returning whatever the chart was already on
  // (issue #140 / Lesson #36).
  const data = await _withSymbol(symbol, async () => {
    return evaluate(`
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
  });

  // v2 silent fallback (Lesson #37): WS feed frozen, surface a structured
  // response so caller can pivot to CCXT / yahoo without polling further.
  if (_isStaleSentinel(data)) return _staleFallbackResponse(data);

  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  if (isFallbackActive()) return fallback.getDepth();
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
  if (isFallbackActive()) return fallback.getStudyValues();
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
  if (isFallbackActive()) return fallback.getPineLines();
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
  if (isFallbackActive()) return fallback.getPineLabels();
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
  if (isFallbackActive()) return fallback.getPineTables();
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
  if (isFallbackActive()) return fallback.getPineBoxes();
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
