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

// Build the error thrown by every Pine-tool when ensurePineEditorOpen fails.
// Keep one site so message format stays consistent and 9 call-sites stay terse.
function pineEditorError(diagnostic) {
  return new Error('Could not open Pine Editor. Diagnostic: ' + JSON.stringify(diagnostic || {}));
}

// Click strategies, in order of confidence. Each strategy is a small DOM
// script that returns a tag describing what (if anything) it clicked. The
// surrounding TS loop polls FIND_MONACO between strategies so a fast win
// short-circuits the rest.
//
// Verified live against TV Desktop 3.1.0 / Chrome 140:
//
// • Pine Editor lives in the footer panel (#footer-chart-panel) as a
//   tab-strip button. When the widget is NOT yet instantiated, the only
//   stable attribute is aria-label="Open <Widget Name>" (English locale).
//   data-qa-id appears only after the widget is opened once.
// • bwb.open() / show() in the new API take NO widget argument — they only
//   expand/visible the panel. The legacy bwb.activateScriptEditorTab and
//   bwb.showWidget('pine-editor') methods no longer exist.
// • The widget config name is 'scripteditor' (one word), not 'pine_editor'.
// • Synthetic Ctrl/Cmd+` does NOT trigger Pine Editor — no such hotkey.
const OPEN_PINE_STRATEGIES = `
  (function openPineEditor() {
    function clickIfVisible(el, tag) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      try { el.click(); return tag; } catch (e) { return null; }
    }

    // 1. Footer "Pine Editor" tab — qa-id is the most stable selector once
    //    the widget has been opened at least once in this session.
    var qa = document.querySelector('button[data-qa-id="scripteditor"]');
    var r = clickIfVisible(qa, 'data-qa-id=scripteditor'); if (r) return r;

    // 2. English aria-label — works on a fresh layout where Pine Editor
    //    has never been opened. Both "Open" (closed) and "Close" (already
    //    active) variants are valid click targets.
    r = clickIfVisible(document.querySelector('button[aria-label="Open Pine Editor"]'), 'aria=Open Pine Editor'); if (r) return r;
    r = clickIfVisible(document.querySelector('button[aria-label="Close Pine Editor"]'), 'aria=Close Pine Editor'); if (r) return r;

    // 3. Localised aria-label fallback — TV translates aria-label per
    //    locale. Scan the footer for any visible button whose aria-label or
    //    textContent contains "pine" (case-insensitive). data-qa-id text
    //    'scripteditor' isn't localised so prefer that when present.
    var footer = document.querySelector('#footer-chart-panel') || document.querySelector('[class*="footerPanel"]');
    if (footer) {
      var btns = footer.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        var txt = (b.textContent || '').toLowerCase();
        var qaid = (b.getAttribute('data-qa-id') || '').toLowerCase();
        if (qaid === 'scripteditor' || aria.indexOf('pine') >= 0 || /(^|\\s)pine($|\\s)/.test(txt)) {
          var tag = clickIfVisible(b, 'footer-scan[' + (qaid || aria || txt.slice(0,20)) + ']');
          if (tag) return tag;
        }
      }
    }

    // 4. Legacy bottomWidgetBar selectors — kept for older TV builds where
    //    the Pine button is rendered outside the footerPanel container.
    r = clickIfVisible(document.querySelector('[aria-label="Pine"]'), 'legacy-aria=Pine'); if (r) return r;
    r = clickIfVisible(document.querySelector('[data-name="pine-dialog-button"]'), 'legacy-data-name=pine-dialog-button'); if (r) return r;

    return null;
  })()
`;

// Snapshot what TV exposes so the caller's error message contains an
// actionable fingerprint of the failure mode. Keeps body lean — only what
// we need to distinguish "widget not enabled" from "API renamed".
const DIAGNOSTIC_SNAPSHOT = `
  (function() {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    var footer = document.querySelector('#footer-chart-panel') || document.querySelector('[class*="footerPanel"]');
    var footerButtons = [];
    if (footer) {
      var btns = footer.querySelectorAll('button');
      for (var i = 0; i < btns.length && footerButtons.length < 12; i++) {
        var b = btns[i];
        var rect = b.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        footerButtons.push({
          aria: (b.getAttribute('aria-label') || '').slice(0, 40),
          text: (b.textContent || '').trim().slice(0, 40),
          qa_id: b.getAttribute('data-qa-id') || '',
          active: b.getAttribute('data-active') === 'true',
        });
      }
    }
    var enabled = null, widgets = null, configKeys = null;
    if (bwb) {
      try { enabled = bwb._enabledWidgetsWV && typeof bwb._enabledWidgetsWV.value === 'function' ? bwb._enabledWidgetsWV.value() : null; } catch (e) {}
      try { widgets = bwb._widgets ? Object.keys(bwb._widgets) : null; } catch (e) {}
      try { configKeys = bwb._config ? Object.keys(bwb._config) : null; } catch (e) {}
    }
    var scripteditorEnabled = Array.isArray(enabled) && enabled.indexOf('scripteditor') >= 0;
    var scripteditorInstantiated = Array.isArray(widgets) && widgets.indexOf('scripteditor') >= 0;
    return {
      bwb_present: !!bwb,
      bwb_methods: bwb ? Object.keys(bwb).filter(function(k) { return typeof bwb[k] === 'function' && !k.startsWith('_'); }) : [],
      footer_present: !!footer,
      footer_buttons: footerButtons,
      bwb_enabled_widgets: enabled,
      bwb_instantiated_widgets: widgets,
      bwb_config_widgets: configKeys,
      scripteditor_in_config: Array.isArray(configKeys) && configKeys.indexOf('scripteditor') >= 0,
      scripteditor_enabled: scripteditorEnabled,
      scripteditor_instantiated: scripteditorInstantiated,
      origin: location.origin,
      pathname: (location.pathname || '').split('/').slice(0, 3).join('/'),
    };
  })()
`;

// Pine Editor is "ready" when BOTH hold:
//   1. Monaco's React fiber tree contains a live editor instance, AND
//   2. the .pine-editor-monaco container is actually VISIBLE (offsetParent),
//      so the editor's action buttons (Add to chart / Save) are rendered.
//
// We deliberately do NOT require a data-qa-id="scripteditor" footer tab.
// TradingView has (at least) two Pine layouts:
//   - footer-tab layout: Pine is a bottom-panel tab with data-qa-id.
//   - toolbar layout: Pine opens from the top toolbar [aria-label="Pine"]
//     button and mounts Monaco WITHOUT ever creating a footer tab.
// [verified live 2026-05-27 — chart fU7D519k] the toolbar layout mounts a
// fully usable Monaco with no scripteditor footer tab. A footer-tab
// requirement here was an over-correction that rejected working Monaco.
// Container visibility is the layout-agnostic signal.
//
// IMPORTANT: ${FIND_MONACO} must be wrapped in parens. FIND_MONACO begins
// with a newline, and without the parens JavaScript's automatic semicolon
// insertion terminates `return` so the IIFE returns undefined. The
// original implementation had this bug — every Monaco poll evaluated to
// undefined, falsy, and timed out, which is why only the already-open
// path ever worked.
const READY_CHECK = `
  (function() {
    var monaco = (${FIND_MONACO});
    if (!monaco) return false;
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    return !!(container && container.offsetParent !== null);
  })()
`;

async function pollUntilReady(maxIterations) {
  for (let i = 0; i < maxIterations; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await evaluate(READY_CHECK)) return true;
  }
  return false;
}

/**
 * Activates and opens the Pine Editor, waiting until Monaco is both present
 * in the React fiber tree and visible (so its action buttons are rendered).
 * Works across TV's footer-tab and toolbar Pine layouts.
 *
 * @returns {Promise<{ready: boolean, diagnostic: object|null, strategy: string|null}>}
 *   ready=true means Monaco is accessible and the editor is visible. On
 *   false, diagnostic carries the live TV state fingerprint and strategy
 *   records what (if anything) was clicked. Callers throw via
 *   pineEditorError(diagnostic).
 */
export async function ensurePineEditorOpen() {
  if (await evaluate(READY_CHECK)) return { ready: true, diagnostic: null, strategy: 'already-ready' };

  const strategy = await evaluate(OPEN_PINE_STRATEGIES);
  if (await pollUntilReady(50)) return { ready: true, diagnostic: null, strategy };

  const diagnostic = await evaluate(DIAGNOSTIC_SNAPSHOT);
  if (diagnostic && typeof diagnostic === 'object') diagnostic.attempted_strategy = strategy;
  return { ready: false, diagnostic, strategy };
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
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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

export async function compile() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

  const clicked = await evaluate(`
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

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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

export async function smartCompile() {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
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
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

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

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editor = await ensurePineEditorOpen();
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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
  if (!editor.ready) throw pineEditorError(editor.diagnostic);

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
