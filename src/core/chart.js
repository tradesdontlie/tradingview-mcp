/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { recordChartMutation, currentMutationId } from './_mutation_ledger.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

export async function getState({ _deps, verify_against_feed = true } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        // Look up which data sources back these studies so we can flag strategies.
        var stratIds = {};
        try {
          var widget = chart._chartWidget;
          var sources = widget.model().model().dataSources();
          for (var si = 0; si < sources.length; si++) {
            var s = sources[si];
            if (s.reportData && (s.ordersData || s.tradesData)) {
              var sid = (s.id && (typeof s.id === 'function' ? s.id() : s.id))
                || (s._id && (typeof s._id === 'function' ? s._id() : s._id))
                || null;
              if (sid) stratIds[sid] = true;
            }
          }
        } catch(e) {}
        studies = allStudies.map(function(s) {
          return {
            id: s.id,
            name: s.name || s.title || 'unknown',
            is_strategy: !!stratIds[s.id],
          };
        });
      } catch(e) {}
      var sym = chart.symbol();
      // C1: coherence — read the actual data-feed symbol/resolution from mainSeries()
      var data_symbol = null;
      var data_resolution = null;
      try {
        var widget = chart._chartWidget;
        var series = widget.model().mainSeries();
        try {
          var info = (typeof series.symbolInfo === 'function') ? series.symbolInfo() : null;
          if (info) data_symbol = info.full_name || info.symbol || info.ticker || null;
        } catch(e) {}
        try {
          var iv = (typeof series.interval === 'function') ? series.interval() : null;
          if (iv != null) data_resolution = String(iv);
        } catch(e) {}
      } catch(e) {}
      return {
        symbol: sym,
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        delayed_feed: /_DLY[:_]/i.test(sym || ''),
        studies: studies,
        _data_symbol: data_symbol,
        _data_resolution: data_resolution,
      };
    })()
  `);
  // C1 / A1-F4 / A2-F1: coherence check between reported state and live feed
  const coherence = _computeCoherence(state, verify_against_feed);
  const mutation_id = currentMutationId();
  const out = {
    success: coherence.coherent !== false,
    symbol: state.symbol,
    resolution: state.resolution,
    chartType: state.chartType,
    delayed_feed: state.delayed_feed,
    studies: state.studies,
    data_symbol: state._data_symbol,
    data_resolution: state._data_resolution,
    coherent: coherence.coherent,
    coherence_errors: coherence.errors,
    last_chart_mutation_id: mutation_id,
    last_data_refresh_at: new Date().toISOString(),
    mutation_id,
  };
  if (coherence.coherent === false) {
    out.error = 'CHART_DATA_STATE_MISMATCH';
    out.remediation = 'chart_get_state.symbol/resolution disagree with the live data feed. Likely a stale browser session; reload the TradingView tab or call chart_ensure_symbol again.';
  }
  return out;
}

/**
 * C1 coherence helper. Returns {coherent: true|false|null, errors: string[]}.
 * coherent === null when verify_against_feed=false or the feed symbol/resolution
 * could not be read (graceful degradation, not a mismatch).
 */
export function _computeCoherence(state, verify_against_feed) {
  if (!verify_against_feed) return { coherent: null, errors: [] };
  const errors = [];
  const stateSym = String(state.symbol || '').toUpperCase().replace(/_DLY/i, '');
  const feedSym = String(state._data_symbol || '').toUpperCase().replace(/_DLY/i, '');
  if (state._data_symbol == null && state._data_resolution == null) {
    return { coherent: null, errors: [] };
  }
  if (feedSym && stateSym && !feedSym.includes(stateSym) && !stateSym.includes(feedSym)) {
    errors.push(`chart_get_state.symbol="${state.symbol}" != mainSeries.symbol="${state._data_symbol}"`);
  }
  const stateRes = String(state.resolution || '');
  const feedRes = String(state._data_resolution || '');
  if (feedRes && stateRes && feedRes !== stateRes) {
    errors.push(`chart_get_state.resolution="${stateRes}" != mainSeries.interval="${feedRes}"`);
  }
  return { coherent: errors.length === 0, errors };
}

/**
 * Set symbol, wait for chart to settle, and warn if TradingView quietly
 * downgraded the realtime feed to delayed (e.g. TADAWUL → TADAWUL_DLY).
 * Returns the canonical resolved symbol plus a `delayed_feed` boolean.
 */
export async function ensureSymbol({ symbol, _deps }) {
  const { evaluate, evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  const after = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var sym = chart.symbol();
      var ext = {};
      try { ext = chart.symbolExt() || {}; } catch(e) {}
      return { symbol: sym, exchange: ext.exchange || null, description: ext.description || null, type: ext.type || null };
    })()
  `);
  const requestedBase = String(symbol).replace(/_DLY/i, '').toUpperCase();
  const actualBase = String(after.symbol || '').replace(/_DLY/i, '').toUpperCase();
  const matched = actualBase.includes(requestedBase) || requestedBase.includes(actualBase);
  const delayed = /_DLY[:_]/i.test(after.symbol || '');
  const mutation_id = recordChartMutation({ kind: 'ensureSymbol', symbol: after.symbol });
  return {
    success: matched,
    requested: symbol,
    resolved_symbol: after.symbol,
    exchange: after.exchange,
    description: after.description,
    type: after.type,
    delayed_feed: delayed,
    chart_ready: ready,
    mutation_id,
    warning: delayed && !/_DLY/i.test(symbol)
      ? 'Realtime feed unavailable for this account; chart fell back to delayed data (_DLY).'
      : (!matched ? `Resolved symbol "${after.symbol}" doesn't match requested "${symbol}".` : undefined),
  };
}

/**
 * Resolve a free-text query to the best-match canonical symbol on TradingView.
 * Wraps symbolSearch with smart ranking (exact ticker, then exchange-prefixed).
 */
export async function resolveSymbol({ query, prefer_exchange }) {
  if (!query) throw new Error('query is required');
  // Use TradingView's public symbol search REST API
  const params = new URLSearchParams({
    text: query, hl: '1', exchange: prefer_exchange || '', lang: 'en', search_type: '', domain: 'production',
  });
  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();
  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const all = (data.symbols || data || []).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));
  if (all.length === 0) {
    throw new Error(`No symbols matched "${query}". Try a different ticker or include the exchange prefix.`);
  }
  // Rank: exact ticker match > preferred exchange match > stock type > first result.
  const q = query.toUpperCase();
  const scored = all.map(r => {
    let s = 0;
    if (r.symbol.toUpperCase() === q) s += 100;
    if (prefer_exchange && r.exchange.toUpperCase() === String(prefer_exchange).toUpperCase()) s += 50;
    if (r.type === 'stock') s += 5;
    return { ...r, score: s };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    success: true,
    query,
    resolved: best.full_name,
    symbol: best.symbol,
    exchange: best.exchange,
    description: best.description,
    type: best.type,
    alternatives: scored.slice(1, 5).map(({ score, ...rest }) => rest),
  };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  const mutation_id = recordChartMutation({ kind: 'setSymbol', symbol });
  return { success: true, symbol, chart_ready: ready, mutation_id };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  const mutation_id = recordChartMutation({ kind: 'setTimeframe', timeframe });
  return { success: true, timeframe, chart_ready: ready, mutation_id };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date, _deps }) {
  const { evaluate } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
