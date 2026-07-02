/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite, getClient } from '../connection.js';
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
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];

    // T108 (2026-05-13): combine descriptor lookup + createStudy + 1500ms wait
    // + new-id snapshot into one evaluateAsync. Two bugs fixed here:
    //
    //   Bug 1 (T107 smoke discovery): chart.createStudy(<bare title>) throws
    //     "unexpected study id:<lowercase>" for user scripts. TV's name→token
    //     map covers built-ins only (Volume@..., MACD@..., etc.). User scripts
    //     need the studyData.descriptor OBJECT reached through
    //     TradingViewApi._studyMarket._dialog._studies['Script$USER'] (populated
    //     by _updateUserStudies via T107's pine_refresh_catalog mechanism).
    //
    //   Bug 2 (upstream Issue #142): add-path failure leaves TV's Indicators
    //     dialog stuck open. Subsequent automation fails until manual Escape.
    //     Fix: dispatch synthetic Escape via CDP Input.dispatchKeyEvent on
    //     any failure path (pattern from watchlist.js:731-732).
    const result = await evaluateAsync(`
      (async function() {
        var chart = ${CHART_API};
        var beforeIds = chart.getAllStudies().map(function(s) { return s.id; });
        var resolution = 'fallback';
        var firstArg = ${safeString(indicator)};

        // User-script descriptor lookup. Populate cache via T107's mechanism if empty.
        try {
          var api = window.TradingViewApi;
          var dlg = api && api._studyMarket && api._studyMarket._dialog;
          if (dlg) {
            var us0 = (dlg._studies && dlg._studies['Script$USER']) || [];
            if (us0.length === 0 && dlg._initIndicatorsPromises && dlg._updateUserStudies) {
              dlg._initIndicatorsPromises.userScriptsPromise = fetch(
                'https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',
                { credentials: 'include' }
              ).then(function(r) { return r.json(); });
              try { await dlg._updateUserStudies(); } catch (_) {}
            }
            var us = (dlg._studies && dlg._studies['Script$USER']) || [];
            var want = ${safeString(indicator)}.toLowerCase();
            var match = null;
            for (var i = 0; i < us.length; i++) {
              if ((us[i].title || '').toLowerCase() === want) { match = us[i]; break; }
            }
            if (match && match.studyData && match.studyData.descriptor) {
              firstArg = match.studyData.descriptor;
              resolution = 'descriptor';
            }
          }
        } catch (_) {}

        // Call createStudy. For user scripts it returns a Promise; for built-ins it returns synchronously.
        var createErr = null;
        try {
          var cs = chart.createStudy(firstArg, false, false, ${JSON.stringify(inputArr)});
          if (cs && typeof cs.then === 'function') {
            try { await cs; } catch (e) { createErr = String(e && e.message || e); }
          }
        } catch (e) { createErr = String(e && e.message || e); }

        await new Promise(function(r) { setTimeout(r, 1500); });
        var afterIds = chart.getAllStudies().map(function(s) { return s.id; });
        var newIds = afterIds.filter(function(id) { return beforeIds.indexOf(id) === -1; });

        return { beforeIds: beforeIds, afterIds: afterIds, newIds: newIds, resolution: resolution, createErr: createErr };
      })()
    `);

    if (result && result.newIds && result.newIds.length > 0) {
      return {
        success: true,
        action: 'add',
        indicator,
        entity_id: result.newIds[0],
        new_study_count: result.newIds.length,
        resolution: result.resolution,
      };
    }

    // Failure path — dispatch Escape via CDP to clear stuck dialog state.
    let recovery_attempted = false;
    try {
      const { getClient } = await import('../connection.js');
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
      recovery_attempted = true;
    } catch (_) {}

    return {
      success: false,
      action: 'add',
      indicator,
      entity_id: null,
      new_study_count: 0,
      resolution: result && result.resolution,
      error: (result && result.createErr) || 'no new study after 1500ms',
      recovery_attempted,
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
  const { evaluate, evaluateAsync } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);

  // ---------------------------------------------------------------------
  // Strategy A — drive TradingView's native "Go to date" dialog (Alt+G).
  //
  // This is the only approach that works reliably when the requested date is
  // older than the bars currently cached on the chart. The TV widget APIs
  // (`activeChart().setVisibleRange`, `_activeChartWidgetWV.value().setVisibleRange`)
  // both exist on the prototype but throw "Not implemented" on Desktop. The
  // timeScale().zoomToBarsRange / scrollToBar / scrollTo methods only operate
  // within already-loaded bars and will silently no-op for older windows.
  //
  // The native dialog, by contrast, is wired into TV's data feed and
  // reliably triggers a historical bars fetch.
  //
  // Strategy B (fallback) — zoomToBarsRange over loaded bars. Used only if
  // the dialog flow fails (dialog never opens, inputs not found, etc.).
  // ---------------------------------------------------------------------
  const targetIso = new Date(timestamp * 1000).toISOString();
  const targetDate = targetIso.slice(0, 10);    // YYYY-MM-DD (UTC)
  const targetTime = targetIso.slice(11, 16);   // HH:MM (UTC)

  let strategy = 'unknown';
  let dialogOk = false;
  try {
    const c = await getClient();
    // Press Alt+G to open TV's "Go to date" dialog.
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'g', code: 'KeyG' });

    // Wait for the dialog's date input to appear (poll up to ~1.5s).
    const dialogReady = await evaluateAsync(`
      (function() {
        return new Promise(function(resolve) {
          var deadline = Date.now() + 1500;
          (function poll() {
            var input = document.querySelector('input[placeholder="YYYY-MM-DD"]');
            if (input) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(poll, 50);
          })();
        });
      })()
    `);

    if (dialogReady) {
      // Fill date + time inputs using a React-friendly value setter.
      const filled = await evaluate(`
        (function() {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          var dateInput = document.querySelector('input[placeholder="YYYY-MM-DD"]');
          if (!dateInput) return { ok: false, error: 'date input gone' };
          setter.call(dateInput, ${safeString(targetDate)});
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));

          // Time input is the second visible text input in the dialog.
          var dialog = dateInput.closest('[role="dialog"]') || document.body;
          var inputs = dialog.querySelectorAll('input[type="text"]');
          if (inputs.length >= 2) {
            var timeInput = inputs[1];
            setter.call(timeInput, ${safeString(targetTime)});
            timeInput.dispatchEvent(new Event('input', { bubbles: true }));
            timeInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          // Click the "Go to" submit button (last "Go to" — first occurrence is the title).
          var buttons = Array.prototype.slice.call(dialog.querySelectorAll('button'))
            .filter(function(b) { return /^Go to$/i.test((b.textContent || '').trim()); });
          if (buttons.length === 0) return { ok: false, error: 'submit button not found' };
          buttons[buttons.length - 1].click();
          return { ok: true };
        })()
      `);

      if (filled && filled.ok) {
        // Wait for the dialog to close — that signals the chart is panning.
        await evaluateAsync(`
          (function() {
            return new Promise(function(resolve) {
              var deadline = Date.now() + 3000;
              (function poll() {
                var input = document.querySelector('input[placeholder="YYYY-MM-DD"]');
                if (!input) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 80);
              })();
            });
          })()
        `);
        dialogOk = true;
        strategy = 'native_dialog';
      } else {
        strategy = 'native_dialog_fill_failed:' + (filled && filled.error || 'unknown');
      }
    } else {
      strategy = 'native_dialog_not_ready';
    }
  } catch (e) {
    strategy = 'native_dialog_error:' + (e.message || 'unknown');
  }

  // Strategy B fallback — zoomToBarsRange. Used when the dialog flow fails.
  if (!dialogOk) {
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
        try {
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
        } catch (e) {}
      })()
    `);
    strategy = strategy + '+zoomToBarsRange';
  }

  // Brief settle so post-load redraws complete before the caller screenshots.
  await new Promise(r => setTimeout(r, 600));
  return { success: true, date, centered_on: timestamp, resolution, strategy };
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

  // Defensive array extraction. The previous `data.symbols || data || []`
  // evaluated `{}` as truthy and let `.slice()` throw if the API ever
  // returned an object without a `symbols` field (schema drift).
  const arr = Array.isArray(data) ? data
    : Array.isArray(data && data.symbols) ? data.symbols
    : [];

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = arr.slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
