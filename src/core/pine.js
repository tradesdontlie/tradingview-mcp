/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var containers = Array.from(document.querySelectorAll('.monaco-editor.pine-editor-monaco'));
    if (containers.length === 0) return null;
    containers.sort(function(a, b) {
      var ar = a.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      var av = a.isConnected && ar.width > 0 && ar.height > 0 ? 1 : 0;
      var bv = b.isConnected && br.width > 0 && br.height > 0 ? 1 : 0;
      return bv - av;
    });

    var fallback = null;
    for (var c = 0; c < containers.length; c++) {
      var el = containers[c];
      var fiberKey = null;
      for (var i = 0; i < 20; i++) {
        if (!el) break;
        fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fiberKey) break;
        el = el.parentElement;
      }
      if (!fiberKey) continue;
      var current = el[fiberKey];
      for (var d = 0; d < 15; d++) {
        if (!current) break;
        if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
          var env = current.memoizedProps.value.monacoEnv;
          if (env.editor && typeof env.editor.getEditors === 'function') {
            var editors = env.editor.getEditors();
            for (var e = 0; e < editors.length; e++) {
              var editor = editors[e];
              var node = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
              var rect = node ? node.getBoundingClientRect() : null;
              if (node && node.isConnected && rect.width > 0 && rect.height > 0) {
                if (typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) return { editor: editor, env: env };
                if (!fallback) fallback = { editor: editor, env: env };
              }
            }
            if (!fallback && editors.length > 0) fallback = { editor: editors[0], env: env };
          }
        }
        current = current.return;
      }
    }
    return fallback;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  async function waitForEditor(attempts, delay = 100) {
    for (let i = 0; i < attempts; i++) {
      const ready = await evaluate(`(function() { var m = ${FIND_MONACO}; return m !== null; })()`);
      if (ready) return true;
      await new Promise(r => setTimeout(r, delay));
    }
    return false;
  }

  if (await waitForEditor(1, 0)) return true;

  // Prefer TradingView's internal panel API, but give the editor time to mount
  // before falling back to UI input. Some Desktop builds expose these methods
  // while silently ignoring them for the right-side Pine panel.
  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);
  if (await waitForEditor(10)) return true;

  const panelState = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var sideTitle = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      var editorContainer = Array.from(document.querySelectorAll('.monaco-editor.pine-editor-monaco')).find(visible);
      if (sideTitle || editorContainer) return { panelVisible: true, button: null };

      var buttons = Array.from(document.querySelectorAll('[aria-label="Pine"], [data-name="pine-dialog-button"]'));
      var button = buttons.find(visible);
      if (!button) return { panelVisible: false, button: null };
      var rect = button.getBoundingClientRect();
      return {
        panelVisible: false,
        button: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      };
    })()
  `);

  // If the panel is already visible, clicking its toolbar button would close it.
  // Allow a slower Monaco mount before deciding that it is unavailable.
  if (panelState?.panelVisible) return waitForEditor(40, 200);
  if (!panelState?.button) return false;

  // TradingView Desktop ignores HTMLElement.click() for this toolbar button in
  // some builds. Dispatch real CDP mouse input, matching an actual user click.
  const c = await getClient();
  const { x, y } = panelState.button;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

  return waitForEditor(50, 200);
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

  const escaped = JSON.stringify(source.replace(/\r\n/g, '\n'));
  const result = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return { success: false, error: 'Monaco editor not found' };
      var model = m.editor.getModel();
      if (!model) return { success: false, error: 'Monaco model not found' };
      var before = model.getValue();
      var beforeVersion = model.getAlternativeVersionId();
      var requestedSource = ${escaped};
      var modelEol = typeof model.getEOL === 'function' ? model.getEOL() : '\\n';
      var nextSource = modelEol === '\\n' ? requestedSource : requestedSource.replace(/\\n/g, modelEol);
      m.editor.pushUndoStop();
      var applied = m.editor.executeEdits('tradingview-mcp', [{
        range: model.getFullModelRange(),
        text: nextSource,
        forceMoveMarkers: true
      }]);
      m.editor.pushUndoStop();
      var after = model.getValue();
      var afterVersion = model.getAlternativeVersionId();
      if (typeof m.editor.focus === 'function') m.editor.focus();
      return {
        success: applied !== false && after === nextSource,
        changed: before !== after,
        before_version: beforeVersion,
        after_version: afterVersion,
        eol: modelEol === '\\r\\n' ? 'CRLF' : 'LF',
        line_count: after.split('\\n').length,
        char_count: after.length,
        error: after === nextSource ? null : 'Editor contents do not match requested source'
      };
    })()
  `);

  if (!result?.success) throw new Error(result?.error || 'Monaco executeEdits() failed.');
  return {
    success: true,
    lines_set: result.line_count,
    chars_set: result.char_count,
    changed: result.changed,
    before_version: result.before_version,
    after_version: result.after_version,
    eol: result.eol,
    method: 'monaco_executeEdits',
  };
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

async function getCurrentScriptName() {
  return evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var sideTitle = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      if (sideTitle) return (sideTitle.textContent || '').trim() || null;

      var tab = Array.from(document.querySelectorAll('button[data-qa-id="scripteditor"]')).find(visible);
      if (!tab) {
        tab = Array.from(document.querySelectorAll('button[aria-label="Close Pine Editor"]')).find(function(el) {
          return visible(el) && !el.closest('[class*="fakeTabs"]');
        });
      }
      return tab ? ((tab.textContent || '').trim() || null) : null;
    })()
  `);
}

async function openCurrentScriptMenu() {
  const result = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var alreadyOpen = Array.from(document.querySelectorAll('[role="menuitem"][aria-label="Save script"]')).find(visible);
      if (alreadyOpen) return { success: true, already_open: true };

      var sideTitle = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      if (sideTitle) {
        sideTitle.click();
        return { success: true, location: 'right', name: (sideTitle.textContent || '').trim() };
      }

      var tab = Array.from(document.querySelectorAll('button[data-qa-id="scripteditor"]')).find(visible);
      if (!tab) {
        tab = Array.from(document.querySelectorAll('button[aria-label="Close Pine Editor"]')).find(function(el) {
          return visible(el) && !el.closest('[class*="fakeTabs"]');
        });
      }
      if (!tab) return { success: false, error: 'Visible Pine Editor tab was not found' };

      // The Strategy Tester and Pine Editor menus can share the same Y coordinate.
      // Resolve the trigger from the Pine tab's own container instead of sorting all
      // context-menu buttons by vertical distance.
      var tabContainer = tab.parentElement;
      var menuButton = tabContainer && tabContainer.querySelector(
        'button[data-qa-id="tab-menu-trigger"], button[title="Open context menu"]'
      );
      if (!menuButton || !visible(menuButton)) {
        return { success: false, error: 'Pine Editor context-menu button was not found' };
      }
      menuButton.click();
      return { success: true, location: 'bottom', name: (tab.textContent || '').trim() };
    })()
  `);

  if (!result?.success) throw new Error(result?.error || 'Could not open the Pine Editor script menu.');
  return result;
}

async function submitInitialSaveDialog(name) {
  const escapedName = JSON.stringify(name || '');
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await evaluate(`
      (function() {
        function visible(el) {
          if (!el || !el.isConnected) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        var dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
        var dialog = dialogs.find(function(el) {
          var text = (el.textContent || '').trim();
          return /save script/i.test(text) && !!el.querySelector('input');
        });
        if (!dialog) return { found: false };

        var requestedName = ${escapedName};
        if (!requestedName) {
          var cancel = Array.from(dialog.querySelectorAll('button')).find(function(button) {
            return /^cancel$/i.test((button.textContent || '').trim());
          });
          if (cancel) cancel.click();
          return { found: true, submitted: false, error: 'A name is required when saving a new script' };
        }

        var input = dialog.querySelector('input');
        if (!input) return { found: true, submitted: false, error: 'Save script name input was not found' };
        input.focus();
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(input, requestedName);
        else input.value = requestedName;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        var saveButton = Array.from(dialog.querySelectorAll('button')).find(function(button) {
          return /^save$/i.test((button.textContent || '').trim());
        });
        if (!saveButton) return { found: true, submitted: false, error: 'Save dialog submit button was not found' };
        if (saveButton.disabled || saveButton.getAttribute('aria-disabled') === 'true') {
          return { found: true, submitted: false, error: 'Save dialog submit button is disabled' };
        }
        saveButton.click();
        return { found: true, submitted: true };
      })()
    `);
    if (result?.found) return result;
    await new Promise(r => setTimeout(r, 100));
  }
  return { found: false, submitted: false };
}

export async function save({ name } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const editor = await getSource();
  const currentName = await getCurrentScriptName();
  let currentSaved = null;
  if (currentName) {
    try { currentSaved = await getSavedSource({ name: currentName }); } catch { /* new/unsaved script */ }
  }

  const requestedName = (name || '').trim();
  if (currentSaved && requestedName) {
    const target = requestedName.toLowerCase();
    const aliases = [currentSaved.name, currentSaved.title].filter(Boolean).map(value => value.toLowerCase());
    if (!aliases.includes(target)) {
      throw new Error(
        `The editor is attached to saved script "${currentSaved.name}", not "${requestedName}". `
        + 'pine_save does not rename or create a copy of an existing script.'
      );
    }
  }

  const verificationName = requestedName || currentSaved?.name || (currentName || '').trim();
  if (!verificationName || (!currentSaved && !requestedName)) {
    throw new Error('A script name is required for the first save. Pass name explicitly to pine_save.');
  }

  await openCurrentScriptMenu();
  await new Promise(r => setTimeout(r, 250));

  const saveAction = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var items = Array.from(document.querySelectorAll('[role="menuitem"][aria-label="Save script"]')).filter(visible);
      if (items.length === 0) {
        items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(function(el) {
          return visible(el) && /^save script(?:\s|$)/i.test((el.textContent || '').trim());
        });
      }
      if (items.length === 0) return { success: false, error: 'Save script menu item was not found' };
      var item = items[0];
      var disabled = item.getAttribute('aria-disabled') === 'true'
        || item.hasAttribute('disabled')
        || item.getAttribute('data-disabled') === 'true';
      if (disabled) return { success: false, disabled: true, error: 'Save script menu item is disabled' };
      item.click();
      return { success: true, disabled: false };
    })()
  `);

  if (!saveAction?.success) {
    if (saveAction?.disabled) {
      const saved = await getSavedSource({ name: verificationName });
      if (saved.source.replace(/\r\n/g, '\n') === editor.source.replace(/\r\n/g, '\n')) {
        return {
          success: true,
          action: 'already_persisted',
          name: saved.name,
          script_id: saved.script_id,
          version: saved.version,
          verified: true,
        };
      }
      throw new Error(`Save script is disabled and the saved server source for "${verificationName}" does not match the editor. The editor change was not registered as dirty.`);
    }
    throw new Error(saveAction?.error || 'Could not activate Save script.');
  }

  const dialog = await submitInitialSaveDialog(requestedName);
  if (dialog.found && !dialog.submitted) throw new Error(dialog.error || 'Could not submit the initial Save script dialog.');

  const deadline = Date.now() + 10000;
  let lastSaved = null;
  let lastError = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    try {
      lastSaved = await getSavedSource({ name: verificationName });
      if (lastSaved.source.replace(/\r\n/g, '\n') === editor.source.replace(/\r\n/g, '\n')) {
        return {
          success: true,
          action: dialog.found ? 'created_and_saved_via_dialog' : 'saved_via_script_menu',
          name: lastSaved.name,
          script_id: lastSaved.script_id,
          version: lastSaved.version,
          modified: lastSaved.modified,
          verified: true,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError?.message
    ? ` Last verification error: ${lastError.message}`
    : lastSaved
      ? ' The server still returns different source code.'
      : '';
  throw new Error(`TradingView did not persist the current editor source for "${verificationName}" within 10 seconds.${detail}`);
}

export async function getSavedSource({ name }) {
  if (!name || !name.trim()) throw new Error('Script name is required. Spaces and full-width parentheses are supported.');
  const escapedName = JSON.stringify(name.trim().toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      function responseJson(response, label) {
        if (!response.ok) throw new Error(label + ' returned HTTP ' + response.status);
        return response.json();
      }
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return responseJson(r, 'Script list'); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return { error: 'pine-facade returned unexpected script-list data' };
          var exact = scripts.filter(function(script) {
            var scriptName = (script.scriptName || '').toLowerCase();
            var scriptTitle = (script.scriptTitle || '').toLowerCase();
            return scriptName === target || scriptTitle === target;
          });
          var matches = exact.length > 0 ? exact : scripts.filter(function(script) {
            var scriptName = (script.scriptName || '').toLowerCase();
            var scriptTitle = (script.scriptTitle || '').toLowerCase();
            return scriptName.indexOf(target) !== -1 || scriptTitle.indexOf(target) !== -1;
          });
          if (matches.length === 0) return { error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.' };
          if (matches.length > 1 && exact.length === 0) {
            return { error: 'Script name "' + target + '" is ambiguous. Pass the full exact name.' };
          }
          var match = matches[0];
          var id = match.scriptIdPart;
          var version = match.version || 1;
          if (!id) return { error: 'Matched script has no scriptIdPart' };
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + encodeURIComponent(id) + '/' + encodeURIComponent(version), { credentials: 'include' })
            .then(function(r2) { return responseJson(r2, 'Script source'); })
            .then(function(data) {
              var source = typeof data.source === 'string' ? data.source : '';
              if (!source) return { error: 'Script source is empty', name: match.scriptName || match.scriptTitle };
              return {
                success: true,
                name: match.scriptName || match.scriptTitle || 'Untitled',
                title: match.scriptTitle || null,
                id: id,
                version: version,
                modified: match.modified || null,
                source: source
              };
            });
        })
        .catch(function(error) { return { error: error.message }; });
    })()
  `);

  if (result?.error) throw new Error(result.error);
  if (!result?.success || typeof result.source !== 'string') throw new Error('pine-facade returned an invalid saved-source response.');
  return {
    success: true,
    name: result.name,
    title: result.title,
    script_id: result.id,
    version: result.version,
    modified: result.modified,
    source: result.source,
    line_count: result.source.split('\n').length,
    char_count: result.source.length,
    origin: 'pine_facade',
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

async function dismissOpenMenu() {
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

async function ensureSidePineEditorForCreate() {
  const initial = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var title = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      return { side_open: !!title };
    })()
  `);
  if (initial?.side_open) return { moved: false };

  await openCurrentScriptMenu();
  await new Promise(r => setTimeout(r, 200));
  const moved = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(function(el) {
        return visible(el) && /^move script to right$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim());
      });
      if (!item) return { success: false, error: 'Move script to right menu item was not found' };
      item.click();
      return { success: true };
    })()
  `);
  if (!moved?.success) throw new Error(moved?.error || 'Could not move Pine Editor to the side panel.');

  let pineButtonClicked = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    const state = await evaluate(`
      (function() {
        function visible(el) {
          if (!el || !el.isConnected) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        var title = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
        if (title) return { ready: true };
        var pineButton = Array.from(document.querySelectorAll('button[data-name="pine-dialog-button"], button[aria-label="Pine"]')).find(visible);
        return { ready: false, can_open: !!pineButton };
      })()
    `);
    if (state?.ready) return { moved: true };
    if (!pineButtonClicked && state?.can_open) {
      await evaluate(`
        (function() {
          function visible(el) {
            if (!el || !el.isConnected) return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
          var button = Array.from(document.querySelectorAll('button[data-name="pine-dialog-button"], button[aria-label="Pine"]')).find(visible);
          if (button) button.click();
        })()
      `);
      pineButtonClicked = true;
    }
  }
  throw new Error('Pine Editor side panel did not become available.');
}

async function restorePineEditorToBottom() {
  const opened = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var title = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      if (!title) return { success: false };
      if (title.getAttribute('aria-expanded') !== 'true') title.click();
      return { success: true };
    })()
  `);
  if (!opened?.success) return false;

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    const result = await evaluate(`
      (function() {
        function visible(el) {
          if (!el || !el.isConnected) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        var item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(function(el) {
          return visible(el) && /^move script to bottom$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim());
        });
        if (!item) return { found: false };
        item.click();
        return { found: true };
      })()
    `);
    if (result?.found) {
      // A synthetic click only proves that the menu item received the event. Wait
      // for TradingView to remount the editor in the bottom panel before claiming
      // success; some layouts currently ignore the move command.
      for (let verifyAttempt = 0; verifyAttempt < 30; verifyAttempt++) {
        await new Promise(r => setTimeout(r, 100));
        const state = await evaluate(`
          (function() {
            function visible(el) {
              if (!el || !el.isConnected) return false;
              var rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }
            var sideTitle = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
            var bottomTab = Array.from(document.querySelectorAll('button[data-qa-id="scripteditor"]')).find(visible);
            return {
              restored: !!bottomTab || !sideTitle,
              bottom_tab_visible: !!bottomTab,
              side_title_visible: !!sideTitle
            };
          })()
        `);
        if (state?.restored) return true;
      }
      return false;
    }
  }
  return false;
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const labels = { indicator: 'Indicator', strategy: 'Strategy', library: 'Library' };
  const declarations = { indicator: /\bindicator\s*\(/, strategy: /\bstrategy\s*\(/, library: /\blibrary\s*\(/ };
  const label = labels[type];
  if (!label) throw new Error(`Unsupported Pine script type: ${type}`);

  const currentSource = await getSource();
  const previousName = await getCurrentScriptName();

  // Never destroy meaningful unsaved user content while establishing a new
  // script identity. TradingView marks a blank Untitled buffer as dirty too;
  // replacing that empty recovery buffer is safe and must remain possible.
  await openCurrentScriptMenu();
  await new Promise(r => setTimeout(r, 200));
  const dirtyState = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var saveItem = Array.from(document.querySelectorAll('[role="menuitem"][aria-label="Save script"]')).find(visible);
      if (!saveItem) return { known: false };
      var disabled = saveItem.getAttribute('aria-disabled') === 'true'
        || saveItem.hasAttribute('disabled')
        || saveItem.getAttribute('data-disabled') === 'true';
      return { known: true, dirty: !disabled };
    })()
  `);
  await dismissOpenMenu();
  if (dirtyState?.known && dirtyState.dirty && currentSource.source.trim() !== '') {
    throw new Error('The current Pine editor has unsaved changes. Save them before creating a new script.');
  }

  const placement = await ensureSidePineEditorForCreate();

  const titleOpened = await evaluate(`
    (function() {
      function visible(el) {
        if (!el || !el.isConnected) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      var title = Array.from(document.querySelectorAll('[data-qa-id="pine-script-title-button"]')).find(visible);
      if (!title) return { success: false, error: 'Pine script title button was not found' };
      if (title.getAttribute('aria-expanded') !== 'true') title.click();
      return { success: true };
    })()
  `);
  if (!titleOpened?.success) throw new Error(titleOpened?.error || 'Could not open the Pine script menu.');

  let typeClicked = false;
  for (let attempt = 0; attempt < 25 && !typeClicked; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    const result = await evaluate(`
      (function() {
        function visible(el) {
          if (!el || !el.isConnected) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        var createItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(function(el) {
          return visible(el) && /^create new$/i.test((el.textContent || '').trim());
        });
        if (!createItem) return { ready: false, stage: 'create_new_missing' };
        ['pointerenter', 'mouseenter', 'mouseover'].forEach(function(eventName) {
          createItem.dispatchEvent(new MouseEvent(eventName, { bubbles: true, view: window }));
        });
        var typeItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(function(el) {
          return visible(el) && (el.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)};
        });
        if (!typeItem) return { ready: false, stage: 'type_submenu_missing' };
        typeItem.click();
        return { ready: true };
      })()
    `);
    typeClicked = !!result?.ready;
  }
  if (!typeClicked) throw new Error(`Could not activate Create new → ${label}.`);

  let source = null;
  let currentName = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const current = await getSource();
      if (declarations[type].test(current.source)) {
        source = current;
        currentName = await getCurrentScriptName();
        break;
      }
    } catch { /* editor is remounting */ }
  }
  if (!source) throw new Error(`TradingView did not create a new ${type} editor.`);

  let restoredToBottom = null;
  if (placement.moved) restoredToBottom = await restorePineEditorToBottom();

  return {
    success: true,
    type,
    action: 'new_tradingview_script_created',
    identity_created: true,
    previous_name: previousName,
    name: currentName,
    line_count: source.line_count,
    changed: true,
    restored_to_bottom: restoredToBottom,
    warning: 'The new script is not persisted until pine_save is called with a name.',
  };
}

export async function openScript({ name }) {
  const saved = await getSavedSource({ name });
  const set = await setSource({ source: saved.source });
  return {
    success: true,
    name: saved.name,
    script_id: saved.script_id,
    version: saved.version,
    lines: saved.line_count,
    origin: saved.origin,
    injected: true,
    destructive: true,
    changed: set.changed,
    warning: 'pine_open injects saved source into the current editor; it does not switch script identity. Do not use it to verify a save.',
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
