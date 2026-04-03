/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const FALLBACK_CHART_TYPES = {
  Bars: 0,
  Candles: 1,
  Line: 2,
  Area: 3,
  Renko: 4,
  Kagi: 5,
  PointAndFigure: 6,
  LineBreak: 7,
  HeikinAshi: 8,
  HollowCandles: 9,
};

export async function getState() {
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

export async function setSymbol({ symbol }) {
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${symbol.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe }) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution('${timeframe.replace(/'/g, "\\'")}', {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type }) {
  const available = await getAvailableChartTypes();
  const typeMap = available.length
    ? Object.fromEntries(available.map(({ name, value }) => [name, value]))
    : FALLBACK_CHART_TYPES;

  const typeNum = resolveChartType(chart_type, typeMap);
  if (isNaN(typeNum)) {
    const valid = formatAvailableChartTypes(typeMap);
    throw new Error(`Unknown chart type: ${chart_type}. Available chart types: ${valid}`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

async function getAvailableChartTypes() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var seen = {};
      var out = [];

      function push(name, value) {
        if (typeof value !== 'number' || !isFinite(value)) return;
        if (!name || typeof name !== 'string') name = String(value);
        var key = name + '|' + value;
        if (seen[key]) return;
        seen[key] = true;
        out.push({ name: name.replace(/\\s+/g, ''), value: value });
      }

      function read(entry, fallbackKey) {
        if (entry == null) return;
        if (Array.isArray(entry)) {
          for (var i = 0; i < entry.length; i++) read(entry[i], String(i));
          return;
        }
        if (typeof entry === 'object' && typeof entry.value === 'function') {
          try { read(entry.value(), fallbackKey); } catch (e) {}
          return;
        }
        if (typeof entry === 'object') {
          var name = entry.name || entry.title || entry.label || entry.text || entry.id || entry.key || fallbackKey;
          var value = entry.value;
          if (typeof value !== 'number') value = entry.type;
          if (typeof value !== 'number') value = entry.index;
          if (typeof value === 'number') push(name, value);
          return;
        }
      }

      function readObject(obj) {
        if (!obj || typeof obj !== 'object') return;
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var value = obj[key];
          if (typeof value === 'number') push(key, value);
          else if (value && typeof value === 'object') read(value, key);
        }
      }

      var candidates = [
        chart.chartTypes,
        chart.getChartTypes && chart.getChartTypes(),
        chart._chartTypes,
        chart._chartWidget && chart._chartWidget._chartTypes,
        window.TradingView && window.TradingView.ChartType,
        window.TradingView && window.TradingView.ChartTypes,
        window.ChartType,
        window.ChartTypes,
      ];

      for (var i = 0; i < candidates.length; i++) {
        read(candidates[i]);
        readObject(candidates[i]);
      }

      return out;
    })()
  `);
  return Array.isArray(result) ? result : [];
}

function resolveChartType(input, typeMap) {
  if (Object.prototype.hasOwnProperty.call(typeMap, input)) return typeMap[input];

  const normalized = String(input).replace(/\s+/g, '').toLowerCase();
  for (const [name, value] of Object.entries(typeMap)) {
    if (name.toLowerCase() === normalized) return value;
  }

  return Number(input);
}

function formatAvailableChartTypes(typeMap) {
  return Object.entries(typeMap)
    .sort((a, b) => a[1] - b[1])
    .map(([name, value]) => `${name}(${value})`)
    .join(', ');
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, ${JSON.stringify(inputArr)});
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
        chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to }) {
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
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
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

export async function symbolInfo() {
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
