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

const TITLE_BUTTON_SELECTOR = '[data-qa-id="pine-script-title-button"]';

/**
 * Which script the Pine Editor is bound to: its displayed title, the Monaco model URI
 * (a fresh UUID per opened/created script) and the current source.
 */
async function getEditorIdentity() {
  return evaluate(`
    (function() {
      var titleBtn = document.querySelector('${TITLE_BUTTON_SELECTOR}');
      var m = ${FIND_MONACO};
      if (!titleBtn || !m) return null;
      var model = m.editor.getModel();
      return {
        title: titleBtn.textContent.trim(),
        modelUri: model ? model.uri.toString() : null,
        source: m.editor.getValue(),
      };
    })()
  `);
}

async function pollUntil(check, timeoutMs = 3000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function closeMenus() {
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
}

/** Clicks Cancel on TradingView's "Save script before switching?" prompt. Returns true if it was showing. */
async function cancelUnsavedChangesDialog() {
  return evaluate(`
    (function() {
      var dontSave = document.querySelector('[data-qa-id="dontSave-btn"]');
      if (!dontSave || dontSave.offsetParent === null) return false;
      var container = dontSave.parentElement;
      for (var i = 0; i < 6 && container; i++) {
        var buttons = container.querySelectorAll('button');
        for (var j = 0; j < buttons.length; j++) {
          if (/^cancel$/i.test(buttons[j].textContent.trim())) { buttons[j].click(); return true; }
        }
        container = container.parentElement;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()
  `);
}

/** Title string from the indicator()/strategy()/library() declaration, or null if not found. */
export function getDeclaredTitle(source) {
  const match = /^\s*(?:indicator|strategy|library)\s*\(\s*(?:title\s*=\s*)?(["'])((?:(?!\1).)*)\1/m.exec(source || '');
  return match ? match[2] : null;
}

/**
 * Refuses to save when the editor is bound to a saved script whose name differs from the
 * title declared in the source — that combination means the source was injected into the
 * wrong script and saving would overwrite it.
 */
async function assertSaveTargetMatchesSource({ allowTitleMismatch = false } = {}) {
  if (allowTitleMismatch) return;

  const identity = await getEditorIdentity();
  if (!identity) throw new Error('Could not read the Pine Editor script title; refusing to save.');
  if (/^untitled/i.test(identity.title)) return;

  const declaredTitle = getDeclaredTitle(identity.source);
  if (!declaredTitle || declaredTitle.trim() === identity.title) return;

  throw new Error(
    `Refusing to save: the Pine Editor is bound to saved script "${identity.title}" but the source declares "${declaredTitle}". ` +
    `Saving would overwrite "${identity.title}". Run pine_new first to create a new script, ` +
    `or pass allow_title_mismatch: true if you really intend to update "${identity.title}".`
  );
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
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile({ allowTitleMismatch = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');
  await assertSaveTargetMatchesSource({ allowTitleMismatch });

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

export async function save({ allowTitleMismatch = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');
  await assertSaveTargetMatchesSource({ allowTitleMismatch });

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

export async function smartCompile({ allowTitleMismatch = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');
  await assertSaveTargetMatchesSource({ allowTitleMismatch });

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

const SCRIPT_TYPE_MENU_LABELS = { indicator: /^Indicator/, strategy: /^Strategy/, library: /^Library/ };

export async function newScript({ type }) {
  const menuLabel = SCRIPT_TYPE_MENU_LABELS[type];
  if (!menuLabel) throw new Error(`Unknown script type "${type}". Use indicator, strategy or library.`);

  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await getEditorIdentity();
  if (!before) throw new Error('Could not read the Pine Editor script title.');

  // Pine Editor script-name dropdown → "Create new" → Indicator/Strategy/Library
  const menuOpened = await evaluate(`
    (function() {
      var titleBtn = document.querySelector('${TITLE_BUTTON_SELECTOR}');
      if (!titleBtn) return false;
      titleBtn.click();
      return true;
    })()
  `);
  if (!menuOpened) throw new Error('Pine Editor script title button not found.');

  const submenuOpened = await pollUntil(() => evaluate(`
    (function() {
      var items = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < items.length; i++) {
        if (items[i].textContent.trim() !== 'Create new') continue;
        ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach(function(t) {
          items[i].dispatchEvent(new MouseEvent(t, { bubbles: true }));
        });
        return items[i].getAttribute('aria-expanded') === 'true';
      }
      return false;
    })()
  `));
  if (!submenuOpened) {
    await closeMenus();
    throw new Error('"Create new" menu not found in the Pine Editor script dropdown.');
  }

  const typeClicked = await pollUntil(() => evaluate(`
    (function() {
      var pattern = ${menuLabel.toString()};
      var items = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < items.length; i++) {
        if (pattern.test(items[i].textContent.trim())) { items[i].click(); return true; }
      }
      return false;
    })()
  `));
  if (!typeClicked) {
    await closeMenus();
    throw new Error(`"${type}" option not found under "Create new".`);
  }

  // A new script gets a fresh Monaco model; the old binding must be gone before anyone writes source.
  const after = await pollUntil(async () => {
    if (await cancelUnsavedChangesDialog()) return { blockedByUnsavedChanges: true };
    const current = await getEditorIdentity();
    const isNewUntitled = current && current.modelUri !== before.modelUri && /^untitled/i.test(current.title);
    return isNewUntitled ? current : null;
  }, 5000);

  if (after?.blockedByUnsavedChanges) {
    throw new Error(
      `"${before.title}" has unsaved changes, so TradingView asked whether to save them before creating a new script. ` +
      'Cancelled that prompt to avoid losing or saving those changes. Save or discard them first, then retry pine_new.'
    );
  }

  if (!after) {
    await closeMenus();
    const current = await getEditorIdentity();
    throw new Error(
      `Could not verify that a new ${type} script was created; the editor is still bound to "${current?.title || before.title}". ` +
      'If that script has unsaved changes, save or discard them first. Do not set source until pine_new succeeds.'
    );
  }

  return { success: true, type, action: 'new_script_created', title: after.title };
}

const OPEN_SCRIPT_DIALOG_SELECTOR = '[data-name="open-user-script-dialog"]';

async function closeOpenScriptDialog() {
  await evaluate(`
    (function() {
      var dialog = document.querySelector('${OPEN_SCRIPT_DIALOG_SELECTOR}');
      var closeBtn = dialog && dialog.querySelector('[data-qa-id="close"]');
      if (closeBtn) closeBtn.click();
    })()
  `);
}

async function findSavedScript(name) {
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
          return {name: match.scriptName || match.scriptTitle, id: match.scriptIdPart};
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function openScript({ name }) {
  const script = await findSavedScript(name);

  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await getEditorIdentity();
  if (!before) throw new Error('Could not read the Pine Editor script title.');

  if (before.title === script.name) {
    return { success: true, name: script.name, script_id: script.id, lines: before.source.split('\n').length, opened: true, already_open: true };
  }

  // Pine Editor script-name dropdown → "Open script…" → search → click the script's name
  const menuOpened = await evaluate(`
    (function() {
      var titleBtn = document.querySelector('${TITLE_BUTTON_SELECTOR}');
      if (!titleBtn) return false;
      titleBtn.click();
      return true;
    })()
  `);
  if (!menuOpened) throw new Error('Pine Editor script title button not found.');

  const dialogRequested = await pollUntil(() => evaluate(`
    (function() {
      var items = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < items.length; i++) {
        if (/^Open script/.test(items[i].textContent.trim())) { items[i].click(); return true; }
      }
      return false;
    })()
  `));
  if (!dialogRequested) {
    await closeMenus();
    throw new Error('"Open script…" not found in the Pine Editor script dropdown.');
  }

  const escapedScriptName = JSON.stringify(script.name);
  const searched = await pollUntil(() => evaluate(`
    (function() {
      var dialog = document.querySelector('${OPEN_SCRIPT_DIALOG_SELECTOR}');
      var input = dialog && dialog.querySelector('[data-qa-id="dialog-search-input"]');
      if (!input) return false;
      var setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(input, ${escapedScriptName});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `));
  if (!searched) {
    await closeOpenScriptDialog();
    throw new Error('"Open my script" dialog did not appear.');
  }

  // Only the name element is clicked — each row also has a delete button.
  const scriptClicked = await pollUntil(() => evaluate(`
    (function() {
      var dialog = document.querySelector('${OPEN_SCRIPT_DIALOG_SELECTOR}');
      if (!dialog) return false;
      var names = dialog.querySelectorAll('[data-name="open-script-dialog-item-name"]');
      for (var i = 0; i < names.length; i++) {
        if (names[i].textContent.trim() === ${escapedScriptName}) { names[i].click(); return true; }
      }
      return false;
    })()
  `));
  if (!scriptClicked) {
    await closeOpenScriptDialog();
    throw new Error(`"${script.name}" not found in the "Open my script" dialog.`);
  }

  const after = await pollUntil(async () => {
    if (await cancelUnsavedChangesDialog()) return { blockedByUnsavedChanges: true };
    const current = await getEditorIdentity();
    const isOpened = current && current.modelUri !== before.modelUri && current.title === script.name;
    return isOpened ? current : null;
  }, 8000);

  await closeOpenScriptDialog();

  if (after?.blockedByUnsavedChanges) {
    throw new Error(
      `"${before.title}" has unsaved changes, so TradingView asked whether to save them before switching. ` +
      `Cancelled that prompt to avoid losing or saving those changes. Save or discard them first, then retry pine_open.`
    );
  }

  if (!after) {
    const current = await getEditorIdentity();
    throw new Error(
      `Could not verify that "${script.name}" was opened; the editor is bound to "${current?.title || before.title}". ` +
      'Do not set source or save until pine_open succeeds.'
    );
  }

  return { success: true, name: script.name, script_id: script.id, lines: after.source.split('\n').length, opened: true };
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
