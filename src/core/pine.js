/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    // TradingView can keep a hidden (0x0) editor instance in the DOM; prefer the visible one.
    var all = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    var container = null;
    for (var c = 0; c < all.length; c++) { if (all[c].offsetParent !== null) { container = all[c]; break; } }
    if (!container) container = all[0] || null;
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

// ── Pine editor controller finder (injected into TV page) ──
// The editor's React context exposes a controller with openScript / openNewScript /
// getScriptIdVersion / isModified. Using it is the only way to actually switch the
// script the editor is bound to — setValue() alone keeps the CURRENT script's identity,
// so a later save would overwrite that saved script.
const FIND_PINE_CTL = `
  (function findPineController() {
    var all = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    var starts = [];
    for (var c = 0; c < all.length; c++) { if (all[c].offsetParent !== null) starts.push(all[c]); }
    var names = document.querySelectorAll('[class*="nameButton-"]');
    for (var n = 0; n < names.length; n++) { if (names[n].offsetParent !== null) starts.push(names[n]); }
    for (var s = 0; s < starts.length; s++) {
      var el = starts[s], fiberKey = null;
      for (var i = 0; i < 20 && el; i++) {
        fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fiberKey) break;
        el = el.parentElement;
      }
      if (!fiberKey) continue;
      var cur = el[fiberKey];
      for (var d = 0; d < 80 && cur; d++) {
        var v = cur.memoizedProps && cur.memoizedProps.value;
        if (v && typeof v.openScript === 'function' && typeof v.getScriptIdVersion === 'function') return v;
        cur = cur.return;
      }
    }
    return null;
  })()
`;

// Describes which saved script (if any) the editor is currently bound to.
const SCRIPT_INFO_JS = `
  function _scriptInfo(ctl) {
    var nb = null, names = document.querySelectorAll('[class*="nameButton-"]');
    for (var n = 0; n < names.length; n++) { if (names[n].offsetParent !== null) { nb = names[n]; break; } }
    var idv = null, modified = null, draft = null;
    try { idv = ctl ? ctl.getScriptIdVersion() : null; } catch (e) {}
    try { modified = ctl ? !!ctl.isModified() : null; } catch (e) {}
    try { draft = ctl ? !!ctl.isDraft() : null; } catch (e) {}
    return {
      name: nb ? nb.textContent.trim() : null,
      script_id: idv ? idv.scriptIdPart : null,
      version: idv ? idv.version : null,
      is_new_unsaved: ctl ? idv === null : null,
      is_draft: draft,
      has_unsaved_changes: modified,
    };
  }
`;

// Clicks the editor's compile button. Matches data-qa-id first so it works in any UI
// language (the English-text-only match fell through to "Save" in e.g. Korean UI).
// The add/update button shares data-qa-id "add-script-to-chart" (its title switches
// between "Add to chart" and "Update on chart"), so qa matches report 'Add/update on chart'.
// Returns 'Save and add to chart' | 'Add to chart' | 'Update on chart' | 'Add/update on chart' | 'Pine Save' | null.
const CLICK_COMPILE_BUTTON_JS = `
  (function() {
    function vis(el) { return el && el.offsetParent !== null; }
    var btns = Array.prototype.slice.call(document.querySelectorAll('button')).filter(vis);
    var qaBtn = null, addBtn = null, updateBtn = null, saveBtn = null;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i], qa = b.getAttribute('data-qa-id') || '', text = b.textContent.trim();
      if (/save and add to chart/i.test(text)) { b.click(); return 'Save and add to chart'; }
      if (!qaBtn && qa === 'add-script-to-chart') qaBtn = b;
      if (!addBtn && /^add to chart$/i.test(text)) addBtn = b;
      if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = b;
      if (!saveBtn && (qa === 'pine-script-save-button' || b.className.indexOf('saveButton') !== -1)) saveBtn = b;
    }
    if (addBtn) { addBtn.click(); return 'Add to chart'; }
    if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
    if (qaBtn) { qaBtn.click(); return 'Add/update on chart'; }
    if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
    return null;
  })()
`;

/** Returns the saved script the editor is bound to: { name, script_id, version, ... }. */
export async function getEditorScript() {
  return evaluate(`
    (function() {
      ${SCRIPT_INFO_JS}
      return _scriptInfo(${FIND_PINE_CTL});
    })()
  `);
}

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
const VISIBLE_EDITOR_JS = `
  (function() {
    var all = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    // Parenthesized: FIND_MONACO starts with a newline, and a bare "return <newline>" returns undefined (ASI).
    for (var c = 0; c < all.length; c++) { if (all[c].offsetParent !== null) return (${FIND_MONACO}) !== null; }
    return false;
  })()
`;

export async function ensurePineEditorOpen() {
  const already = await evaluate(VISIBLE_EDITOR_JS);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await evaluate(VISIBLE_EDITOR_JS)) return true;
  }

  await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="pine-dialog-button"]')
        || document.querySelector('[aria-label="Pine"]');
      // It's a toggle: clicking an already-pressed button would close the editor.
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(VISIBLE_EDITOR_JS);
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
  return { success: true, lines_set: source.split('\n').length, editor_script: await getEditorScript() };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const scriptBefore = await getEditorScript();
  const clicked = await evaluate(CLICK_COMPILE_BUTTON_JS);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return {
    success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback',
    editor_script: scriptBefore, ...savedScriptNote(clicked, scriptBefore),
  };
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

  const scriptBefore = await getEditorScript();
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

  return {
    success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched',
    editor_script: scriptBefore,
    ...(scriptBefore?.script_id && { saved_to_script: { name: scriptBefore.name, script_id: scriptBefore.script_id, previous_version: scriptBefore.version } }),
  };
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

  const scriptBefore = await getEditorScript();
  const buttonClicked = await evaluate(CLICK_COMPILE_BUTTON_JS);

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
    editor_script: scriptBefore,
    ...savedScriptNote(buttonClicked, scriptBefore),
  };
}

// For a saved (non-draft) script with unsaved edits, every compile path — "Save",
// "Update on chart", and "Add to chart" (which shares data-qa-id add-script-to-chart
// with the update button) — writes a new version of that script. Make that visible.
function savedScriptNote(buttonClicked, script) {
  if (!buttonClicked || !script?.script_id || script.is_draft || !script.has_unsaved_changes) return {};
  return {
    saved_to_script: { name: script.name, script_id: script.script_id, previous_version: script.version },
    note: `This saved a new version of "${script.name}". To keep it untouched, use pine_new (or open another script) before setting source.`,
  };
}

/**
 * Refuses to navigate away from a script with unsaved edits (they would be lost),
 * unless the caller explicitly opts in. Returns the current editor script info.
 */
async function guardUnsaved(discardUnsaved, action) {
  const current = await getEditorScript();
  if (!current || current.has_unsaved_changes === null) {
    throw new Error('Pine Editor controller not found — refusing to ' + action + ' by overwriting the open script. Open the Pine Editor and retry.');
  }
  if (current.has_unsaved_changes && !discardUnsaved) {
    throw new Error(`The open script "${current.name}" has unsaved changes. Save it first (pine_save), or pass discard_unsaved: true to ${action} anyway.`);
  }
  return current;
}

async function waitForEditorScript(predicate, timeoutMs = 10000) {
  let info = null;
  for (let waited = 0; waited <= timeoutMs; waited += 250) {
    info = await getEditorScript();
    if (info && predicate(info)) return info;
    await new Promise(r => setTimeout(r, 250));
  }
  return info;
}

/**
 * Creates a real new (unsaved) script in the Pine Editor. Unlike replacing the
 * editor text, this unbinds the editor from the previously open saved script, so
 * a later save prompts for a new name instead of overwriting that script.
 */
export async function newScript({ type, discard_unsaved = false }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const kind = ['indicator', 'strategy', 'library'].includes(type) ? type : 'indicator';
  const previous = await guardUnsaved(discard_unsaved, 'create a new script');

  const started = await evaluate(`
    (function() {
      var ctl = ${FIND_PINE_CTL};
      if (!ctl || typeof ctl.openNewScript !== 'function') return false;
      ctl.openNewScript(${JSON.stringify(kind)});
      return true;
    })()
  `);
  if (!started) throw new Error('Pine Editor controller not found — cannot create a new script.');

  const now = await waitForEditorScript(info => info.is_new_unsaved === true);
  if (!now || now.is_new_unsaved !== true) {
    throw new Error(`New script was not created; the editor is still bound to "${now?.name}" (${now?.script_id}). Nothing was changed.`);
  }

  return {
    success: true, type: kind, action: 'new_script_created',
    editor_script: now,
    previous_script: previous.script_id ? { name: previous.name, script_id: previous.script_id, version: previous.version } : null,
    note: 'Editor now holds a new unsaved script. Use pine_set_source, then pine_save (prompts for a name) or pine_smart_compile.',
  };
}

/**
 * Switches the Pine Editor to a saved script by name. The editor is re-bound to
 * that script, so later saves go to it — not to whatever was open before.
 */
export async function openScript({ name, discard_unsaved = false }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());
  const match = await evaluateAsync(`
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
          return {id: match.scriptIdPart, version: String(match.version || '1.0'), name: match.scriptName || match.scriptTitle};
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);
  if (match?.error) throw new Error(match.error);

  const previous = await getEditorScript();
  if (previous?.script_id === match.id && !previous.has_unsaved_changes) {
    const lines = await evaluate(`(function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue().split('\\n').length : null; })()`);
    return { success: true, name: match.name, script_id: match.id, version: previous.version, lines, source: 'internal_api', opened: true, already_open: true };
  }
  await guardUnsaved(discard_unsaved, `open "${match.name}"`);

  const started = await evaluate(`
    (function() {
      var ctl = ${FIND_PINE_CTL};
      if (!ctl) return false;
      ctl.openScript({ scriptIdPart: ${JSON.stringify(match.id)}, version: ${JSON.stringify(match.version)} });
      return true;
    })()
  `);
  if (!started) throw new Error('Pine Editor controller not found — refusing to inject source into the currently open script.');

  const now = await waitForEditorScript(info => info.script_id === match.id);
  if (!now || now.script_id !== match.id) {
    throw new Error(`Could not switch the editor to "${match.name}"; it is bound to "${now?.name}" (${now?.script_id}). Nothing was changed.`);
  }
  const lines = await evaluate(`(function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue().split('\\n').length : null; })()`);

  return {
    success: true, name: match.name, script_id: match.id, version: now.version, lines, source: 'internal_api', opened: true,
    previous_script: previous?.script_id ? { name: previous.name, script_id: previous.script_id } : null,
  };
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
