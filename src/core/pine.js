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
          // Multiple instances can exist (hidden dialog/preview editors); only
          // the one attached to the visible tab reflects what Save writes.
          var visible = editors.filter(function(e) {
            var dom = e.getDomNode();
            return !!(dom && dom.offsetParent);
          });
          if (visible.length > 0) return { editor: visible[0], env: env };
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
  // Saves write to the tab shown in the editor header — surface it so callers
  // can catch a wrong-tab write before compiling.
  const currentScript = await getCurrentScriptName();
  return { success: true, lines_set: source.split('\n').length, current_script: currentScript };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

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
    // Saves land in the editor's active tab — report it so a wrong-tab save
    // is caught immediately instead of silently overwriting another script.
    current_script: await getCurrentScriptName(),
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

// ── Editor tab helpers (injected) ──
// The Pine editor keeps ONE Monaco instance whose content belongs to the tab
// shown in the header title widget. Saving writes to THAT script, so any
// "new"/"open" implementation that only calls editor.setValue() silently
// redirects the next save into whatever tab happened to be open. These
// helpers drive the real header dropdown so the tab identity actually
// changes, and every flow verifies the header title afterwards.
const TAB_HELPERS = `
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var tabName = function() {
    var nb = document.querySelector('.tv-script-widget [class*="nameButton"]');
    return nb ? nb.textContent.trim() : null;
  };
  var overlap = function() { return document.getElementById('overlap-manager-root') || document.body; };
  // Menu items break if a synthetic pointerdown precedes the click (the menu
  // dismisses itself and unmounts before the click lands), while the
  // Open-script dialog rows only react to pointer events. Use fire() for
  // menus/buttons and firePointer() for dialog rows.
  var fire = function(el) {
    ['mousedown', 'mouseup', 'click'].forEach(function(t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
    });
  };
  var firePointer = function(el) {
    [['pointerdown', PointerEvent], ['mousedown', MouseEvent],
     ['pointerup', PointerEvent], ['mouseup', MouseEvent],
     ['click', MouseEvent]].forEach(function(p) {
      el.dispatchEvent(new p[1](p[0], { bubbles: true, cancelable: true, button: 0 }));
    });
  };
  var closeSearchDialog = function() {
    var inp = Array.prototype.slice.call(document.querySelectorAll('input')).find(function(x) {
      return x.placeholder === 'Search' && x.offsetParent !== null;
    });
    if (!inp) return;
    var scope = inp.closest('[class*="wrapper"]');
    var btn = scope && scope.querySelector('button[data-name="close"], [class*="close"]');
    if (btn) btn.click();
  };
  var openTitleMenu = async function() {
    var btn = document.querySelector('.tv-script-widget [class*="nameButton"]');
    if (!btn) return null;
    fire(btn);
    for (var i = 0; i < 10; i++) {
      var items = overlap().querySelectorAll('[role="menuitem"]');
      if (items.length > 0) return items;
      await sleep(100);
    }
    return null;
  };
  var closeMenus = function() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };
  // "Save script before switching?" appears when the current tab has unsaved
  // edits. mode: 'save' | 'discard' | 'cancel'. Returns what happened.
  var handleWarning = function(mode) {
    var dlg = overlap().querySelector('[data-name="warning-dialog"]');
    if (!dlg || !/Save script before switching/.test(dlg.textContent)) return null;
    var want = mode === 'save' ? 'Save' : mode === 'discard' ? "Don't save" : 'Cancel';
    var btn = Array.prototype.slice.call(dlg.querySelectorAll('button')).find(function(b) {
      return b.textContent.trim() === want;
    });
    if (!btn) return null;
    btn.click();
    return mode === 'cancel' ? 'cancelled' : mode === 'save' ? 'saved' : 'discarded';
  };
  // Poll until the header shows the wanted tab, resolving the unsaved-changes
  // dialog along the way. Returns {ok, warning, current}.
  var awaitTab = async function(matchFn, unsavedMode, timeoutMs) {
    var warning = null;
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      var w = handleWarning(unsavedMode);
      if (w) {
        warning = w;
        if (w === 'cancelled') return { ok: false, warning: warning, current: tabName() };
      }
      var t = tabName();
      if (t && matchFn(t)) return { ok: true, warning: warning, current: t };
      await sleep(150);
    }
    return { ok: false, warning: warning, current: tabName() };
  };
`;

export async function getCurrentScriptName() {
  return evaluate(`
    (function() {
      var nb = document.querySelector('.tv-script-widget [class*="nameButton"]');
      return nb ? nb.textContent.trim() : null;
    })()
  `);
}

export async function newScript({ type, unsaved = 'cancel' }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const result = await evaluateAsync(`
    (async function() {
      ${TAB_HELPERS}
      var wantType = ${JSON.stringify(type || 'indicator')};
      var before = tabName();

      var items = await openTitleMenu();
      if (!items) return { error: 'Could not open the script title menu.' };
      var createNew = Array.prototype.slice.call(items).find(function(e) {
        return /^Create new/.test(e.textContent.trim());
      });
      if (!createNew) { closeMenus(); return { error: '"Create new" menu item not found.' }; }

      // Expand the submenu (it opens on hover) and pick the script type.
      ['pointerenter', 'mouseenter', 'mouseover', 'mousemove'].forEach(function(t) {
        createNew.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      });
      var typeItem = null;
      for (var i = 0; i < 15; i++) {
        await sleep(100);
        typeItem = Array.prototype.slice.call(overlap().querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'))
          .find(function(e) {
            var t = e.textContent.trim().toLowerCase();
            return t === wantType || t.indexOf(wantType) === 0;
          });
        if (typeItem) break;
      }
      if (!typeItem) { fire(createNew); await sleep(300);
        typeItem = Array.prototype.slice.call(overlap().querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'))
          .find(function(e) {
            var t = e.textContent.trim().toLowerCase();
            return t === wantType || t.indexOf(wantType) === 0;
          });
      }
      if (!typeItem) { closeMenus(); return { error: '"Create new" submenu entry for "' + wantType + '" not found.' }; }
      fire(typeItem);

      var res = await awaitTab(function(t) { return t !== before; }, ${JSON.stringify(unsaved)}, 6000);
      if (!res.ok) {
        return { error: res.warning === 'cancelled'
          ? 'Current tab has unsaved changes; pass unsaved: "save" or "discard" to proceed.'
          : 'Editor tab did not change after Create new (still "' + res.current + '").',
          current_script: res.current, unsaved_handling: res.warning };
      }
      return { success: true, current_script: res.current, previous_script: before, unsaved_handling: res.warning };
    })()
  `);

  if (result?.error) {
    const err = new Error(result.error);
    err.details = result;
    throw err;
  }
  return { success: true, type, action: 'new_script_created', ...result };
}

export async function openScript({ name, unsaved = 'cancel' }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const result = await evaluateAsync(`
    (async function() {
      ${TAB_HELPERS}
      var target = ${JSON.stringify(name)};
      var lc = target.toLowerCase();
      var matches = function(t) {
        var v = (t || '').trim().toLowerCase();
        return v === lc || v.indexOf(lc) !== -1;
      };

      var before = tabName();
      if (before && before.trim().toLowerCase() === lc) {
        return { success: true, current_script: before, already_open: true };
      }

      var items = await openTitleMenu();
      if (!items) return { error: 'Could not open the script title menu.' };

      // Fast path: the "Recently used" list in the dropdown.
      var recents = Array.prototype.slice.call(overlap().querySelectorAll('[role="menuitemcheckbox"]'));
      var hit = recents.find(function(e) { return (e.getAttribute('aria-label') || '').trim().toLowerCase() === lc; })
        || recents.find(function(e) { return matches(e.getAttribute('aria-label')); });

      if (hit) {
        fire(hit);
      } else {
        // Fallback: the "Open script…" search dialog.
        var openItem = Array.prototype.slice.call(overlap().querySelectorAll('[role="menuitem"]')).find(function(e) {
          return /^Open script/.test((e.getAttribute('aria-label') || e.textContent).trim());
        });
        if (!openItem) { closeMenus(); return { error: '"Open script…" menu item not found.' }; }
        fire(openItem);

        var inp = null;
        for (var i = 0; i < 20; i++) {
          await sleep(150);
          inp = Array.prototype.slice.call(document.querySelectorAll('input')).find(function(x) {
            return x.placeholder === 'Search' && x.offsetParent !== null;
          });
          if (inp) break;
        }
        if (!inp) return { error: '"Open script" dialog did not appear.' };

        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, target);
        inp.dispatchEvent(new Event('input', { bubbles: true }));

        // The list is virtualized and filters async — poll for a matching row.
        var scope = inp.closest('[class*="wrapper"]') || document;
        var rowTitle = function(r) {
          var t = r.querySelector('[class*="titleText"], [class*="title"]');
          return t ? t.textContent.trim() : '';
        };
        var row = null;
        for (var k = 0; k < 20; k++) {
          await sleep(150);
          var rows = Array.prototype.slice.call(scope.querySelectorAll('[class*="itemRow"]'));
          row = rows.find(function(r) { return rowTitle(r).toLowerCase() === lc; })
            || rows.find(function(r) { return matches(rowTitle(r)); });
          if (row) break;
        }
        if (!row) {
          closeSearchDialog();
          return { error: 'Script "' + target + '" not found in the Open script dialog. Use pine_list_scripts to see available scripts.' };
        }
        firePointer(row.querySelector('[class*="itemInfo"]') || row);
      }

      var res = await awaitTab(matches, ${JSON.stringify(unsaved)}, 6000);
      closeSearchDialog();
      if (!res.ok) {
        return { error: res.warning === 'cancelled'
          ? 'Current tab "' + before + '" has unsaved changes; pass unsaved: "save" or "discard" to proceed.'
          : 'Editor tab did not switch to "' + target + '" (still "' + res.current + '").',
          current_script: res.current, unsaved_handling: res.warning };
      }
      return { success: true, current_script: res.current, previous_script: before, unsaved_handling: res.warning };
    })()
  `);

  if (result?.error) {
    const err = new Error(result.error);
    err.details = result;
    throw err;
  }
  return { success: true, name: result.current_script, opened: true, source: 'editor_ui', ...result };
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
