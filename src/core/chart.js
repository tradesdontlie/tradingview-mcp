/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite, parseJsonArg, KNOWN_PATHS } from '../connection.js';
import { waitForChartReady as _waitForChartReady, pollUntil as _pollUntil } from '../wait.js';

const CHART_API = KNOWN_PATHS.chartApi;

// Delay after setSymbol() to let the page-side setSymbol callback fire before we
// begin polling for chart readiness; matches TV's internal symbol-switch latency.
const SYMBOL_SWITCH_SETTLE_MS = 500;
// Studies are added asynchronously — bound the poll for createStudy() to register
// the new entity before diffing the study list to report the new id. Same elapsed
// budget as the former fixed sleep, but returns early once the study appears.
const STUDY_ADD_SETTLE_MS = 1500;
const STUDY_ADD_POLL_INTERVAL_MS = 150;
// Allow zoomToBarsRange() to apply before reading back the actual visible range.
const ZOOM_SETTLE_MS = 500;

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    pollUntil: deps?.pollUntil || _pollUntil,
  };
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, ${SYMBOL_SWITCH_SETTLE_MS});
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  if (!ready) {
    return {
      success: false,
      error: 'Chart did not stabilize within timeout (symbol/timeframe may not have applied)',
      chart_ready: false,
      symbol,
    };
  }
  return { success: true, symbol, chart_ready: true };
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
  if (!ready) {
    return {
      success: false,
      error: 'Chart did not stabilize within timeout (symbol/timeframe may not have applied)',
      chart_ready: false,
      timeframe,
    };
  }
  return { success: true, timeframe, chart_ready: true };
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
  const { evaluate, pollUntil } = _resolve(_deps);
  const inputs = parseJsonArg(inputsRaw, 'inputs');

  if (action === 'add') {
    // TradingView's createStudy expects `inputs` as a POSITIONAL array of
    // values, matching the study's declared input order. The {id, value}
    // shape (used by Pine's applyOverrides) is silently accepted but never
    // wired to the calculation engine — the study runs with default values
    // while properties() reports the requested override, producing
    // identical-looking-but-wrong series across multiple studies of the
    // same type.
    //
    // Object inputs are inherently positionally ambiguous at add-time: the
    // study's declared input order is only readable from its metaInfo AFTER
    // the study is created, so we cannot reliably map a multi-key object to
    // the correct positional slots before calling createStudy(). We therefore:
    //   - accept arrays verbatim (already positional → exact), and
    //   - accept a SINGLE-key object (unambiguous — one value, one slot), but
    //   - REJECT multi-key objects with actionable guidance to pass an array,
    //     rather than silently permuting positional inputs via Object.values.
    let inputArr = [];
    if (Array.isArray(inputs)) {
      inputArr = inputs;
    } else if (inputs && typeof inputs === 'object') {
      const keys = Object.keys(inputs);
      if (keys.length > 1) {
        throw new Error(
          `Ambiguous indicator inputs: an object with multiple keys (${keys.join(', ')}) ` +
          `cannot be mapped to the study's declared positional input order at add-time. ` +
          `Pass inputs as an ordered array of values instead (e.g. [20, "close"]).`
        );
      }
      inputArr = Object.values(inputs);
    }
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    const beforeCount = (before || []).length;
    // Bounded poll: return as soon as the study list grows past its prior length,
    // or give up after the same elapsed budget as the old fixed sleep.
    let after = await pollUntil(async () => {
      const ids = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      return (ids || []).length > beforeCount ? ids : null;
    }, { interval: STUDY_ADD_POLL_INTERVAL_MS, timeout: STUDY_ADD_SETTLE_MS });
    // On timeout, fall back to a final read so we still report whatever exists.
    if (!after) after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
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

/**
 * Builds the page-side snippet that finds the bar-index range spanning
 * [fromTime, toTime] (unix seconds) and zooms the time scale to it.
 * Shared by setVisibleRange and scrollToDate so the scan lives in one place.
 */
export function findBarIndexRange(fromTime, toTime) {
  return `
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${fromTime} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${toTime}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);`;
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      ${findBarIndexRange(f, t)}
    })()
  `);
  await new Promise(r => setTimeout(r, ZOOM_SETTLE_MS));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date, _deps } = {}) {
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
      ${findBarIndexRange(from, to)}
    })()
  `);
  await new Promise(r => setTimeout(r, ZOOM_SETTLE_MS));
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
