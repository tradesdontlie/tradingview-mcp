/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns { ready: bool, lastState: {...} } describing the final observed
 * editor state. Callers that want a simple boolean can read `.ready`.
 *
 * B12 fix: surface diagnostic state (panel/container/monaco visibility) so
 * callers can include it in error responses when timeout occurs.
 *
 * @param {object} [opts]
 * @param {Function} [opts._evaluate] — DI hook for testing.
 */
export async function ensurePineEditorOpen({ _evaluate } = {}) {
  const ev = _evaluate || evaluate;

  // Diagnostic probe — returns shape of editor environment for reporting.
  const PROBE = `
    (function() {
      var container = document.querySelector('.monaco-editor.pine-editor-monaco');
      var panel = document.querySelector('[class*="pine-editor"]')
        || document.querySelector('[class*="layout__area--bottom"]');
      var monacoFound = ${FIND_MONACO} !== null;
      return {
        monaco_ready: monacoFound,
        container_present: container !== null,
        container_visible: container !== null && container.offsetParent !== null,
        panel_present: panel !== null,
        panel_visible: panel !== null && panel.offsetParent !== null,
      };
    })()
  `;

  let lastState = await ev(PROBE);
  if (lastState && lastState.monaco_ready) return { ready: true, lastState };

  await ev(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await ev(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    lastState = await ev(PROBE);
    if (lastState && lastState.monaco_ready) return { ready: true, lastState };
  }
  return { ready: false, lastState: lastState || { monaco_ready: false } };
}

/**
 * Format the diagnostic state from ensurePineEditorOpen into an error message.
 */
function formatEditorOpenError(lastState) {
  if (!lastState) return 'Could not open Pine Editor (no diagnostic state captured).';
  const parts = [];
  if (!lastState.panel_present) parts.push('Pine editor panel not in DOM');
  else if (!lastState.panel_visible) parts.push('Pine editor panel hidden');
  if (!lastState.container_present) parts.push('Monaco container not found');
  else if (!lastState.container_visible) parts.push('Monaco container hidden');
  if (lastState.container_present && !lastState.monaco_ready) parts.push('Monaco DOM exists but React fiber/editor instance not yet attached');
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return `Could not open Pine Editor or Monaco not found in React fiber tree${detail}.`;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return { success: true, lines_set: source.split('\n').length };
}

// JS expression that returns the current chart's study count (or null on failure).
const STUDY_COUNT_EXPR = `
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
    } catch(e) {}
    return null;
  })()
`;

export async function compile({ _deps } = {}) {
  const ev = (_deps && _deps.evaluate) || evaluate;
  const getCdpClient = (_deps && _deps.getClient) || getClient;

  const editor = await ensurePineEditorOpen({ _evaluate: ev });
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const studiesBefore = await ev(STUDY_COUNT_EXPR);

  const clicked = await ev(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  let keyboardFallback = false;
  if (!clicked) {
    keyboardFallback = true;
    const c = await getCdpClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));

  // B9 fix: verify keyboard fallback by comparing study counts before/after.
  const studiesAfter = await ev(STUDY_COUNT_EXPR);
  let studyAdded = null;
  if (studiesBefore !== null && studiesAfter !== null) {
    studyAdded = studiesAfter > studiesBefore;
  }

  const result = {
    success: true,
    button_clicked: clicked || 'keyboard_shortcut',
    source: 'dom_fallback',
    studies_before: studiesBefore,
    studies_after: studiesAfter,
    study_added: studyAdded,
  };

  if (keyboardFallback && studyAdded === null) {
    result.verification = 'unverified_keyboard_fallback';
    result.note = 'No compile button found; dispatched Ctrl+Enter but study count could not be read to verify.';
  }

  return result;
}

export async function getErrors() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile({ _deps } = {}) {
  const ev = (_deps && _deps.evaluate) || evaluate;
  const getCdpClient = (_deps && _deps.getClient) || getClient;

  const editor = await ensurePineEditorOpen({ _evaluate: ev });
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const studiesBefore = await ev(STUDY_COUNT_EXPR);

  // B5 fix: priority order is
  //   1. "Save and add to chart" (single-click combo on a brand-new script)
  //   2. "Update on chart" (a previous instance is already on chart)
  //   3. "Add to chart" (compiles + adds — what most callers actually want)
  //   4. "Save" (LAST RESORT — only persists; does NOT add/compile to chart)
  // The previous bug preferred "Save" before "Add to chart", so smart_compile
  // never actually compiled the script onto the chart.
  const buttonClicked = await ev(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text) && btns[i].offsetParent !== null && !btns[i].disabled) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text) && btns[i].offsetParent !== null && !btns[i].disabled) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null && !btns[i].disabled) saveBtn = btns[i];
      }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  let keyboardFallback = false;
  if (!buttonClicked) {
    keyboardFallback = true;
    const c = await getCdpClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await ev(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await ev(STUDY_COUNT_EXPR);
  const countDelta = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter - studiesBefore : null;

  // Determine outcome based on the button we clicked + study count delta.
  // We use the *clicked* button as the source-of-truth signal, and verify
  // against the count delta where possible.
  let studyAdded = null;
  let studyUpdated = false;
  let studySaved = false;
  let note;

  if (buttonClicked === 'Update on chart') {
    studyUpdated = true;
    // Update doesn't change the count — same instance re-compiled.
    studyAdded = false;
  } else if (buttonClicked === 'Add to chart' || buttonClicked === 'Save and add to chart') {
    if (countDelta !== null) {
      studyAdded = countDelta > 0;
    } else {
      studyAdded = null;
    }
  } else if (buttonClicked === 'Pine Save') {
    studyAdded = false;
    studySaved = true;
    note = 'Only a Pine "Save" button was available — the script was persisted to your saved scripts but was NOT compiled/added to the chart. To add it, ensure the editor instance is connected to a chart and that an "Add to chart" or "Update on chart" button is visible.';
  } else {
    // Keyboard fallback. Verify via count delta if possible.
    if (countDelta !== null) studyAdded = countDelta > 0;
    else studyAdded = null;
  }

  const result = {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    study_updated: studyUpdated,
    study_saved: studySaved,
    studies_before: studiesBefore,
    studies_after: studiesAfter,
  };

  if (note) result.note = note;
  if (keyboardFallback && studyAdded === null) {
    result.verification = 'unverified_keyboard_fallback';
  }

  return result;
}

export async function newScript({ type }) {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw new Error(formatEditorOpenError(editor.lastState));

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
