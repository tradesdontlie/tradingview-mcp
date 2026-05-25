/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient } from '../connection.js';
import { recordChartMutation } from './_mutation_ledger.js';
import { createHash } from 'node:crypto';

// Module-level evaluate/evaluateAsync — most pine.js functions still call these
// directly (legacy). New audit-fix functions (getEditorState, deployStrategy
// preflight) accept _deps for testability.
const evaluate = _evaluate;
const evaluateAsync = _evaluateAsync;

function _hashSource(source) {
  return createHash('sha256').update(String(source || ''), 'utf8').digest('hex').slice(0, 16);
}

function _resolvePineDeps(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    ensurePineEditorOpen: deps?.ensurePineEditorOpen || ensurePineEditorOpen,
  };
}
import { jsNormaliseLabel } from './_helpers.js';
import { V6_BUILTINS, MIGRATION_RULES, ERROR_EXPLANATIONS, lookupBuiltin, listAllBuiltins } from './v6_reference.js';

// Inlined JS helper to collapse duplicated icon+text labels like
// "Add to chartAdd to chart" into "Add to chart" before applying regex.
const NORM = jsNormaliseLabel();

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
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
  const mutation_id = recordChartMutation({ kind: 'pine_set_source', hash: _hashSource(source) });
  return { success: true, lines_set: source.split('\n').length, mutation_id };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await _countStudies();

  const clicked = await evaluate(`
    (function() {
      var norm = ${NORM};
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = norm(btns[i].textContent);
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)$/i.test(text) && btns[i].offsetParent !== null) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return norm(fallback.textContent); }
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

  const studiesAfter = await _countStudies();
  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;
  const blocker = !studyAdded ? await _detectBlockingDialog() : null;
  const mutation_id = recordChartMutation({ kind: 'pine_compile' });

  return {
    success: true,
    button_clicked: clicked || 'keyboard_shortcut',
    study_added: studyAdded,
    blocked_by: blocker?.title || null,
    mutation_id,
    suggestion: blocker
      ? (blocker.title === 'Save script'
          ? 'Call pine_save_as({ name: "..." }) to dismiss the modal, then retry pine_compile.'
          : 'A modal is open; call ui_dismiss_dialog or accept it before retrying.')
      : undefined,
    source: 'dom_fallback',
  };
}

async function _countStudies() {
  return await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);
}

async function _detectBlockingDialog() {
  return await evaluate(`
    (function() {
      var dlg = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog-"]');
      if (!dlg || dlg.offsetParent === null) return null;
      var title = '';
      var titleEl = dlg.querySelector('[class*="title"]');
      if (titleEl) title = titleEl.textContent.trim();
      if (!title) {
        // Fall back to heading or first non-empty text node
        var h = dlg.querySelector('h1,h2,h3,h4');
        if (h) title = h.textContent.trim();
      }
      // Common dialogs: "Save script", "Confirm", "Open anyway"
      if (/save script/i.test(dlg.textContent)) title = 'Save script';
      return { title: title || 'unknown_dialog' };
    })()
  `);
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
      var norm = ${NORM};
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = norm(btns[i].textContent);
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text) && btns[i].offsetParent !== null) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text) && btns[i].offsetParent !== null) updateBtn = btns[i];
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
  const blocker = !studyAdded ? await _detectBlockingDialog() : null;
  const mutation_id = recordChartMutation({ kind: 'pine_smart_compile' });

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    blocked_by: blocker?.title || null,
    mutation_id,
    suggestion: blocker
      ? (blocker.title === 'Save script'
          ? 'Call pine_save_as({ name: "..." }) to dismiss the modal, then retry pine_smart_compile.'
          : 'A modal is open; call ui_dismiss_dialog or accept it before retrying.')
      : undefined,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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

/**
 * Save the script under a chosen name. Handles the "Save script" modal that
 * appears for unnamed scripts: types `name` into the input then clicks Save.
 * If the modal is already not present, falls back to Ctrl+S.
 */
export async function saveAs({ name }) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // First ensure a Save-prompting action has been triggered (Ctrl+S)
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Find the Save Script dialog input, set the name, click Save
  const result = await evaluate(`
    (function() {
      var dlg = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog-"]');
      if (!dlg || dlg.offsetParent === null) return { dialog: false };
      // Only handle Save Script dialog
      if (!/save script/i.test(dlg.textContent)) return { dialog: 'other', title: (dlg.querySelector('[class*="title"]')||{}).textContent || '' };
      var input = dlg.querySelector('input[type="text"], input:not([type])');
      if (input) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Click the dialog's Save button
      var saveBtn = null;
      dlg.querySelectorAll('button').forEach(function(b) {
        if (b.offsetParent !== null && /^save$/i.test(b.textContent.trim())) saveBtn = saveBtn || b;
      });
      if (saveBtn) { saveBtn.click(); return { dialog: true, clicked: 'Save', name_set: !!input }; }
      return { dialog: true, clicked: null, name_set: !!input, error: 'Save button not found in dialog' };
    })()
  `);

  await new Promise(r => setTimeout(r, 800));
  const mutation_id = recordChartMutation({ kind: 'pine_save_as', hash: name });
  return { success: !result?.error, name, dialog_handled: result?.dialog === true, action: result?.dialog === true ? 'saved_as_new' : 'no_dialog_overwrite_attempted', detail: result, mutation_id };
}

/**
 * Detect and dismiss any modal/dialog currently open. Pass `accept: true` to
 * click the primary action (Save/OK/Confirm), false to cancel.
 */
export async function dismissDialog({ accept = false } = {}) {
  const result = await evaluate(`
    (function() {
      var accept = ${accept ? 'true' : 'false'};
      var dlg = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog-"]');
      if (!dlg || dlg.offsetParent === null) return { found: false };
      var title = (dlg.querySelector('[class*="title"]')||{}).textContent || '';
      var buttons = [];
      dlg.querySelectorAll('button').forEach(function(b) { if (b.offsetParent !== null) buttons.push(b); });
      var target = null;
      var primaryRe = /^(save|ok|confirm|yes|accept|continue|open anyway|apply)$/i;
      var cancelRe = /^(cancel|no|discard|close|dismiss|don'?t save)$/i;
      var re = accept ? primaryRe : cancelRe;
      for (var i = 0; i < buttons.length; i++) {
        if (re.test(buttons[i].textContent.trim())) { target = buttons[i]; break; }
      }
      if (!target && buttons.length > 0) target = accept ? buttons[buttons.length - 1] : buttons[0];
      if (target) { target.click(); return { found: true, title: title.trim(), clicked: target.textContent.trim(), accepted: accept }; }
      return { found: true, title: title.trim(), clicked: null };
    })()
  `);
  return { success: true, ...(result || { found: false }) };
}

/**
 * One-shot deploy of a Pine strategy: set source → save with name → add to
 * chart → wait for the study to appear → return its entity_id. Collapses
 * what used to be 5-8 separate tool calls.
 */
/**
 * C5 / A1-F6 — block until a Pine study emits the expected output, or timeout.
 * Replaces the 47 `Bash(sleep N)` calls from the audit operator session.
 *
 * Polls the appropriate data.getPine{Labels|Lines|Boxes|Tables} (via dynamic
 * import to avoid circular deps) every `poll_interval_ms` until:
 *   1) study_filter matches AND total items >= min_count
 *   2) expected_for_symbol is satisfied (chart_symbol matches)
 *   3) timeout_s elapses → returns {success:false, code:'PINE_WAIT_TIMEOUT'}
 */
export async function waitForOutput({
  study_filter,
  emit = 'labels',
  min_count = 1,
  expected_for_symbol = null,
  timeout_s = 10,
  poll_interval_ms = 250,
  _deps,
} = {}) {
  if (!study_filter) throw new Error('study_filter is required');
  const validEmit = ['labels', 'lines', 'boxes', 'tables'];
  if (!validEmit.includes(emit)) {
    throw new Error(`emit must be one of ${JSON.stringify(validEmit)}, got "${emit}"`);
  }
  const data = await import('./data.js');
  const reader = {
    labels: data.getPineLabels,
    lines: data.getPineLines,
    boxes: data.getPineBoxes,
    tables: data.getPineTables,
  }[emit];
  const start = Date.now();
  const deadline = start + Math.max(1, Math.min(60, Number(timeout_s) || 10)) * 1000;
  const pollMs = Math.max(50, Math.min(5000, Number(poll_interval_ms) || 250));
  let polls = 0;
  let lastResult = null;
  while (Date.now() < deadline) {
    polls += 1;
    const args = { study_filter, _deps };
    if (expected_for_symbol) args.expected_for_symbol = expected_for_symbol;
    if (emit === 'labels') args.max_labels = Math.max(1, min_count);
    lastResult = await reader(args);
    if (lastResult?.success === false && lastResult?.error === 'PINE_OUTPUT_STALE_AFTER_SYMBOL_CHANGE') {
      // Not yet on the expected symbol — keep polling
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    const studies = lastResult?.studies || [];
    const totalCount = studies.reduce((sum, s) => {
      const c = s.total_labels ?? s.total_lines ?? s.total_boxes ?? (s.tables ? s.tables.length : 0) ?? 0;
      return sum + (typeof c === 'number' ? c : 0);
    }, 0);
    if (studies.length > 0 && totalCount >= min_count) {
      return {
        success: true,
        emit,
        study_filter,
        wait_ms_elapsed: Date.now() - start,
        polls,
        total_count: totalCount,
        ...lastResult,
      };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return {
    success: false,
    code: 'PINE_WAIT_TIMEOUT',
    emit,
    study_filter,
    expected_for_symbol,
    min_count,
    timeout_s,
    wait_ms_elapsed: Date.now() - start,
    polls,
    last_result: lastResult,
    remediation: `Polled ${polls}× over ${Date.now() - start}ms; study "${study_filter}" did not emit ${min_count} ${emit}${expected_for_symbol ? ` for ${expected_for_symbol}` : ''}. Check pine_get_errors, then chart_get_state.studies[] for the study presence.`,
  };
}

/**
 * C2 / A1-F5 / A2-F2 — read editor state without mutating it. Returns enough
 * for callers (and deployStrategy's preflight) to know whether deploying
 * would overwrite a different saved script.
 */
export async function getEditorState({ include_source_hash = true, _deps } = {}) {
  const { evaluate, ensurePineEditorOpen: _ensure } = _resolvePineDeps(_deps);
  const editorReady = await _ensure();
  if (!editorReady) return { success: false, panel_open: false, dirty: false, action_button: null, modal: { present: false }, compile_errors: [] };
  const raw = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      var panel_open = !!m;
      var source = null;
      var script_name = null;
      var dirty = false;
      var compile_errors = [];
      try {
        if (m) {
          source = m.editor.getValue();
          try {
            var model = m.editor.getModel();
            if (model) {
              var markers = m.env.editor.getModelMarkers({ resource: model.uri });
              compile_errors = (markers || []).map(function(mk) {
                return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
              });
            }
          } catch(e) {}
        }
      } catch(e) {}
      // Editor tab title — TradingView shows the active saved script's name here
      try {
        var titleEl = document.querySelector('[data-name="header-title-name"]')
          || document.querySelector('[class*="pine-editor"] [class*="title"]')
          || document.querySelector('[class*="scriptTitle"]')
          || document.querySelector('[class*="script-title"]');
        if (titleEl) script_name = titleEl.textContent.trim().replace(/\\s+/g, ' ');
      } catch(e) {}
      // Dirty indicator — TV shows a "*" or unsaved-marker badge
      try {
        if (script_name && /\\*$/.test(script_name)) { dirty = true; script_name = script_name.replace(/\\*$/, '').trim(); }
        var dirtyEl = document.querySelector('[class*="unsavedIndicator"]')
          || document.querySelector('[data-name="unsaved-marker"]')
          || document.querySelector('[class*="modified-indicator"]');
        if (dirtyEl && dirtyEl.offsetParent !== null) dirty = true;
      } catch(e) {}
      // Detect visible action button (Add to chart / Update on chart / Save)
      var action_button = null;
      try {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if (b.offsetParent === null) continue;
          var t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
          if (/^add to chart/i.test(t)) { action_button = 'add_to_chart'; break; }
          if (/^update on chart/i.test(t)) { action_button = 'update_on_chart'; break; }
          if (/^save and add to chart/i.test(t)) { action_button = 'save_and_add_to_chart'; break; }
          if (/^save$/i.test(t) && action_button == null) action_button = 'save';
        }
      } catch(e) {}
      // Detect blocking modal
      var modal = { present: false, title: null, primary_label: null, secondary_label: null };
      try {
        var dlg = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog-"]');
        if (dlg && dlg.offsetParent !== null) {
          modal.present = true;
          var t = dlg.querySelector('[class*="title"]') || dlg.querySelector('h1,h2,h3,h4');
          modal.title = t ? (t.textContent || '').trim() : null;
          var btns = dlg.querySelectorAll('button');
          var visible = [];
          for (var i = 0; i < btns.length; i++) { if (btns[i].offsetParent !== null) visible.push((btns[i].textContent || '').trim()); }
          modal.primary_label = visible[visible.length - 1] || null;
          modal.secondary_label = visible[0] && visible[0] !== modal.primary_label ? visible[0] : null;
        }
      } catch(e) {}
      return { panel_open: panel_open, source: source, script_name: script_name, dirty: dirty, action_button: action_button, modal: modal, compile_errors: compile_errors };
    })()
  `);
  const source_hash = include_source_hash && raw && raw.source != null ? _hashSource(raw.source) : null;
  return {
    success: true,
    panel_open: !!raw?.panel_open,
    script_name: raw?.script_name || null,
    dirty: !!raw?.dirty,
    source_hash,
    action_button: raw?.action_button || null,
    modal: raw?.modal || { present: false, title: null, primary_label: null, secondary_label: null },
    compile_errors: raw?.compile_errors || [],
  };
}

/**
 * Normalize editor script_name for "same script?" comparison: lowercase,
 * strip trailing star, collapse whitespace, drop the trailing " * " suffix.
 */
function _normScriptName(s) {
  return String(s || '').toLowerCase().replace(/\*+$/, '').replace(/\s+/g, ' ').trim();
}

export async function deployStrategy({ source, name, replace_existing = true, wait_ms = 8000, force_overwrite_editor = false, _deps }) {
  if (!source) throw new Error('source is required');
  if (!name) {
    // Auto-derive name from strategy() / indicator() title in the source
    const m = source.match(/(?:strategy|indicator|library)\(\s*["']([^"']+)["']/);
    name = (m && m[1]) || 'untitled_script';
  }

  const { evaluate, ensurePineEditorOpen: _ensure } = _resolvePineDeps(_deps);
  await _ensure();

  // C2 preflight (A1-F5 / A2-F2): refuse if the editor currently holds a
  // DIFFERENT saved-script binding. Without this guard, "Add to chart"
  // silently adds the editor's stale bytecode under that other name.
  const preflight = await getEditorState({ include_source_hash: false, _deps });
  const requestedNorm = _normScriptName(name);
  const editorNorm = _normScriptName(preflight.script_name);
  const editorEmpty = !editorNorm || /^untitled/i.test(editorNorm);
  const sameScript = editorNorm && requestedNorm && (editorNorm === requestedNorm
    || editorNorm.includes(requestedNorm) || requestedNorm.includes(editorNorm));
  if (!force_overwrite_editor && !editorEmpty && !sameScript) {
    return {
      success: false,
      code: 'EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT',
      editor_saved_script_name: preflight.script_name,
      requested_script_name: name,
      remediation: `The Pine editor currently has "${preflight.script_name}" bound. Deploying would add the stale bytecode under that name, not your new source. Pass force_overwrite_editor=true to save-as "${name}" first, OR call pine_new() to clear the editor.`,
    };
  }

  // 1. Inject source
  const escaped = JSON.stringify(source);
  const set = await evaluate(`(function(){var m=${FIND_MONACO};if(!m)return false;m.editor.setValue(${escaped});return true;})()`);
  if (!set) throw new Error('Monaco editor not found. Open Pine Editor first.');

  // 2. Save with name (handles Save Script modal)
  await new Promise(r => setTimeout(r, 400));
  const saved = await saveAs({ name });

  // 3. Click Add to chart (or Update on chart if replace_existing and a same-name study exists)
  const studiesBefore = await _countStudies();
  const clicked = await evaluate(`
    (function() {
      var norm = ${NORM};
      var btns = document.querySelectorAll('button');
      var addBtn = null, updBtn = null;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent === null) continue;
        var text = norm(btns[i].textContent);
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updBtn && /^update on chart$/i.test(text)) updBtn = btns[i];
      }
      var pick = (${replace_existing ? 'updBtn || addBtn' : 'addBtn || updBtn'});
      if (pick) { pick.click(); return norm(pick.textContent); }
      return null;
    })()
  `);

  // 4. Wait for the study to appear on the chart
  const deadline = Date.now() + wait_ms;
  let studyId = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    const studies = await evaluate(`
      (function() {
        try { return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return {id:s.id,name:s.name||s.title||''};}); }
        catch(e) { return []; }
      })()
    `);
    if (Array.isArray(studies) && studies.length > (studiesBefore || 0)) {
      const match = studies.find(s => s.name && s.name.toLowerCase().includes(String(name).toLowerCase().slice(0, 20)));
      studyId = (match && match.id) || studies[studies.length - 1]?.id || null;
      break;
    }
  }

  const mutation_id = recordChartMutation({ kind: 'pine_deploy_strategy', hash: _hashSource(source) });
  return {
    success: studyId !== null,
    strategy_name: name,
    script_name: name,
    study_id: studyId,
    button_clicked: clicked,
    save_action: saved.action,
    mutation_id,
    note: studyId
      ? 'Script deployed. Use strategy_get_report to fetch metrics (strategies) or chart_get_state to confirm (indicators).'
      : 'Click registered but study did not appear within wait_ms. Check pine_get_errors and pine_get_console.',
  };
}

/**
 * Combined offline+server lint: runs `analyze` (local static checks) and `check`
 * (TradingView server compile) and merges diagnostics into one list.
 */
export async function lint({ source }) {
  const local = analyze({ source });
  let server;
  try { server = await check({ source }); }
  catch (e) { server = { success: false, error: e.message, errors: [], warnings: [] }; }

  const diagnostics = [];
  for (const d of local.diagnostics || []) {
    diagnostics.push({ origin: 'static', severity: d.severity, line: d.line, column: d.column, message: d.message });
  }
  for (const e of server.errors || []) {
    diagnostics.push({ origin: 'server', severity: 'error', line: e.line, column: e.column, message: e.message });
  }
  for (const w of server.warnings || []) {
    diagnostics.push({ origin: 'server', severity: 'warning', line: w.line, column: w.column, message: w.message });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: true,
    compiled: errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: diagnostics.length - errorCount - warningCount,
    diagnostics,
  };
}

/**
 * Return a vetted Pine v6 template by pattern name. Avoids the agent
 * re-deriving common scaffolds and prevents v5/v6 footguns.
 */
export function template({ type = 'strategy', pattern }) {
  const templates = {
    indicator: {
      plot_close:
`//@version=6
indicator("Close Price")
plot(close)
`,
      rsi:
`//@version=6
indicator("RSI", format=format.price, precision=2)
length = input.int(14, "Length", minval=1)
src = input.source(close, "Source")
rsi = ta.rsi(src, length)
plot(rsi, "RSI", color=color.purple, linewidth=2)
hline(70, "Overbought", color=color.red, linestyle=hline.style_dashed)
hline(30, "Oversold",  color=color.green, linestyle=hline.style_dashed)
hline(50, "Mid",       color=color.gray,  linestyle=hline.style_dotted)
`,
      ema_cross:
`//@version=6
indicator("EMA Cross", overlay=true)
fast = input.int(9, "Fast", minval=1)
slow = input.int(21, "Slow", minval=2)
fastMA = ta.ema(close, fast)
slowMA = ta.ema(close, slow)
plot(fastMA, "Fast EMA", color=color.blue,   linewidth=2)
plot(slowMA, "Slow EMA", color=color.orange, linewidth=2)
plotshape(ta.crossover(fastMA, slowMA),  "Cross Up",   style=shape.triangleup,   color=color.green, location=location.belowbar, size=size.small)
plotshape(ta.crossunder(fastMA, slowMA), "Cross Down", style=shape.triangledown, color=color.red,   location=location.abovebar, size=size.small)
`,
      multitimeframe:
`//@version=6
// Multi-timeframe RSI: shows HTF RSI on the current chart.
indicator("MTF RSI", format=format.price, precision=2)
length = input.int(14, "RSI Length")
htf    = input.timeframe("D", "Higher Timeframe")
htfRsi = request.security(syminfo.tickerid, htf, ta.rsi(close, length), lookahead=barmerge.lookahead_off)
plot(htfRsi, "HTF RSI", color=color.fuchsia, linewidth=2)
hline(70, color=color.red)
hline(30, color=color.green)
`,
      udt_levels:
`//@version=6
// User-defined type + method: tag every swing pivot as a Level on the chart.
indicator("Swing Levels (UDT)", overlay=true)
length = input.int(10, "Pivot Bars")
type Level
    float price
    int   bar
    bool  isHigh
method draw(Level this) =>
    label.new(chart.point.from_index(this.bar, this.price), this.isHigh ? "H " + str.tostring(this.price) : "L " + str.tostring(this.price), color=this.isHigh ? color.red : color.green, style=this.isHigh ? label.style_label_down : label.style_label_up, textcolor=color.white, size=size.tiny)
ph = ta.pivothigh(high, length, length)
pl = ta.pivotlow (low,  length, length)
if not na(ph)
    Level.new(ph, bar_index - length, true).draw()
if not na(pl)
    Level.new(pl, bar_index - length, false).draw()
`,
      map_ticker_tracker:
`//@version=6
// Map<string,float>: track last-known close for several tickers requested via security().
indicator("Multi-Ticker Last Close", overlay=false)
var map<string, float> closes = map.new<string, float>()
tickers = array.from("BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT")
for t in tickers
    px = request.security(t, timeframe.period, close, ignore_invalid_symbol=true)
    map.put(closes, t, px)
if barstate.islast
    var table tbl = table.new(position.top_right, 2, array.size(tickers) + 1, frame_color=color.gray, frame_width=1)
    table.cell(tbl, 0, 0, "Symbol", text_color=color.white, bgcolor=color.navy)
    table.cell(tbl, 1, 0, "Close",  text_color=color.white, bgcolor=color.navy)
    for [i, t] in tickers
        table.cell(tbl, 0, i + 1, t)
        table.cell(tbl, 1, i + 1, str.tostring(map.get(closes, t), "#.##"))
`,
      polyline_zigzag:
`//@version=6
// Polyline-based zigzag joining recent pivots.
indicator("Polyline Zigzag", overlay=true, max_polylines_count=10)
length = input.int(5, "Pivot Bars")
var array<chart.point> pts = array.new<chart.point>()
ph = ta.pivothigh(high, length, length)
pl = ta.pivotlow (low,  length, length)
if not na(ph)
    array.push(pts, chart.point.from_index(bar_index - length, ph))
if not na(pl)
    array.push(pts, chart.point.from_index(bar_index - length, pl))
while array.size(pts) > 25
    array.shift(pts)
var polyline pl_ = na
if barstate.islast and array.size(pts) >= 2
    polyline.delete(pl_)
    pl_ := polyline.new(pts, line_color=color.yellow, line_width=2)
`,
      session_vwap:
`//@version=6
// VWAP that resets each regular trading session.
indicator("Session VWAP", overlay=true)
sess = input.session("0930-1600", "Session")
inSession = not na(time(timeframe.period, sess))
var float cumPV  = na
var float cumVol = na
if inSession and not (inSession[1])
    cumPV  := 0.0
    cumVol := 0.0
if inSession
    typical = (high + low + close) / 3
    cumPV  := nz(cumPV)  + typical * volume
    cumVol := nz(cumVol) + volume
plot(cumVol > 0 ? cumPV / cumVol : na, "Session VWAP", color=color.aqua, linewidth=2)
`,
      heatmap_table:
`//@version=6
// Indicator that renders a 7-day x 24-hour returns heatmap as a Pine table.
indicator("Returns Heatmap", overlay=false)
var matrix<float> sumRet = matrix.new<float>(7, 24, 0.0)
var matrix<int>   cnt    = matrix.new<int>  (7, 24, 0)
ret = close / close[1] - 1
d   = dayofweek - 1   // 0..6
h   = hour
if not na(ret)
    matrix.set(sumRet, d, h, matrix.get(sumRet, d, h) + ret)
    matrix.set(cnt,    d, h, matrix.get(cnt,    d, h) + 1)
if barstate.islast
    var table tbl = table.new(position.middle_center, 25, 8, frame_color=color.gray, frame_width=1)
    table.cell(tbl, 0, 0, "h\\\\d", text_color=color.white, bgcolor=color.navy)
    for h2 = 0 to 23
        table.cell(tbl, h2 + 1, 0, str.tostring(h2), text_color=color.white, bgcolor=color.navy)
    days = array.from("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    for [di, dn] in days
        table.cell(tbl, 0, di + 1, dn, text_color=color.white, bgcolor=color.navy)
        for h3 = 0 to 23
            n = matrix.get(cnt, di, h3)
            avg = n > 0 ? matrix.get(sumRet, di, h3) / n : 0.0
            col = avg > 0 ? color.new(color.green, math.min(90, 90 - math.round(math.abs(avg) * 1000))) : color.new(color.red, math.min(90, 90 - math.round(math.abs(avg) * 1000)))
            table.cell(tbl, h3 + 1, di + 1, n > 0 ? str.tostring(avg * 100, "#.##") : "", text_color=color.white, bgcolor=col, text_size=size.tiny)
`,
      // ─── Siyolah TASI utilities (v2.4.0) ───
      tasi_session_mask:
`//@version=6
// Tadawul (Saudi) trading session mask: Sun–Thu only; Fri/Sat are weekend.
// Pine v6 has no module system for indicator/strategy bodies — COPY this
// snippet's inTasiSession line into any TASI script that needs to silence
// Fri/Sat behaviour and gate entries accordingly.
indicator("TASI Session Mask", overlay=true)
inTasiSession = dayofweek != dayofweek.friday and dayofweek != dayofweek.saturday
bgcolor(not inTasiSession ? color.new(color.gray, 88) : na, title="Weekend mask")
// In a strategy body, gate entries:  if entryCond and inTasiSession  ...
`,
    },
    strategy: {
      rsi_crossover:
`//@version=6
strategy("RSI Crossover", overlay=false,
     initial_capital=100000,
     default_qty_type=strategy.cash,
     default_qty_value=5000,
     pyramiding=50,
     commission_type=strategy.commission.percent, commission_value=0,
     process_orders_on_close=true)
len  = input.int(14, "RSI Length", minval=2)
buy  = input.int(20, "Buy: RSI crosses above")
sell = input.int(80, "Sell: RSI crosses below")
rsi  = ta.rsi(close, len)
if ta.crossover(rsi, buy)
    strategy.entry("L" + str.tostring(bar_index), strategy.long)
if ta.crossunder(rsi, sell)
    strategy.close_all(comment="RSI<sell")
plot(rsi, "RSI", color=color.purple)
hline(buy,  color=color.green)
hline(sell, color=color.red)
`,
      ema_cross:
`//@version=6
strategy("EMA Cross", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
fast = input.int(9,  "Fast EMA", minval=1)
slow = input.int(21, "Slow EMA", minval=2)
fastMA = ta.ema(close, fast)
slowMA = ta.ema(close, slow)
if ta.crossover(fastMA, slowMA)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fastMA, slowMA)
    strategy.close("Long")
plot(fastMA, color=color.blue)
plot(slowMA, color=color.orange)
`,
      bb_meanreversion:
`//@version=6
strategy("BB Mean Reversion", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)
len  = input.int(20, "BB Length", minval=2)
mult = input.float(2.0, "BB Stdev", minval=0.1, step=0.1)
[basis, upper, lower] = ta.bb(close, len, mult)
if close < lower
    strategy.entry("Long", strategy.long)
if close > basis and strategy.position_size > 0
    strategy.close("Long")
plot(basis, color=color.gray)
plot(upper, color=color.red)
plot(lower, color=color.green)
`,
      atr_stop_take_profit:
`//@version=6
// EMA cross entry with ATR-based stop loss and take-profit.
strategy("EMA + ATR SL/TP", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
fast    = input.int(9,    "Fast EMA")
slow    = input.int(21,   "Slow EMA")
atrLen  = input.int(14,   "ATR Length")
slMult  = input.float(2.0,"SL × ATR", step=0.1)
tpMult  = input.float(3.0,"TP × ATR", step=0.1)
fastMA = ta.ema(close, fast)
slowMA = ta.ema(close, slow)
atr    = ta.atr(atrLen)
longSignal = ta.crossover(fastMA, slowMA)
if longSignal
    strategy.entry("Long", strategy.long)
    strategy.exit("X", "Long", stop=close - slMult * atr, limit=close + tpMult * atr)
plot(fastMA)
plot(slowMA)
`,
      trailing_stop:
`//@version=6
// Long-only breakout with a trailing-stop exit driven by trail_offset.
strategy("Breakout + Trailing Stop", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)
lbk  = input.int(20, "Breakout Lookback")
trailPct = input.float(2.0, "Trail %", step=0.1) / 100.0
highest = ta.highest(high, lbk)
if close > highest[1]
    strategy.entry("Long", strategy.long)
if strategy.position_size > 0
    strategy.exit("Trail", "Long", trail_points=close * trailPct / syminfo.mintick, trail_offset=close * trailPct / syminfo.mintick / 2)
plot(highest, color=color.gray)
`,
      mtf_filter:
`//@version=6
// MTF: only take long signals when HTF EMA(50) is rising.
strategy("MTF EMA Filter", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)
htf      = input.timeframe("D", "HTF")
htfLen   = input.int(50, "HTF EMA")
fastLen  = input.int(9,  "Fast EMA")
slowLen  = input.int(21, "Slow EMA")
htfEma   = request.security(syminfo.tickerid, htf, ta.ema(close, htfLen), lookahead=barmerge.lookahead_off)
htfTrend = htfEma > htfEma[1]
fastMA = ta.ema(close, fastLen)
slowMA = ta.ema(close, slowLen)
if ta.crossover(fastMA, slowMA) and htfTrend
    strategy.entry("Long", strategy.long)
if ta.crossunder(fastMA, slowMA)
    strategy.close("Long")
plot(fastMA, color=color.blue)
plot(slowMA, color=color.orange)
`,
      daterange_window:
`//@version=6
// Backtest only between user-chosen dates.
strategy("Date-Windowed Backtest", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fromDate = input.time(timestamp("2022-01-01"), "From")
toDate   = input.time(timestamp("2026-01-01"), "To")
inWindow = time >= fromDate and time <= toDate
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
if inWindow and ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if (not inWindow or ta.crossunder(fast, slow)) and strategy.position_size > 0
    strategy.close("Long")
plot(fast)
plot(slow)
`,
      pyramiding_dca:
`//@version=6
// Pyramiding dollar-cost-average into long positions on RSI dips.
strategy("RSI DCA Pyramid", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=2500,
     pyramiding=10,
     commission_type=strategy.commission.percent, commission_value=0)
len     = input.int(14, "RSI Length")
dipLvl  = input.int(30, "Dip RSI Level")
exitLvl = input.int(70, "Exit RSI Level")
rsi = ta.rsi(close, len)
if ta.crossunder(rsi, dipLvl) and strategy.opentrades < 10
    strategy.entry("DCA_" + str.tostring(strategy.opentrades), strategy.long)
if ta.crossover(rsi, exitLvl) and strategy.position_size > 0
    strategy.close_all(comment="Exit RSI>" + str.tostring(exitLvl))
plot(rsi)
`,
      blank:
`//@version=6
strategy("My Strategy", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=1000)
// TODO: define entry/exit conditions
`,
      // ─── Advanced quant / alpha-discovery patterns ───
      zscore_mr:
`//@version=6
// Statistical mean-reversion: enter long when N-day return z-score < -entry,
// exit when >= -exit. Optional 200-SMA trend filter (Andreas Clenow style).
strategy("Z-Score Mean Reversion", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05,
     process_orders_on_close=true)
len      = input.int(20,   "Z-Score Lookback", minval=5)
entryZ   = input.float(-2.0, "Long entry: z <=", step=0.1)
exitZ    = input.float(-0.5, "Long exit: z >=",  step=0.1)
useTrend = input.bool(true, "Trend filter (200 SMA)")
ret  = math.log(close / close[1])
mean = ta.sma(ret, len)
sd   = ta.stdev(ret, len)
z    = sd == 0 ? 0.0 : (ret - mean) / sd
trendOk = useTrend ? close > ta.sma(close, 200) : true
if z <= entryZ and trendOk and strategy.position_size == 0
    strategy.entry("MR", strategy.long)
if z >= exitZ and strategy.position_size > 0
    strategy.close("MR", comment="z>=" + str.tostring(exitZ))
plot(z, "Z", color=color.purple, display=display.none)
plotshape(z <= entryZ and trendOk, "Entry", style=shape.triangleup, color=color.green, location=location.belowbar, size=size.small)
`,
      rsi2_connors:
`//@version=6
// Connors RSI(2) — classic statistical-arbitrage mean-reversion.
// Long when RSI(2) crosses below 5, exit when close > 5-day high.
strategy("RSI(2) Connors", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
rsiLen   = input.int(2,  "RSI Length")
entryLvl = input.int(5,  "Entry: RSI <")
trendLen = input.int(200, "Trend SMA")
exitLen  = input.int(5,  "Exit: close > N-bar high")
rsi   = ta.rsi(close, rsiLen)
trend = ta.sma(close, trendLen)
above = close > trend
exitLvl = ta.highest(high, exitLen)[1]
if rsi < entryLvl and above and strategy.position_size == 0
    strategy.entry("RSI2", strategy.long)
if strategy.position_size > 0 and close > exitLvl
    strategy.close("RSI2", comment="ExitHigh")
plot(rsi, "RSI(2)", color=color.purple, display=display.data_window)
`,
      nr7_breakout:
`//@version=6
// NR7 inside-day volatility-compression breakout (Crabel).
// Today's range is the narrowest of the last 7 → next-bar breakout signals.
strategy("NR7 Breakout", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
lbk    = input.int(7, "NR Lookback")
atrLen = input.int(14, "ATR (for stop)")
slMult = input.float(1.5, "Stop × ATR", step=0.1)
range_ = high - low
isNRn  = range_ == ta.lowest(range_, lbk)
atr    = ta.atr(atrLen)
var float entryHigh = na
var float entryLow  = na
if isNRn
    entryHigh := high
    entryLow  := low
longCond  = not na(entryHigh) and high > entryHigh and strategy.position_size == 0
shortCond = not na(entryLow)  and low  < entryLow  and strategy.position_size == 0
if longCond
    strategy.entry("L", strategy.long)
    strategy.exit("XL", "L", stop=close - slMult * atr)
    entryHigh := na
if shortCond
    strategy.entry("S", strategy.short)
    strategy.exit("XS", "S", stop=close + slMult * atr)
    entryLow := na
plotshape(isNRn, "NR7", style=shape.diamond, color=color.yellow, location=location.belowbar, size=size.tiny)
`,
      donchian_turtle:
`//@version=6
// Turtle channel breakout — classic trend-following alpha (Richard Dennis).
// Enter long on N-bar high breakout, exit on M-bar low breakout. ATR stop.
strategy("Donchian Turtle", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     pyramiding=4,
     commission_type=strategy.commission.percent, commission_value=0.05)
enterLen = input.int(20, "Entry Channel")
exitLen  = input.int(10, "Exit Channel")
atrLen   = input.int(20, "ATR")
slMult   = input.float(2.0, "Stop × ATR", step=0.1)
addStep  = input.float(0.5, "Pyramid add every N×ATR", step=0.1)
entryHi = ta.highest(high, enterLen)[1]
exitLo  = ta.lowest(low,   exitLen)[1]
atr     = ta.atr(atrLen)
var float lastAddPx = na
if close > entryHi and (strategy.position_size == 0 or close > lastAddPx + addStep * atr)
    strategy.entry("L" + str.tostring(strategy.opentrades), strategy.long)
    lastAddPx := close
    strategy.exit("X" + str.tostring(strategy.opentrades), stop=close - slMult * atr)
if strategy.position_size > 0 and close < exitLo
    strategy.close_all(comment="ChanExit")
    lastAddPx := na
plot(entryHi, color=color.green)
plot(exitLo,  color=color.red)
`,
      vol_regime_filter:
`//@version=6
// Only trade when realized volatility sits in the middle quartile —
// avoids low-vol whipsaw and high-vol gap risk.
strategy("Vol Regime Filter (EMA cross core)", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
volLen   = input.int(20,  "Realized Vol Length")
percLen  = input.int(252, "Vol percentile lookback")
loPct    = input.int(25,  "Lower percentile")
hiPct    = input.int(75,  "Upper percentile")
fastLen  = input.int(9,   "Fast EMA")
slowLen  = input.int(21,  "Slow EMA")
ret = math.log(close / close[1])
rv  = ta.stdev(ret, volLen)
pct = ta.percentrank(rv, percLen)
regimeOk = pct >= loPct and pct <= hiPct
fastMA = ta.ema(close, fastLen)
slowMA = ta.ema(close, slowLen)
if regimeOk and ta.crossover(fastMA, slowMA)
    strategy.entry("L", strategy.long)
if ta.crossunder(fastMA, slowMA) or not regimeOk
    strategy.close("L", comment="Exit")
bgcolor(regimeOk ? color.new(color.green, 90) : color.new(color.red, 90))
`,
      pairs_ratio_zscore:
`//@version=6
// Single-symbol stat-arb proxy: trade the ratio between this symbol and a
// benchmark (e.g. SPY) as a z-score mean-reverting series.
strategy("Pairs Ratio Z-Score", overlay=false,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
bench    = input.symbol("AMEX:SPY", "Benchmark")
len      = input.int(60, "Z lookback", minval=5)
entryZ   = input.float(2.0, "Entry |z| >=", step=0.1)
exitZ    = input.float(0.5, "Exit |z| <=", step=0.1)
benchClose = request.security(bench, timeframe.period, close, ignore_invalid_symbol=true)
ratio = close / benchClose
mean  = ta.sma(ratio, len)
sd    = ta.stdev(ratio, len)
z     = sd == 0 ? 0.0 : (ratio - mean) / sd
if z <=  -entryZ and strategy.position_size <= 0
    strategy.entry("LongRatio",  strategy.long)
if z >=   entryZ and strategy.position_size >= 0
    strategy.entry("ShortRatio", strategy.short)
if math.abs(z) <= exitZ and strategy.position_size != 0
    strategy.close_all(comment="MeanRevert")
plot(z, "Z(ratio)", color=color.fuchsia, linewidth=2)
hline( entryZ, color=color.red)
hline(-entryZ, color=color.green)
hline(0, color=color.gray)
`,
      anchored_vwap_fade:
`//@version=6
// Fade extreme deviations from the session-anchored VWAP — intraday mean reversion.
strategy("Anchored VWAP Fade", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
sess    = input.session("0930-1600", "Session")
sigMult = input.float(2.0, "Entry σ from VWAP", step=0.1)
exitMult= input.float(0.5, "Exit  σ from VWAP", step=0.1)
inSession = not na(time(timeframe.period, sess))
var float cumPV  = na
var float cumVol = na
var float cumSq  = na
if inSession and not (inSession[1])
    cumPV  := 0.0
    cumVol := 0.0
    cumSq  := 0.0
typical = (high + low + close) / 3
if inSession
    cumPV  := nz(cumPV)  + typical * volume
    cumVol := nz(cumVol) + volume
    vwap   = cumPV / cumVol
    cumSq  := nz(cumSq) + math.pow(typical - vwap, 2) * volume
vwap = cumVol > 0 ? cumPV / cumVol : na
sd   = cumVol > 0 ? math.sqrt(cumSq / cumVol) : na
upper = vwap + sigMult * sd
lower = vwap - sigMult * sd
exitUp = vwap + exitMult * sd
exitDn = vwap - exitMult * sd
if inSession and not na(lower) and close < lower and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if inSession and not na(upper) and close > upper and strategy.position_size == 0
    strategy.entry("Short", strategy.short)
if strategy.position_size > 0 and close >= exitDn
    strategy.close("Long", comment="VWAP")
if strategy.position_size < 0 and close <= exitUp
    strategy.close("Short", comment="VWAP")
plot(vwap, "VWAP", color=color.aqua, linewidth=2)
plot(upper, "+σ", color=color.red)
plot(lower, "-σ", color=color.green)
`,
      hurst_regime:
`//@version=6
// Hurst exponent (rescaled-range estimator) classifies regime:
//   H > 0.55 → trending     (use breakout/momentum)
//   H < 0.45 → mean-reverting (use fade/MR)
//   else    → random walk    (stand aside)
// Demonstrates regime-aware strategy switching.
strategy("Hurst Regime Switch", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
len      = input.int(100, "Hurst lookback", minval=20)
mrThresh = input.float(0.45, "MR if H <=", step=0.01)
trThresh = input.float(0.55, "Trend if H >=", step=0.01)
ret = math.log(close / close[1])
// Rescaled range estimator (simplified): Hurst ~= log(R/S) / log(N)
rs = (ta.highest(close, len) - ta.lowest(close, len)) / ta.stdev(close, len)
hurst = math.log(math.max(rs, 0.0001)) / math.log(len)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
rsi  = ta.rsi(close, 14)
isTrending = hurst >= trThresh
isMR       = hurst <= mrThresh
if isTrending and ta.crossover(fast, slow)
    strategy.entry("TrendL", strategy.long)
if isTrending and ta.crossunder(fast, slow) and strategy.position_size > 0
    strategy.close("TrendL", comment="TrendExit")
if isMR and rsi < 25 and strategy.position_size == 0
    strategy.entry("MRL", strategy.long)
if isMR and rsi > 60 and strategy.position_size > 0
    strategy.close("MRL", comment="MRExit")
plot(hurst, "Hurst", color=color.fuchsia, display=display.data_window)
bgcolor(isTrending ? color.new(color.blue, 90) : isMR ? color.new(color.orange, 90) : na)
`,
      time_of_day_seasonality:
`//@version=6
// Trade only during historically positive hour-of-day buckets.
// Aggregates per-hour mean return + table; signals when current hour
// has historically positive expected return.
strategy("Time-of-Day Seasonality", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
edgeBps = input.float(2.0, "Required edge (bps)")
ret = math.log(close / close[1])
var array<float> sums = array.new<float>(24, 0.0)
var array<int>   cnts = array.new<int>  (24, 0)
h = hour
if not na(ret)
    array.set(sums, h, array.get(sums, h) + ret)
    array.set(cnts, h, array.get(cnts, h) + 1)
hourMean = array.get(cnts, h) > 30 ? array.get(sums, h) / array.get(cnts, h) : 0.0
isPositiveHour = hourMean * 10000 >= edgeBps
if isPositiveHour and strategy.position_size == 0
    strategy.entry("L", strategy.long)
if not isPositiveHour and strategy.position_size > 0
    strategy.close("L", comment="HourEnd")
if barstate.islastconfirmedhistory
    var table t = table.new(position.top_right, 2, 25, frame_color=color.gray, frame_width=1)
    table.cell(t, 0, 0, "Hour", text_color=color.white, bgcolor=color.navy)
    table.cell(t, 1, 0, "Mean (bps)", text_color=color.white, bgcolor=color.navy)
    for i = 0 to 23
        n = array.get(cnts, i)
        avg = n > 0 ? array.get(sums, i) / n * 10000 : 0.0
        c = avg > 0 ? color.new(color.green, 70) : color.new(color.red, 70)
        table.cell(t, 0, i + 1, str.tostring(i))
        table.cell(t, 1, i + 1, n > 0 ? str.tostring(avg, "#.##") + " (n=" + str.tostring(n) + ")" : "n/a", bgcolor=c)
`,
      kelly_atr_sizing:
`//@version=6
// Kelly-fraction position sizing: dynamic per-trade equity allocation
// driven by recent win rate and avg win/loss ratio. ATR stop for risk floor.
strategy("Kelly + ATR Sizing", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=1,
     pyramiding=0,
     commission_type=strategy.commission.percent, commission_value=0.05)
fastLen = input.int(9,  "Fast EMA")
slowLen = input.int(21, "Slow EMA")
atrLen  = input.int(14, "ATR Length")
slMult  = input.float(2.0, "Stop × ATR", step=0.1)
kellyCap = input.float(0.25, "Cap Kelly at", step=0.05, tooltip="Half-Kelly is safer")
lookbackTrades = input.int(50, "Trades for rolling stats")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
atr  = ta.atr(atrLen)
// Compute rolling W / avgW / avgL from closed trades (approximation: track strategy state)
winRate     = strategy.wintrades / math.max(strategy.closedtrades, 1)
avgWin      = strategy.grossprofit / math.max(strategy.wintrades, 1)
avgLoss     = strategy.grossloss   / math.max(strategy.losstrades, 1)
b           = avgLoss == 0 ? 1.0 : avgWin / avgLoss
kellyRaw    = b == 0 ? 0.0 : (winRate * (b + 1) - 1) / b
kellyFrac   = math.max(0.0, math.min(kellyCap, kellyRaw))
qtyCash     = strategy.equity * kellyFrac
qtyShares   = qtyCash / close
if ta.crossover(fast, slow) and kellyFrac > 0.01
    strategy.entry("L", strategy.long, qty=qtyShares)
    strategy.exit("X", "L", stop=close - slMult * atr)
if ta.crossunder(fast, slow)
    strategy.close("L", comment="Exit")
plot(kellyFrac, "Kelly Frac", color=color.aqua, display=display.data_window)
`,
      multi_factor_composite:
`//@version=6
// Composite alpha: momentum + trend + low-vol filter, requires all 3 aligned.
strategy("Multi-Factor Composite", overlay=true,
     initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)
momLen   = input.int(60,  "Momentum lookback (bars)")
momMinPct = input.float(0.05, "Min cumulative return", step=0.01)
trendLen = input.int(200, "Trend SMA")
volLen   = input.int(20,  "Vol lookback")
volMaxPct = input.float(75, "Skip if vol percentile >", minval=10, maxval=100)
volPctLen = input.int(252, "Vol percentile window")
exitLen  = input.int(5,   "Exit if close < N-bar low")
mom = close / close[momLen] - 1
trendUp = close > ta.sma(close, trendLen)
ret = math.log(close / close[1])
rv  = ta.stdev(ret, volLen)
vpct= ta.percentrank(rv, volPctLen)
volOk = vpct <= volMaxPct
allFactors = mom >= momMinPct and trendUp and volOk
exitTrigger = close < ta.lowest(low, exitLen)[1]
if allFactors and strategy.position_size == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0 and (exitTrigger or not trendUp)
    strategy.close("L", comment="FactorExit")
plotshape(allFactors and strategy.position_size == 0, "All-In", style=shape.triangleup, color=color.green, location=location.belowbar, size=size.small)
`,
      half_life_mr:
`//@version=6
// Estimate the half-life of a mean-reverting series via AR(1) coefficient.
// HL = -log(2) / log(phi). Use HL to size your MR holding window.
indicator("Mean-Reversion Half-Life", overlay=false)
len = input.int(100, "AR(1) window", minval=20)
// AR(1): close = phi * close[1] + intercept + eps
// phi = cov(close, close[1]) / var(close[1])
covv = ta.cov(close, close[1], len)
varr = ta.variance(close[1], len)
phi  = varr == 0 ? na : covv / varr
hl   = phi > 0 and phi < 1 ? -math.log(2) / math.log(phi) : na
plot(hl, "Half-Life (bars)", color=color.fuchsia, linewidth=2)
hline(10, color=color.gray, linestyle=hline.style_dashed)
hline(40, color=color.gray, linestyle=hline.style_dashed)
`,
      // ─── Siyolah TASI long-only patterns (v2.4.0) ───
      siyolah_derayah_base:
`//@version=6
// ─── siyolah_derayah_base ───
// Foundation TASI long-only strategy template. Every Siyolah Pine strategy
// should extend this. Encodes retail-compatible cost/sizing assumptions:
//   - long-only (no strategy.short calls anywhere)
//   - commission 22.5 bps per-side  (45 bps round-trip — conservative)
//   - slippage 5 ticks
//   - process_orders_on_close=true (no in-bar peek)
//   - default_qty 50000 SAR (top of retail contract's 10k-50k range)
//   - Sun-Thu only (Fri/Sat treated as no-trade)
// ADTV floor, round-trip cap, basket size are enforced GATE-SIDE
// (alpha_retail_long_only_gate), NOT in Pine.
strategy("Siyolah Derayah Base", overlay=true, currency=currency.SAR,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=50000,
     commission_type=strategy.commission.percent, commission_value=0.225,
     slippage=5,
     process_orders_on_close=true,
     calc_on_every_tick=false)

// Tadawul session mask.
inTasiSession = dayofweek != dayofweek.friday and dayofweek != dayofweek.saturday

// Forward-paper identity. Override per-candidate before deploying.
candidateId   = input.string("D0_w0",     "candidate_id")
frozenHash    = input.string("UNFROZEN",  "frozen_hash (sha256 of locked rules)")
modeStr       = input.string("research",  "mode", options=["research", "track_only", "forward_paper"])

// ─── Status table — read by data_get_pine_tables({study_filter:'Siyolah'}) ───
var table statusTbl = table.new(position.top_right, 2, 8, bgcolor=color.new(color.gray, 80), border_width=1)
delayedWarn = str.contains(syminfo.prefix, "DLY")
hashShort   = str.length(frozenHash) >= 12 ? str.substring(frozenHash, 0, 12) : frozenHash
if barstate.islast
    table.cell(statusTbl, 0, 0, "candidate_id",         text_color=color.white)
    table.cell(statusTbl, 1, 0, candidateId,             text_color=color.aqua)
    table.cell(statusTbl, 0, 1, "frozen_hash",          text_color=color.white)
    table.cell(statusTbl, 1, 1, hashShort,               text_color=color.aqua)
    table.cell(statusTbl, 0, 2, "mode",                 text_color=color.white)
    table.cell(statusTbl, 1, 2, modeStr,                 text_color=color.aqua)
    table.cell(statusTbl, 0, 3, "entry_condition",      text_color=color.white)
    table.cell(statusTbl, 1, 3, "set_in_body",           text_color=color.gray)
    table.cell(statusTbl, 0, 4, "cost_bps",             text_color=color.white)
    table.cell(statusTbl, 1, 4, "45",                    text_color=color.aqua)
    table.cell(statusTbl, 0, 5, "benchmark_symbol",     text_color=color.white)
    table.cell(statusTbl, 1, 5, "TADAWUL:TASI",         text_color=color.aqua)
    table.cell(statusTbl, 0, 6, "delayed_feed_warning", text_color=color.white)
    table.cell(statusTbl, 1, 6, delayedWarn ? "TRUE" : "false", text_color=delayedWarn ? color.red : color.gray)
    table.cell(statusTbl, 0, 7, "session_ok",           text_color=color.white)
    table.cell(statusTbl, 1, 7, inTasiSession ? "TRUE" : "weekend", text_color=inTasiSession ? color.lime : color.orange)

// ─── TODO: replace this skeleton with your entry/exit logic ───
// Example — uncomment + customise:
// entryCond = inTasiSession and ta.crossover(close, ta.sma(close, 50))
// exitCond  = ta.crossunder(close, ta.sma(close, 50))
// if entryCond and strategy.position_size == 0
//     strategy.entry("L", strategy.long)
// if exitCond and strategy.position_size > 0
//     strategy.close("L")
`,
      topk_basket_long_only:
`//@version=6
// ─── topk_basket_long_only ───
// Equal-weight top-K basket constructor for TASI. Composite score = user-
// configurable series (default: 60-bar momentum). On Sundays, ranks the
// CURRENT chart symbol against (k-1) reference tickers; enters if current
// symbol's score is in top-K, exits otherwise. Long-only.
//
// USAGE: deploy this strategy on EACH symbol you want considered. Entries
// fire only on symbols whose Sunday score lands in the top-K of the basket.
// Per-symbol notional / ADTV gating is downstream (alpha_retail_long_only_gate).
strategy("Top-K Basket Long-Only (TASI)", overlay=true, currency=currency.SAR,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=50000,
     commission_type=strategy.commission.percent, commission_value=0.225,
     slippage=5,
     process_orders_on_close=true)

k        = input.int(5,  "k (top-K to hold)", minval=2, maxval=10)
scoreLen = input.int(60, "Score: lookback bars", minval=5)
ref1 = input.symbol("TADAWUL:1120", "Reference symbol 1")
ref2 = input.symbol("TADAWUL:2222", "Reference symbol 2")
ref3 = input.symbol("TADAWUL:1180", "Reference symbol 3")
ref4 = input.symbol("TADAWUL:1010", "Reference symbol 4")
ref5 = input.symbol("TADAWUL:7010", "Reference symbol 5")
ref6 = input.symbol("TADAWUL:4030", "Reference symbol 6")
ref7 = input.symbol("TADAWUL:5110", "Reference symbol 7")
ref8 = input.symbol("TADAWUL:2010", "Reference symbol 8")
ref9 = input.symbol("TADAWUL:2280", "Reference symbol 9")

inTasiSession  = dayofweek != dayofweek.friday and dayofweek != dayofweek.saturday
isRebalanceDay = dayofweek == dayofweek.sunday

// Composite score: rolling momentum (close / close[lookback] - 1).
// Override here for your own composite (quality + momentum + low-vol blend).
scoreCurrent = close / close[scoreLen] - 1
scoreOf(simple string sym) =>
    request.security(sym, timeframe.period, close / close[scoreLen] - 1,
                     ignore_invalid_symbol=true)
scores = array.from(scoreCurrent,
                    scoreOf(ref1), scoreOf(ref2), scoreOf(ref3),
                    scoreOf(ref4), scoreOf(ref5), scoreOf(ref6),
                    scoreOf(ref7), scoreOf(ref8), scoreOf(ref9))

// Current symbol's rank: how many basket scores beat it (0 = best).
currRank = 0
for i = 1 to array.size(scores) - 1
    s = array.get(scores, i)
    if not na(s) and s > scoreCurrent
        currRank += 1
inTopK = currRank < k

if isRebalanceDay and inTasiSession
    if inTopK and strategy.position_size == 0
        strategy.entry("Hold", strategy.long)
    if not inTopK and strategy.position_size > 0
        strategy.close("Hold", comment="OutOfTopK")

bgcolor(strategy.position_size > 0 ? color.new(color.green, 92) : na, title="In basket")

// ─── Status table ───
var table tbl = table.new(position.top_right, 2, 5, bgcolor=color.new(color.gray, 80), border_width=1)
delayedWarn = str.contains(syminfo.prefix, "DLY")
if barstate.islast
    table.cell(tbl, 0, 0, "candidate_id",         text_color=color.white)
    table.cell(tbl, 1, 0, "topk_basket",          text_color=color.aqua)
    table.cell(tbl, 0, 1, "mode",                 text_color=color.white)
    table.cell(tbl, 1, 1, "research",             text_color=color.aqua)
    table.cell(tbl, 0, 2, "rank",                 text_color=color.white)
    table.cell(tbl, 1, 2, str.tostring(currRank) + "/" + str.tostring(array.size(scores) - 1), text_color=inTopK ? color.lime : color.gray)
    table.cell(tbl, 0, 3, "cost_bps",             text_color=color.white)
    table.cell(tbl, 1, 3, "45",                    text_color=color.aqua)
    table.cell(tbl, 0, 4, "delayed_feed_warning", text_color=color.white)
    table.cell(tbl, 1, 4, delayedWarn ? "TRUE" : "false", text_color=delayedWarn ? color.red : color.gray)
`,
      event_window_study:
`//@version=6
// ─── event_window_study ───
// Single-symbol event-anchored holding study. Enter at the close of an event-
// day bar (B1: retail can't transact at deal-print intraday time), hold for
// hold_bars, exit. Logs {entry_date, exit_date, entry_px, exit_px,
// forward_return_bps, cost_net_bps} per event via log.info — readable via
// pine_get_console / data_get_pine_console.
//
// SAFETY: Pine label/box cap is 500. We cap event dates at 100 to leave room
// for plot shapes. If your CSV has more, set events_truncated=true and the
// excess events are silently dropped — status table surfaces this.
//
// AXIOM B8 GUARD: defaults to daily bars. Errors at runtime on intraday
// timeframes unless acknowledge_intraday_tz_risk=true, because deal_time
// source-TZ inconsistency in upstream data is unverified for non-daily.
strategy("Event Window Study (TASI)", overlay=true, currency=currency.SAR,
     initial_capital=100000,
     default_qty_type=strategy.cash, default_qty_value=50000,
     commission_type=strategy.commission.percent, commission_value=0.225,
     slippage=5,
     process_orders_on_close=true,
     max_labels_count=500)

eventDatesCsv = input.string("",   "event_dates_csv (YYYY-MM-DD,YYYY-MM-DD,...)")
holdBars      = input.int(5,        "hold_bars",        minval=1, maxval=60)
costBps       = input.int(45,       "cost_bps (round-trip)", minval=0, maxval=200)
ackIntradayTz = input.bool(false,   "acknowledge_intraday_tz_risk (Axiom B8)")

inTasiSession = dayofweek != dayofweek.friday and dayofweek != dayofweek.saturday

if timeframe.isintraday and not ackIntradayTz
    runtime.error("event_window_study defaults to daily bars. Intraday source-TZ axiom B8 not acknowledged — set acknowledge_intraday_tz_risk=true only after independently verifying deal_time integrity.")

// Parse event dates once on the first bar.
var array<string> parsedDates = array.new<string>()
var bool truncated = false
if barstate.isfirst
    raw = str.split(eventDatesCsv, ",")
    nTotal = array.size(raw)
    nKeep  = math.min(nTotal, 100)
    if nTotal > 100
        truncated := true
    for i = 0 to nKeep - 1
        d = str.trim(array.get(raw, i))
        if str.length(d) >= 10
            array.push(parsedDates, str.substring(d, 0, 10))

todayStr = str.format("{0,number,0000}-{1,number,00}-{2,number,00}", year, month, dayofmonth)
isEventDay = array.includes(parsedDates, todayStr)

// Holding state.
var int    barsLeft  = 0
var float  entryPx   = na
var string entryDate = na

if isEventDay and inTasiSession and strategy.position_size == 0
    strategy.entry("EV", strategy.long)
    barsLeft  := holdBars
    entryPx    := close
    entryDate  := todayStr

if strategy.position_size > 0
    barsLeft := barsLeft - 1
    if barsLeft <= 0
        retBps = ((close - entryPx) / entryPx) * 10000.0
        log.info("EVENT entry={0} exit={1} entry_px={2,number,#.####} exit_px={3,number,#.####} forward_return_bps={4,number,#.##} cost_net_bps={5,number,#.##}",
                 entryDate, todayStr, entryPx, close, retBps, retBps - costBps)
        strategy.close("EV", comment="HoldDone")
        entryPx   := na
        entryDate := na

// ─── Status table ───
var table tbl = table.new(position.top_right, 2, 5, bgcolor=color.new(color.gray, 80), border_width=1)
if barstate.islast
    table.cell(tbl, 0, 0, "events_total",      text_color=color.white)
    table.cell(tbl, 1, 0, str.tostring(array.size(parsedDates)), text_color=color.aqua)
    table.cell(tbl, 0, 1, "events_active",     text_color=color.white)
    table.cell(tbl, 1, 1, strategy.position_size > 0 ? "1" : "0", text_color=color.aqua)
    table.cell(tbl, 0, 2, "events_truncated",  text_color=color.white)
    table.cell(tbl, 1, 2, truncated ? "TRUE" : "false", text_color=truncated ? color.orange : color.gray)
    table.cell(tbl, 0, 3, "intraday_ack",      text_color=color.white)
    table.cell(tbl, 1, 3, ackIntradayTz ? "TRUE" : "false", text_color=ackIntradayTz ? color.yellow : color.gray)
    table.cell(tbl, 0, 4, "cost_bps",          text_color=color.white)
    table.cell(tbl, 1, 4, str.tostring(costBps), text_color=color.aqua)

plotshape(isEventDay, "Event", style=shape.triangleup, color=color.lime, location=location.belowbar, size=size.small)
`,
    },
    library: {
      blank:
`//@version=6
// @description TODO: describe what this library provides
library("MyLibrary")
// export myfunc(simple int x) =>
//     x * 2
`,
      math_helpers:
`//@version=6
// @description Common math helpers (z-score, percentile rank, robust mean).
library("MathHelpers")

// @function Z-score of \`source\` over the last \`length\` bars.
// @returns series float — current z-score.
export zscore(series float source, simple int length) =>
    mean = ta.sma(source, length)
    sd   = ta.stdev(source, length)
    sd == 0 ? 0.0 : (source - mean) / sd

// @function Median-of-last-N (more robust than mean against outliers).
export rolling_median(series float source, simple int length) =>
    var array<float> buf = array.new<float>(length, na)
    array.shift(buf)
    array.push(buf, source)
    if bar_index < length - 1
        na
    else
        sorted = array.copy(buf)
        array.sort(sorted)
        array.get(sorted, length / 2)
`,
    },
  };
  const bucket = templates[type];
  if (!bucket) throw new Error(`Unknown template type: ${type}. Use one of: ${Object.keys(templates).join(', ')}`);
  const available = Object.keys(bucket);
  if (!pattern) {
    return { success: true, type, available_patterns: available, note: `Pass pattern: one of ${available.join(', ')}` };
  }
  const src = bucket[pattern];
  if (!src) throw new Error(`Unknown ${type} pattern: ${pattern}. Available: ${available.join(', ')}`);
  return { success: true, type, pattern, source: src, line_count: src.split('\n').length };
}

/**
 * Parse `input.*()` declarations from Pine source. Returns a list of
 * { id, kind, defval, title, options, minval, maxval, step } extracted via
 * lightweight regex — useful to populate grid-search axes or document a script.
 */
export function extractInputs({ source }) {
  if (!source || typeof source !== 'string') throw new Error('source is required');
  const re = /(?:^|\s)(\w+)\s*=\s*input\.(int|float|bool|string|source|timeframe|symbol|session|color|time)\s*\(([\s\S]*?)\)/gm;
  const out = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, id, kind, argsRaw] = m;
    const args = argsRaw;
    // Capture first positional arg as defval (best-effort).
    const defMatch = args.match(/^\s*([^,]+?)(?:\s*,|$)/);
    const titleMatch = args.match(/(?:^|,)\s*(?:title\s*=\s*)?["']([^"']+)["']/);
    const minMatch = args.match(/\bminval\s*=\s*([\-0-9.]+)/);
    const maxMatch = args.match(/\bmaxval\s*=\s*([\-0-9.]+)/);
    const stepMatch = args.match(/\bstep\s*=\s*([\-0-9.]+)/);
    const optsMatch = args.match(/\boptions\s*=\s*\[([^\]]+)\]/);
    out.push({
      id,
      kind,
      defval: defMatch ? defMatch[1].trim() : undefined,
      title: titleMatch ? titleMatch[1] : undefined,
      minval: minMatch ? Number(minMatch[1]) : undefined,
      maxval: maxMatch ? Number(maxMatch[1]) : undefined,
      step: stepMatch ? Number(stepMatch[1]) : undefined,
      options: optsMatch ? optsMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) : undefined,
    });
  }
  return { success: true, count: out.length, inputs: out };
}

/**
 * Heuristic v4/v5 -> v6 migration. Returns the rewritten source plus a
 * list of which rules fired so the agent can review the diff. NOT a
 * substitute for `pine_check`, but bridges 80% of common breakages.
 */
export function migrateToV6({ source }) {
  if (!source || typeof source !== 'string') throw new Error('source is required');
  let out = source;
  const applied = [];
  for (const rule of MIGRATION_RULES) {
    let count = 0;
    out = out.replace(rule.pattern, (...m) => { count++; return typeof rule.replacement === 'function' ? rule.replacement(...m) : rule.replacement.replace(/\$(\d)/g, (_, idx) => m[Number(idx)]); });
    if (count > 0) applied.push({ rule: rule.name, occurrences: count });
  }
  // Ensure the file starts with //@version=6 if no version header existed.
  if (!/\/\/@version\s*=\s*\d/.test(out)) {
    out = '//@version=6\n' + out;
    applied.push({ rule: 'inserted_version_header', occurrences: 1 });
  }
  return {
    success: true,
    rules_applied: applied.length,
    rules: applied,
    source: out,
    note: 'Heuristic rewrite — always run pine_lint on the result before deploying.',
  };
}

/**
 * Translate a Pine compile error string into an actionable explanation
 * with fix suggestions. Pass the raw `message` from pine_get_errors.
 */
export function explainError({ message }) {
  if (!message || typeof message !== 'string') throw new Error('message is required');
  const matches = [];
  for (const rule of ERROR_EXPLANATIONS) {
    const m = message.match(rule.match);
    if (m) {
      matches.push({ pattern: rule.match.toString(), explanation: rule.explain(m) });
    }
  }
  if (matches.length === 0) {
    return {
      success: true,
      message,
      matched: false,
      explanation: 'No specific explanation rule matched. Common Pine issues: missing `//@version=6`, using v4 unprefixed built-ins (rsi → ta.rsi), wrong indentation (4 spaces required), passing series where simple is required (lengths), or strategy.* used in an indicator() script.',
    };
  }
  return { success: true, message, matched: true, count: matches.length, matches };
}

/**
 * Look up a v6 builtin signature by name (e.g., "ta.rsi", "rsi", "strategy.entry").
 * Returns the exact match if found, else up to 10 substring matches.
 */
export function v6Reference({ name, list_all = false }) {
  if (list_all) {
    const all = listAllBuiltins();
    return { success: true, mode: 'list_all', count: all.length, builtins: all };
  }
  if (!name) {
    return {
      success: true,
      mode: 'namespaces',
      namespaces: Object.keys(V6_BUILTINS),
      note: 'Pass `name` to look up a specific function (e.g., "ta.rsi", "strategy.entry"), or `list_all: true` to dump every cached builtin.',
    };
  }
  return { success: true, mode: 'lookup', query: name, ...lookupBuiltin(name) };
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
