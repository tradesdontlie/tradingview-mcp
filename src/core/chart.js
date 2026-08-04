/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
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
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
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
  return { success: true, timeframe, chart_ready: ready };
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
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, []);
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    const entityId = newIds[0] || null;

    // createStudy's inputs argument is unreliable across builds (#249): the
    // study is created with defaults regardless. Apply overrides afterward
    // via the study's own getInputValues/setInputValues, then read back to
    // report what actually took.
    let appliedInputs;
    if (entityId && inputs && Object.keys(inputs).length) {
      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var study = chart.getStudyById(${safeString(entityId)});
          if (!study || typeof study.getInputValues !== 'function') return { error: 'inputs unsupported for this study' };
          var current = study.getInputValues();
          var overrides = ${JSON.stringify(inputs)};
          var applied = {}, unknown = [];
          var byId = {};
          for (var i = 0; i < current.length; i++) byId[current[i].id] = true;
          for (var k in overrides) {
            if (byId[k]) { for (var j = 0; j < current.length; j++) { if (current[j].id === k) current[j].value = overrides[k]; } applied[k] = overrides[k]; }
            else unknown.push(k);
          }
          study.setInputValues(current);
          var after = study.getInputValues();
          var confirmed = {};
          for (var m = 0; m < after.length; m++) { if (applied.hasOwnProperty(after[m].id)) confirmed[after[m].id] = after[m].value; }
          return { confirmed: confirmed, unknown: unknown };
        })()
      `);
      if (result?.error) appliedInputs = { error: result.error };
      else appliedInputs = { applied: result?.confirmed || {}, ...(result?.unknown?.length && { unknown_inputs: result.unknown }) };
    }

    return {
      success: newIds.length > 0,
      action: 'add',
      indicator,
      entity_id: entityId,
      new_study_count: newIds.length,
      ...(appliedInputs && { inputs: appliedInputs }),
    };
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

  // Ensure enough history is loaded to cover `from`. The chart lazy-loads bars
  // (~300 initially), so without this a multi-year range clamps to whatever is
  // already loaded. Page back via requestMoreData until the earliest loaded bar
  // reaches `from`, the feed runs out, or a guard trips.
  for (let i = 0; i < 25; i++) {
    const state = await evaluate(`(function() {
      var ms = ${CHART_API}._chartWidget.model().mainSeries();
      var b = ms.bars(); var fv = b.valueAt(b.firstIndex());
      var more = true; try { more = ms.requestMoreDataAvailable(); } catch (e) {}
      return { firstTime: fv && fv[0], more: more };
    })()`);
    if (!state || state.firstTime == null || state.firstTime <= f || !state.more) break;
    await evaluate(`(function() { try { ${CHART_API}._chartWidget.model().mainSeries().requestMoreData(1000); } catch (e) {} })()`);
    await new Promise(r => setTimeout(r, 1800));
  }

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

// ---- Comparison / overlay symbols ----
// A "comparison" in TradingView is the built-in 'Compare' study, whose inputs
// are a symbol + a price source. We reuse the createStudy + input-readback path
// proven in manageIndicator (#249: createStudy's inputs arg is unreliable across
// builds, so the symbol/source inputs are (re)applied AFTER creation).
const COMPARE_STUDY = 'Compare@tv-basicstudies';

export async function addComparison({ symbol, as_series, source, _deps }) {
  if (!symbol) throw new Error('symbol is required to add a comparison.');
  const { evaluate } = _resolve(_deps);
  const src = source || 'close';
  // as_series=true overlays the compared symbol on the main price scale as a
  // full series (forceOverlay); false (default) adds it as a separate/percent
  // scale comparison line.
  const forceOverlay = as_series === true;

  const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.createStudy(${safeString(COMPARE_STUDY)}, ${forceOverlay}, false, [${safeString(symbol)}, ${safeString(src)}]);
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
  const newIds = (after || []).filter(id => !(before || []).includes(id));
  const entityId = newIds[0] || null;

  // createStudy's inputs arg is unreliable (#249) — force the symbol/source
  // inputs via the study's own getInputValues/setInputValues, then read back.
  let applied = null;
  if (entityId) {
    applied = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        var study = chart.getStudyById(${safeString(entityId)});
        if (!study || typeof study.getInputValues !== 'function') return { error: 'compare study has no input API' };
        var cur = study.getInputValues();
        var wantSym = ${safeString(symbol)}, wantSrc = ${safeString(src)};
        var set = {};
        for (var i = 0; i < cur.length; i++) {
          var id = cur[i].id, t = cur[i].type;
          if (id === 'symbol' || t === 'symbol') { cur[i].value = wantSym; set.symbol = wantSym; }
          else if (id === 'source' || id === 'source_input') { cur[i].value = wantSrc; set.source = wantSrc; }
        }
        study.setInputValues(cur);
        var readback = study.getInputValues(), confirm = {};
        for (var j = 0; j < readback.length; j++) { if (set.hasOwnProperty(readback[j].id)) confirm[readback[j].id] = readback[j].value; }
        return { confirmed: confirm };
      })()
    `);
  }

  return {
    success: newIds.length > 0,
    action: 'add_comparison',
    symbol,
    source: src,
    as_series: forceOverlay,
    entity_id: entityId,
    ...(applied && (applied.error ? { input_warning: applied.error } : { inputs: applied.confirmed })),
  };
}

export async function removeComparison({ symbol, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  // A comparison is specifically the built-in Compare study. Identify it by its
  // (non-localized) metaInfo script id — NOT merely by "has a symbol input",
  // which would also match Correlation Coefficient, comparative RS, Spread/Ratio,
  // etc. and irreversibly remove them (especially in the remove-all path).
  // Among confirmed Compare studies, match on the symbol input's value
  // (case-insensitive, exchange prefix optional); with no symbol, remove them all.
  const removed = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var want = ${symbol ? safeString(String(symbol).toUpperCase()) : 'null'};
      function norm(s) { s = String(s || '').toUpperCase(); var c = s.indexOf(':'); return c >= 0 ? s.slice(c + 1) : s; }
      function isCompareStudy(study) {
        try {
          var mi = study.metaInfo ? study.metaInfo() : null;
          if (!mi) return false;
          var scriptId = String(mi.id || mi.shortId || mi.fullId || '');
          if (scriptId) return scriptId.split('@')[0] === 'Compare';
          // Only if no id field is exposed, fall back to an exact description match.
          return String(mi.description || mi.shortDescription || '') === 'Compare';
        } catch (e) { return false; }
      }
      var studies = chart.getAllStudies();
      var hits = [];
      for (var i = 0; i < studies.length; i++) {
        var id = studies[i].id;
        var study = null; try { study = chart.getStudyById(id); } catch (e) {}
        if (!study || !isCompareStudy(study)) continue; // only genuine Compare studies
        var val = '';
        try {
          if (typeof study.getInputValues === 'function') {
            var inputs = study.getInputValues();
            for (var j = 0; j < inputs.length; j++) {
              if (inputs[j].id === 'symbol' || inputs[j].type === 'symbol') { val = String(inputs[j].value || ''); break; }
            }
          }
        } catch (e) {}
        if (want === null || (val && (norm(val) === norm(want) || val.toUpperCase() === want))) {
          hits.push({ entity_id: id, symbol: val, name: studies[i].name });
        }
      }
      for (var k = 0; k < hits.length; k++) { try { chart.removeEntity(hits[k].entity_id); } catch (e) {} }
      return hits;
    })()
  `);
  return {
    success: (removed || []).length > 0,
    action: 'remove_comparison',
    ...(symbol && { symbol }),
    removed: removed || [],
    removed_count: (removed || []).length,
  };
}
