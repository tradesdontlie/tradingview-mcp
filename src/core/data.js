/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { STRATEGY_FIND_JS, buildFieldsFilter, summariseReport, pickFields } from './_helpers.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname_data = dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = join(dirname(dirname(__dirname_data)), 'exports');

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;
// Top-level keys in the raw strategy report that are large arrays and not
// useful in default responses (agents almost never need every bar). Callers
// can opt back in via `include`.
const HEAVY_REPORT_KEYS = ['filledOrders', 'trades', 'buyHold', 'buyHoldPercent'];

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

/**
 * Get strategy backtest results. Defaults to a compact summary (~30 keys, ~1 KB).
 * Pass `summary: false` for the raw report, or `fields` to whitelist specific
 * top-level keys, or `include: ["orders","trades","equity"]` to opt back into
 * the heavy arrays that are dropped by default.
 */
export async function getStrategyResults({ summary = true, fields, include } = {}) {
  const results = await evaluate(`
    (function() {
      try {
        var strat = ${STRATEGY_FIND_JS};
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Use pine_deploy_strategy to push and add one, or chart_manage_indicator({action:"add"}).'};
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

  let metrics = results?.metrics || {};
  const includeSet = new Set(Array.isArray(include) ? include : (include ? [include] : []));
  // Drop heavy arrays unless explicitly opted in.
  if (Object.keys(metrics).length > 0) {
    const out = { ...metrics };
    for (const k of HEAVY_REPORT_KEYS) {
      const optIn = (k === 'filledOrders' && includeSet.has('orders'))
        || (k === 'trades' && includeSet.has('trades'))
        || ((k === 'buyHold' || k === 'buyHoldPercent') && includeSet.has('equity'));
      if (!optIn) delete out[k];
    }
    metrics = out;
  }

  if (summary && Object.keys(metrics).length > 0) {
    metrics = summariseReport(metrics);
  }
  const fieldSet = buildFieldsFilter(fields);
  if (fieldSet) metrics = pickFields(metrics, fieldSet);

  return {
    success: true,
    metric_count: Object.keys(metrics || {}).length,
    source: results?.source,
    summary: !!summary,
    metrics,
    error: results?.error,
  };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var strat = ${STRATEGY_FIND_JS};
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart. Use pine_deploy_strategy first.'};
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
        return {trades: result, total: orders.length, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: true,
    trade_count: trades?.trades?.length || 0,
    total_available: trades?.total || trades?.trades?.length || 0,
    source: trades?.source,
    trades: trades?.trades || [],
    error: trades?.error,
  };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var strat = ${STRATEGY_FIND_JS};
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart. Use pine_deploy_strategy first.'};
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

/**
 * Consolidated strategy backtest report — one call returns metrics summary,
 * recent trades, and chart context (symbol, timeframe, delayed-feed flag,
 * backtest period). Replaces the 3-4 call pattern of get_strategy_results +
 * get_trades + chart_get_state + symbol_info.
 */
export async function getStrategyReport({ max_trades = 10, include } = {}) {
  const limit = Math.min(max_trades || 10, MAX_TRADES);
  const includeSet = new Set(Array.isArray(include) ? include : (include ? [include] : []));
  const result = await evaluate(`
    (function() {
      try {
        var chartApi = ${CHART_API};
        var symbol = chartApi.symbol();
        var resolution = chartApi.resolution();
        var ext = {};
        try { ext = chartApi.symbolExt() || {}; } catch(e) {}
        var strat = ${STRATEGY_FIND_JS};
        if (!strat) {
          return { found: false, symbol: symbol, resolution: resolution, exchange: ext.exchange || null, description: ext.description || null };
        }
        var stratName = null;
        try { var m = strat.metaInfo ? strat.metaInfo() : null; stratName = m ? (m.description || m.shortDescription) : null; } catch(e) {}

        var rawReport = null;
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd.value === 'function') rd = rd.value();
          rawReport = rd && typeof rd === 'object' ? rd : null;
        }

        var trades = [];
        var totalTrades = 0;
        if (strat.ordersData) {
          var orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData;
          if (orders && typeof orders.value === 'function') orders = orders.value();
          if (Array.isArray(orders)) {
            totalTrades = orders.length;
            for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
              var o = orders[t];
              if (o && typeof o === 'object') {
                trades.push({ side: o.b ? 'buy' : 'sell', reason: o.c, id: o.id, price: o.p, qty: o.q, type: o.tp, entry: !!o.e });
              }
            }
          }
        }

        return {
          found: true,
          symbol: symbol,
          resolution: resolution,
          exchange: ext.exchange || null,
          description: ext.description || null,
          strategy_name: stratName,
          report: rawReport,
          trades: trades,
          total_trades: totalTrades,
        };
      } catch(e) { return { found: false, error: e.message }; }
    })()
  `);

  if (!result?.found) {
    return {
      success: true,
      strategy_loaded: false,
      symbol: result?.symbol,
      resolution: result?.resolution,
      delayed_feed: result?.symbol ? /_DLY[:_]/i.test(result.symbol) : false,
      error: result?.error || 'No strategy on chart. Run pine_deploy_strategy({source}) or chart_manage_indicator({action:"add"}).',
    };
  }

  const summary = result.report ? summariseReport(result.report) : {};

  const response = {
    success: true,
    strategy_loaded: true,
    chart: {
      symbol: result.symbol,
      resolution: result.resolution,
      exchange: result.exchange,
      description: result.description,
      delayed_feed: /_DLY[:_]/i.test(result.symbol || ''),
    },
    strategy_name: result.strategy_name,
    summary,
    trades_returned: result.trades.length,
    total_trades: result.total_trades,
    trades: result.trades,
  };

  if (includeSet.has('raw_report')) {
    response.raw_report = result.report;
  }
  return response;
}

/**
 * Read the active strategy's inputs (names, IDs, types, current values).
 * Used by pine_grid_search and direct iteration workflows.
 */
export async function getStrategyInputs() {
  const result = await evaluate(`
    (function() {
      try {
        var chartApi = ${CHART_API};
        var allStudies = chartApi.getAllStudies();
        var widget = chartApi._chartWidget;
        var sources = widget.model().model().dataSources();
        // Build map study.id -> source so we can correlate with strategy detection.
        var stratIds = {};
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (s.reportData && (s.ordersData || s.tradesData)) {
            var sid = (s.id && (typeof s.id === 'function' ? s.id() : s.id)) || null;
            if (sid) stratIds[sid] = true;
          }
        }
        var strat = null;
        for (var i = 0; i < allStudies.length; i++) {
          if (stratIds[allStudies[i].id]) { strat = allStudies[i]; break; }
        }
        if (!strat) return { error: 'No strategy on chart. Use pine_deploy_strategy first.' };
        var inputs = [];
        try { inputs = strat.getInputValues() || []; } catch(e) { return { error: 'getInputValues() failed: ' + e.message }; }
        // Filter out text/source blobs that aren't meaningful for tuning.
        var meaningful = inputs.filter(function(inp) {
          if (typeof inp.value === 'string' && inp.value.length > 200) return false;
          return true;
        });
        return { entity_id: strat.id, name: strat.name || strat.title, inputs: meaningful };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

/**
 * Set inputs on the active strategy study (does NOT require recompile).
 * Pass an object keyed by input id, e.g. `{ rsiLength: 21, buyLevel: 25 }`.
 */
export async function setStrategyInputs({ inputs }) {
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object keyed by input id (use strategy_get_inputs to list ids)');
  }
  const inputsJson = JSON.stringify(inputs);
  const result = await evaluate(`
    (function() {
      try {
        var chartApi = ${CHART_API};
        var widget = chartApi._chartWidget;
        var sources = widget.model().model().dataSources();
        var stratIds = {};
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (s.reportData && (s.ordersData || s.tradesData)) {
            var sid = (s.id && (typeof s.id === 'function' ? s.id() : s.id)) || null;
            if (sid) stratIds[sid] = true;
          }
        }
        var all = chartApi.getAllStudies();
        var strat = null;
        for (var i = 0; i < all.length; i++) { if (stratIds[all[i].id]) { strat = all[i]; break; } }
        if (!strat) return { error: 'No strategy on chart.' };
        var current = strat.getInputValues();
        var overrides = ${inputsJson};
        var unknown = [];
        var applied = {};
        var validIds = {};
        for (var c = 0; c < current.length; c++) validIds[current[c].id] = true;
        for (var key in overrides) {
          if (!validIds[key]) { unknown.push(key); continue; }
        }
        for (var i2 = 0; i2 < current.length; i2++) {
          if (overrides.hasOwnProperty(current[i2].id)) {
            current[i2].value = overrides[current[i2].id];
            applied[current[i2].id] = overrides[current[i2].id];
          }
        }
        strat.setInputValues(current);
        return { entity_id: strat.id, applied: applied, unknown_keys: unknown };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

/**
 * Generate the cartesian product of input value lists, capped at `cap` combos.
 * Each entry of `axes` is { id, values: [...] }.
 */
function cartesian(axes, cap) {
  let combos = [{}];
  for (const axis of axes) {
    const next = [];
    for (const c of combos) {
      for (const v of axis.values) {
        next.push({ ...c, [axis.id]: v });
        if (next.length >= cap) break;
      }
      if (next.length >= cap) break;
    }
    combos = next;
    if (combos.length >= cap) break;
  }
  return combos;
}

/**
 * Grid-search the active strategy by varying input values, running the
 * backtest for each combination, and returning a ranked leaderboard.
 *
 * axes: [{ id: "rsiLength", values: [9,14,21] }, { id: "buyLevel", values: [20,30] }]
 * metric: which key from the summary to rank by (default "sharpe_ratio").
 * direction: "max" (default) or "min".
 * max_combinations: hard cap (default 25) to keep wall-clock sane.
 * settle_ms: per-combo settle time between setInputValues and reading metrics (default 1800).
 */
export async function gridSearch({ axes, metric = 'sharpe_ratio', direction = 'max', max_combinations = 25, settle_ms = 1800 } = {}) {
  if (!Array.isArray(axes) || axes.length === 0) {
    throw new Error('axes is required: [{id:"rsiLength",values:[9,14,21]}, ...]');
  }
  for (const a of axes) {
    if (!a || !a.id || !Array.isArray(a.values) || a.values.length === 0) {
      throw new Error('Each axis needs {id:string, values:array<non-empty>}');
    }
  }
  const cap = Math.min(Math.max(1, max_combinations), 200);
  const combos = cartesian(axes, cap);
  if (combos.length === 0) throw new Error('Cartesian product produced 0 combinations');

  // Snapshot current inputs so we can restore at the end.
  const baselineRaw = await getStrategyInputs();
  const baselineMap = {};
  for (const inp of baselineRaw.inputs || []) baselineMap[inp.id] = inp.value;

  const rows = [];
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    try { await setStrategyInputs({ inputs: c }); }
    catch (e) { rows.push({ inputs: c, error: e.message }); continue; }
    await new Promise(r => setTimeout(r, settle_ms));
    let summary;
    try { summary = await getStrategyResults({ summary: true }); }
    catch (e) { rows.push({ inputs: c, error: e.message }); continue; }
    const m = summary?.metrics || {};
    rows.push({
      inputs: c,
      net_profit: m.net_profit,
      net_profit_pct: m.net_profit_pct,
      total_trades: m.total_trades,
      win_rate: m.percent_profitable,
      profit_factor: m.profit_factor,
      sharpe_ratio: m.sharpe_ratio,
      sortino_ratio: m.sortino_ratio,
      max_drawdown: m.max_drawdown,
      max_drawdown_pct: m.max_drawdown_pct,
      avg_trade: m.avg_trade,
    });
  }

  // Restore the original inputs.
  if (Object.keys(baselineMap).length > 0) {
    try { await setStrategyInputs({ inputs: baselineMap }); }
    catch (e) { /* non-fatal */ }
  }

  // Rank by chosen metric.
  const finite = rows.filter(r => typeof r[metric] === 'number' && Number.isFinite(r[metric]));
  const ranked = [...finite].sort((a, b) => direction === 'min' ? a[metric] - b[metric] : b[metric] - a[metric]);
  const errored = rows.filter(r => r.error);

  return {
    success: true,
    metric, direction,
    total_combinations: combos.length,
    successful: ranked.length,
    failed: errored.length,
    leaderboard: ranked.slice(0, 20),
    failures: errored.slice(0, 5),
    note: `Restored original inputs. Top result by ${metric}: ${ranked[0] ? JSON.stringify(ranked[0].inputs) : 'none'}`,
  };
}

/**
 * Validate the active strategy's backtest against quality thresholds.
 * thresholds: { min_sharpe?, min_profit_factor?, max_drawdown_pct?,
 *               min_trades?, min_win_rate?, min_net_profit_pct? }
 * Returns { pass, checks: [{name, value, threshold, op, pass}] }.
 */
export async function validateQuality({ thresholds = {} } = {}) {
  const summary = await getStrategyResults({ summary: true });
  if (!summary?.metrics || Object.keys(summary.metrics).length === 0) {
    throw new Error(summary?.error || 'No strategy metrics available. Add a strategy and let the backtest run first.');
  }
  const m = summary.metrics;
  const checks = [];
  const tryCheck = (name, op, value, threshold) => {
    if (threshold === undefined || threshold === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      checks.push({ name, op, value, threshold, pass: false, note: 'metric not available' });
      return;
    }
    const pass = op === '>=' ? value >= threshold : op === '<=' ? value <= threshold : value === threshold;
    checks.push({ name, op, value, threshold, pass });
  };
  tryCheck('sharpe_ratio', '>=', m.sharpe_ratio, thresholds.min_sharpe);
  tryCheck('profit_factor', '>=', m.profit_factor, thresholds.min_profit_factor);
  tryCheck('max_drawdown_pct', '<=', Math.abs(m.max_drawdown_pct || 0), thresholds.max_drawdown_pct);
  tryCheck('total_trades', '>=', m.total_trades, thresholds.min_trades);
  tryCheck('percent_profitable', '>=', m.percent_profitable, thresholds.min_win_rate);
  tryCheck('net_profit_pct', '>=', m.net_profit_pct, thresholds.min_net_profit_pct);
  const allPass = checks.length > 0 && checks.every(c => c.pass);
  return {
    success: true,
    pass: allPass,
    failed_count: checks.filter(c => !c.pass).length,
    checks_total: checks.length,
    metrics_snapshot: {
      sharpe_ratio: m.sharpe_ratio,
      profit_factor: m.profit_factor,
      max_drawdown_pct: m.max_drawdown_pct,
      total_trades: m.total_trades,
      percent_profitable: m.percent_profitable,
      net_profit_pct: m.net_profit_pct,
    },
    checks,
  };
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

// ─────────────────────────────────────────────────────────────────────────────
//  CSV export (v2.4.0) — returns file path, not file body, so large datasets
//  bypass the MCP context window.
// ─────────────────────────────────────────────────────────────────────────────

function escapeCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Export the active Strategy Tester's closed-trade list OR equity-curve data
 * to a CSV file under `<repo>/exports/`. Returns the absolute path; the file
 * body is never returned through MCP so very large datasets don't blow context.
 *
 *   exportCsv({ kind: 'trades', max_rows: 5000 })
 *   exportCsv({ kind: 'equity', filename: 'audit-equity' })
 */
export async function exportCsv({ kind, filename, max_rows = 10000 } = {}) {
  if (kind !== 'trades' && kind !== 'equity') {
    throw new Error(`kind must be 'trades' or 'equity'; got ${JSON.stringify(kind)}`);
  }
  mkdirSync(EXPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${kind}_${ts}`).replace(/[\/\\]/g, '_');
  const filePath = join(EXPORTS_DIR, `${fname}.csv`);

  if (kind === 'trades') {
    // Bypass the 20-trade cap of getTrades by reading the raw strategy report
    // — `metrics.trades` (when opted in) holds the full closed-trade list.
    const result = await getStrategyResults({ summary: false, include: ['trades'] });
    if (!result?.metrics || Object.keys(result.metrics).length === 0) {
      throw new Error(result?.error || 'No strategy report available. Run pine_deploy_strategy first.');
    }
    const trades = Array.isArray(result.metrics.trades) ? result.metrics.trades : [];
    const capped = trades.slice(0, max_rows);

    // Discover columns from the first 20 rows (TradingView trade records have
    // varying schemas; keep only primitive-valued keys for stable CSV columns).
    const colSet = new Set();
    for (const t of capped.slice(0, 20)) {
      if (t && typeof t === 'object') {
        for (const k of Object.keys(t)) {
          const v = t[k];
          if (v == null) continue;
          const tp = typeof v;
          if (tp === 'string' || tp === 'number' || tp === 'boolean') colSet.add(k);
        }
      }
    }
    const columns = Array.from(colSet);

    if (capped.length === 0) {
      writeFileSync(filePath, 'note\nNo closed trades available — strategy has not produced any trades yet.\n');
      return {
        success: true, file_path: filePath, kind, rows_written: 0, columns: [],
        total_available: trades.length,
        note: 'Trades array was empty. CSV written with a placeholder note row.',
      };
    }

    const lines = [columns.map(escapeCsvField).join(',')];
    for (const t of capped) {
      const row = columns.map(c => escapeCsvField(t && typeof t === 'object' ? t[c] : ''));
      lines.push(row.join(','));
    }
    writeFileSync(filePath, lines.join('\n') + '\n');
    return {
      success: true,
      file_path: filePath,
      kind,
      rows_written: capped.length,
      columns,
      total_available: trades.length,
      truncated: trades.length > max_rows,
    };
  }

  // kind === 'equity'
  const eq = await getEquity();
  if (eq?.error) throw new Error(eq.error);
  const data = Array.isArray(eq.data) ? eq.data : [];

  if (data.length === 0 && eq.equity_summary && Object.keys(eq.equity_summary).length > 0) {
    // Fallback: bar-by-bar equity not available, write the summary metrics instead.
    const sumKeys = Object.keys(eq.equity_summary);
    const lines = [sumKeys.map(escapeCsvField).join(',')];
    lines.push(sumKeys.map(k => escapeCsvField(eq.equity_summary[k])).join(','));
    writeFileSync(filePath, lines.join('\n') + '\n');
    return {
      success: true, file_path: filePath, kind: 'equity_summary', rows_written: 1, columns: sumKeys,
      note: 'Bar-by-bar equity curve not exposed by TradingView API; wrote single-row summary metrics instead.',
    };
  }

  const capped = data.slice(0, max_rows);
  const columns = ['bar_index', 'time', 'equity', 'drawdown'];
  const lines = [columns.join(',')];
  for (let i = 0; i < capped.length; i++) {
    const d = capped[i] || {};
    lines.push([
      String(i),
      escapeCsvField(d.time),
      escapeCsvField(d.equity),
      escapeCsvField(d.drawdown),
    ].join(','));
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
  return {
    success: true,
    file_path: filePath,
    kind,
    rows_written: capped.length,
    columns,
    total_available: data.length,
    truncated: data.length > max_rows,
  };
}
