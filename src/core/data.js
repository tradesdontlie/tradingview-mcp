/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Round a PRICE to 8 dp. The old 2-dp rounding flattened sub-cent forex/crypto
// levels to 0.00 and corrupted fractional futures levels (e.g. a real level of
// 29941.9375 was reported as 29941.94). 8 dp still strips float noise while
// preserving every real tick. Prices only — NOT percentages or volumes.
// (Ported from upstream a184e66 / issue #77.)
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);

// Shared page-context JS: locate the strategy data source. Strategies are
// identified by metaInfo().isTVScriptStrategy / is_strategy — NOT by
// is_price_study===false (the #48/#173/#181 bug: strategies actually have
// is_price_study===true, so the old check excluded every one). With multiple
// strategies on the chart, only the one selected in the Strategy Tester has a
// computed report, so prefer a strategy whose reportData().performance is
// populated. (Ported from upstream 653c273.)
const FIND_STRATEGY_JS = `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function findStrategy() {
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
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
    }
    if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
    return null;
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

// #173: TradingView doesn't compute the strategy report/orders until the
// Strategy Tester panel is opened. Ensure it's open (via bottomWidgetBar) and
// wait for a strategy's reportData to populate, so the strategy read tools work
// even when the panel started closed. (Ported from upstream 653c273.)
async function ensureStrategyTesterReady(maxWaitMs = 6000) {
  await evaluate(`
    (function() {
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
    })()
  `);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      (function() {
        ${FIND_STRATEGY_JS}
        var f = findStrategy();
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') return ready;
    await new Promise(r => setTimeout(r, 500));
  }
  return 'timeout';
}

export async function getStrategyResults() {
  await ensureStrategyTesterReady();
  const results = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy first (e.g. indicator_add with a "... Strategy" script).'};
        var rd = found.report;
        if (!rd || !rd.performance) return {metrics: {}, source: 'internal_api', error: 'Strategy report not computed yet. Open the Strategy Tester panel (ui_open_panel strategy-tester) and retry.'};
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
  return { success: Object.keys(results?.metrics || {}).length > 0, metric_count: Object.keys(results?.metrics || {}).length, strategy: results?.strategy, currency: results?.currency, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  await ensureStrategyTesterReady();
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
  return { success: (trades?.trades?.length || 0) > 0, trade_count: trades?.trades?.length || 0, total_orders: trades?.total_orders ?? 0, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  await ensureStrategyTesterReady();
  const equity = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var rd = found.report;
        if (!rd) return {data: [], source: 'internal_api', error: 'Strategy report not computed yet. Open the Strategy Tester panel and retry.'};
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
  return { success: (equity?.data?.length || 0) > 0, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], buy_hold_points: equity?.buy_hold_points, note: equity?.note, error: equity?.error };
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

// Enrich a batch of symbols with price + liquidity + market-cap data via the
// same scanner REST endpoint getQuoteViaScanner uses, in ONE round-trip.
// Used by /refresh-movers (T26 — quality filter) to drop sub-$N price,
// thin-volume, or micro-cap tickers BEFORE they reach 3Cs triage. Keeps
// us from wasting 40+ Strategist calls on penny pumps.
//
// Input: { symbols: ["NASDAQ:AAPL", "NYSE:IBM", ...] }
// Output: {
//   success: true,
//   count: N,                    // how many symbols were returned
//   requested: M,                // how many were asked for
//   missing: [...],              // symbols the endpoint didn't return
//   enriched: {                  // keyed by upper-cased input symbol
//     "NASDAQ:AAPL": { symbol, close, avg_vol_30d, market_cap, description }
//   },
//   source: "scanner_rest"
// }
//
// Endpoint: POST https://scanner.tradingview.com/america/scan (cross-origin,
// string body, NO Content-Type — same CORS rule as getQuoteViaScanner).
async function enrichSymbols({ symbols } = {}) {
  const tickers = Array.isArray(symbols) ? symbols.map(s => String(s).trim()).filter(Boolean) : [];
  if (tickers.length === 0) {
    return { success: false, error: 'scanner_enrich: symbols[] required (non-empty array)' };
  }
  if (tickers.length > 500) {
    return { success: false, error: `scanner_enrich: too many symbols (${tickers.length}); cap is 500 per call` };
  }
  const body = JSON.stringify({
    symbols: { tickers },
    columns: ['close', 'average_volume_30d_calc', 'average_volume_60d_calc', 'market_cap_basic', 'description'],
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
    return { success: false, error: `scanner_enrich fetch failed: ${resp?.error || 'no response'}` };
  }
  if (!resp.ok) {
    return {
      success: false,
      error: `scanner_enrich HTTP ${resp.status}: ${String(resp.body || '').slice(0, 200)}`,
    };
  }
  const rows = Array.isArray(resp.json?.data) ? resp.json.data : [];
  const enriched = {};
  const returnedUpper = new Set();
  for (const row of rows) {
    if (!row || !Array.isArray(row.d)) continue;
    const [close, avg_vol_30d, avg_vol_60d, market_cap, description] = row.d;
    const key = String(row.s || '').toUpperCase();
    if (!key) continue;
    returnedUpper.add(key);
    enriched[key] = {
      symbol: row.s,
      close: typeof close === 'number' ? close : null,
      avg_vol_30d: typeof avg_vol_30d === 'number' ? avg_vol_30d : null,
      avg_vol_60d: typeof avg_vol_60d === 'number' ? avg_vol_60d : null,
      market_cap: typeof market_cap === 'number' ? market_cap : null,
      description: description || '',
    };
  }
  const missing = tickers.filter(t => !returnedUpper.has(String(t).toUpperCase()));
  return {
    success: true,
    count: Object.keys(enriched).length,
    requested: tickers.length,
    missing,
    enriched,
    source: 'scanner_rest',
  };
}

export { enrichSymbols };

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
  // T109 pick C (upstream Issue #143): added `entity_id` and `inputs` summary to
  // each study entry so callers can disambiguate same-name studies (e.g. multiple
  // EMAs at different lengths all return name="Moving Average Exponential"). The
  // `inputs` map normalizes TV's mixed-shape input state ({id,value} objects vs
  // bare values) to a flat {key: value} dict.
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
          var entity_id = null;
          try { entity_id = s.id(); } catch(e) {}
          var inputs = {};
          try {
            var pState = s.properties && s.properties().state();
            if (pState && pState.inputs) {
              for (var k in pState.inputs) {
                var iv = pState.inputs[k];
                inputs[k] = (iv && typeof iv === 'object' && 'value' in iv) ? iv.value : iv;
              }
            }
          } catch(e) {}
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
          if (Object.keys(values).length > 0) results.push({ entity_id: entity_id, name: name, inputs: inputs, values: values });
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

  // Default raised from 50 → 500: real indicators (complex 3-component dashboards, volume profilers, multi-EMA dashboards)
  // routinely emit 100+ labels, and a 50-label cap silently drops the earliest ones — which are
  // often the foundational labels (Fib levels, pivot prices, EMA tags) while keeping dynamic
  // later-bar signals. Caller can still override with max_labels.
  const limit = max_labels || 500;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
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
