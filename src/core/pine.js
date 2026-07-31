/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { manageIndicator, getState as chartGetState } from './chart.js';
import { getPineTables } from './data.js';

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

/**
 * Save Pine Script source directly to a saved script via TradingView's REST
 * API — no Monaco, no editor pane, no DOM activation, no polling.
 *
 * T74 (2026-04-26): replaces the Monaco-based `setSource + save` pair.  The
 * old flow required Monaco to be mounted, which TV lazy-mounts only when
 * the Pine Editor pane is visibly expanded — different layouts (bottom-bar
 * vs side-dock) had different mount behaviors and the discovery was slow
 * (≤10s polling).  This REST call is sub-second, layout-agnostic, and
 * survives TV UI updates.
 *
 * Wire format (captured live via fetch interceptor on TV Desktop 3.1.0.7818
 * by manually pressing Ctrl+S in the side-docked Pine Editor):
 *
 *   POST https://pine-facade.tradingview.com/pine-facade/save/next/USER;{id}
 *        ?allow_create_new=false&name={url-encoded-name}
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: source=<...>
 *   Response: {"success":true, "result":{"IL":"<encrypted-blob>"}}
 *
 * The `IL` field is TradingView's signed/encrypted form of the source
 * (used by chart-side verification).  We don't need to inspect it.
 *
 * Caller passes either `id` (preferred — from `pine_list_scripts`) or
 * `name` (looked up via the same pine-facade list endpoint that
 * `openScript` already uses).  After save, calling `chart_manage_indicator`
 * with remove + re-add will pick up the new cloud version on the chart.
 */
export async function saveSource({ id, name, source }) {
  if (!source || typeof source !== 'string') {
    throw new Error('saveSource requires a non-empty `source` string.');
  }
  if (!id && !name) {
    throw new Error('saveSource requires either `id` or `name`.');
  }

  // All fetches must run in the TV page context — pine-facade requires the
  // user's session cookie, which only exists in the browser, not in this
  // Node process.  We mirror the pattern used by openScript / listScripts.
  // Note: scriptIdPart from pine-facade already contains the "USER;" prefix,
  // so the save URL takes the id as-is (no extra "USER;" concatenation).
  //
  // T74 follow-up (2026-04-26): the `name=` URL param on save/next is NOT
  // cosmetic — pine-facade rewrites the cloud script's `scriptName` field
  // with whatever is sent.  Earlier versions of this code defaulted the name
  // to the script id when the caller passed id-only, which silently corrupted
  // the script's display name to a "USER;..." string.  Fix: if no name is
  // supplied, look up the current `scriptName` from the pine-facade list and
  // pass that through.  Idempotent — preserves names by default.
  const escId = JSON.stringify(id || '');
  const escName = JSON.stringify(name || '');
  const escSource = JSON.stringify(source);

  const result = await evaluateAsync(`
    (function() {
      var providedId = ${escId};
      var providedName = ${escName};
      var src = ${escSource};

      function doSave(scriptId, displayName) {
        // displayName is REQUIRED here — caller branches must resolve it
        // (either from caller-supplied name or from pine-facade list lookup)
        // before invoking doSave.  Falling back to scriptId would corrupt
        // the cloud's scriptName field; better to fail loudly.
        if (!displayName) {
          return Promise.resolve({ error: 'doSave called without resolved displayName — internal bug' });
        }
        var url = 'https://pine-facade.tradingview.com/pine-facade/save/next/' +
          encodeURIComponent(scriptId) +
          '?allow_create_new=false&name=' + encodeURIComponent(displayName);
        var body = new URLSearchParams();
        body.append('source', src);
        return fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://www.tradingview.com/'
          },
          body: body
        }).then(function(r) {
          return r.text().then(function(text) {
            if (!r.ok) return { error: 'pine-facade save returned ' + r.status + ': ' + text.substring(0, 300) };
            try {
              var data = JSON.parse(text);
              if (data && data.success === true) {
                return { success: true, id: scriptId, name: displayName, has_il_blob: !!(data.result && data.result.IL) };
              }
              return { error: 'pine-facade save responded success=false: ' + text.substring(0, 300) };
            } catch (parseErr) {
              return { error: 'pine-facade save returned non-JSON: ' + text.substring(0, 300) };
            }
          });
        });
      }

      function fetchList() {
        return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
          .then(function(r) {
            if (!r.ok) throw new Error('pine-facade list returned ' + r.status);
            return r.json();
          })
          .then(function(scripts) {
            if (!Array.isArray(scripts)) throw new Error('pine-facade list returned unexpected data');
            return scripts;
          });
      }

      if (providedId) {
        // Caller-supplied name wins (explicit rename intent).  Otherwise
        // look up the current scriptName so the save preserves it.
        if (providedName) {
          return doSave(providedId, providedName);
        }
        return fetchList()
          .then(function(scripts) {
            var match = null;
            for (var i = 0; i < scripts.length; i++) {
              if (scripts[i].scriptIdPart === providedId) { match = scripts[i]; break; }
            }
            var resolved = match && match.scriptName;
            if (!resolved) {
              return { error: 'Script id "' + providedId + '" not found in pine-facade list — cannot resolve scriptName for save (would corrupt cloud name).' };
            }
            return doSave(providedId, resolved);
          })
          .catch(function(e) { return { error: e.message }; });
      }

      var target = providedName.toLowerCase();
      return fetchList()
        .then(function(scripts) {
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
          if (!match) return { error: 'Script "' + providedName + '" not found. Use pine_list_scripts to see available scripts.' };
          // Use the cloud's current scriptName — never the provided lookup
          // string — so a fuzzy-match save doesn't accidentally rename.
          return doSave(match.scriptIdPart, match.scriptName || match.scriptTitle);
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  if (!result || result.error) {
    throw new Error((result && result.error) || 'pine_save_source returned no result');
  }

  return {
    success: true,
    id: result.id,
    name: result.name,
    source_lines: source.split('\n').length,
    source_chars: source.length,
    has_il_blob: !!result.has_il_blob,
    note: 'Saved to TradingView cloud via pine-facade REST. Run chart_manage_indicator(remove + re-add) on the chart to pick up the new version.',
    raw_url: 'pine-facade/save/next',
  };
}

/**
 * Read Pine Script source directly from a saved script via REST — no Monaco
 * required.  Uses the same pine-facade endpoints `openScript` already
 * relies on internally.
 *
 * T74 (2026-04-26): companion to `saveSource`, replacing the Monaco-based
 * `getSource()` for the round-trip case.  Caller passes `id` (preferred)
 * or `name`.
 */
export async function getSourceByREST({ id, name, version }) {
  if (!id && !name) {
    throw new Error('getSourceByREST requires either `id` or `name`.');
  }

  // All fetches must run in the TV page context — same reason as saveSource.
  const escId = JSON.stringify(id || '');
  const escName = JSON.stringify((name || '').toLowerCase());
  const escVersion = JSON.stringify(version != null ? String(version) : '');

  const result = await evaluateAsync(`
    (function() {
      var providedId = ${escId};
      var targetName = ${escName};
      var providedVersion = ${escVersion};

      function fetchSource(scriptId, scriptVer, displayName) {
        var ver = scriptVer || '1';
        var url = 'https://pine-facade.tradingview.com/pine-facade/get/' +
          encodeURIComponent(scriptId) + '/' + encodeURIComponent(ver);
        return fetch(url, { credentials: 'include' })
          .then(function(r) {
            if (!r.ok) return { error: 'pine-facade get returned ' + r.status };
            return r.json();
          })
          .then(function(data) {
            if (data && data.error) return data;
            var source = (data && data.source) || '';
            if (!source) return { error: 'Script source returned empty.' };
            return { success: true, id: scriptId, name: displayName, version: ver, source: source };
          });
      }

      if (providedId && providedVersion) {
        return fetchSource(providedId, providedVersion, providedId);
      }

      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) {
          if (!r.ok) return { error: 'pine-facade list returned ' + r.status };
          return r.json();
        })
        .then(function(scripts) {
          if (scripts && scripts.error) return scripts;
          if (!Array.isArray(scripts)) return { error: 'pine-facade list returned unexpected data' };
          var match = null;
          if (providedId) {
            for (var i = 0; i < scripts.length; i++) {
              if (scripts[i].scriptIdPart === providedId) { match = scripts[i]; break; }
            }
            if (!match) return { error: 'Script with id "' + providedId + '" not found in pine-facade list.' };
          } else {
            for (var j = 0; j < scripts.length; j++) {
              var sn = (scripts[j].scriptName || '').toLowerCase();
              var st = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn === targetName || st === targetName) { match = scripts[j]; break; }
            }
            if (!match) {
              for (var k = 0; k < scripts.length; k++) {
                var sn2 = (scripts[k].scriptName || '').toLowerCase();
                var st2 = (scripts[k].scriptTitle || '').toLowerCase();
                if (sn2.indexOf(targetName) !== -1 || st2.indexOf(targetName) !== -1) { match = scripts[k]; break; }
              }
            }
            if (!match) return { error: 'Script not found. Use pine_list_scripts to see available scripts.' };
          }
          var resolvedVer = providedVersion || match.version || '1';
          return fetchSource(match.scriptIdPart, resolvedVer, match.scriptName || match.scriptTitle);
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  if (!result || result.error) {
    throw new Error((result && result.error) || 'pine_get_source_rest returned no result');
  }

  return {
    success: true,
    id: result.id,
    name: result.name,
    version: result.version,
    source: result.source,
    line_count: result.source.split('\n').length,
    char_count: result.source.length,
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
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
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

/**
 * T107 — Cherry-pick from upstream PR #152 commit `63fe862` by `taiwor88`.
 * (Original location in PR: src/core/alerts.js. Moved here — pine.js is the
 *  semantically correct home; the alert grouping in the upstream PR is
 *  incidental to the PR bundling 8 unrelated fixes.)
 *
 * Refresh the TV chart-side saved-scripts catalog.
 *
 * Problem: `pine_save_source` and other pine-facade REST mutations write
 * server-side, but the chart's Indicators dialog holds a one-shot Promise
 * in `TradingViewApi._studyMarket._dialog._initIndicatorsPromises.userScriptsPromise`
 * that was settled at chart-page load time. Subsequent dialog opens read
 * from the resolved (stale) Promise; the dialog does not re-hit pine-facade
 * on open (verified empirically: opening the dialog and clicking the
 * "My scripts" sidebar produces ZERO pine-facade fetches).
 *
 * Findings from PR #152 investigation:
 *   - `window.TradingViewApi.resetCache()` and `getStudiesList()` exist on
 *     the prototype but are `$t()` stubs that throw "not implemented" —
 *     dead ends.
 *   - `_studyMarket._dialog.resetAllStudies()` (alias `_studyMarket.resetAllPages()`)
 *     calls the dialog's `_init()` which clears `_studies` and re-runs the
 *     init promises — but those promises are CACHED, so the re-init repopulates
 *     `_studies` from the SAME stale resolved Promise. Confirmed: calling
 *     resetAllStudies() produced zero pine-facade fetches and the cache
 *     stayed at the pre-mutation contents.
 *   - The dialog method `_updateUserStudies()` awaits
 *     `_initIndicatorsPromises.userScriptsPromise`, runs
 *     `_preparePineUserStudies()` on the result, and replaces
 *     `_studies['Script$USER']` from the transformed list. If we swap
 *     `userScriptsPromise` to a FRESH fetch before calling
 *     `_updateUserStudies()`, the cache is rebuilt from the live REST list.
 *
 * Implementation:
 *   1. Overwrite `_initIndicatorsPromises.userScriptsPromise` with a new
 *      Promise resolving to `fetch('/pine-facade/list/?filter=saved').json()`.
 *   2. Call `_updateUserStudies()` and await its completion.
 *   3. Return the updated cache count so callers can verify.
 *
 * No page reload, no chart re-render, no visible UI flash. The next
 * Indicators dialog open sees fresh data.
 *
 * Verified live by PR #152 author: created 5 saved scripts via REST; the
 * dialog's pre-refresh cache showed 2 of 5 (the two created BEFORE the
 * page last loaded). After `refreshCatalog()`: cache showed 5/5 including
 * the 3 created post-load.
 *
 * Our T107 probe (2026-05-13) verified every required path exists on
 * TV Desktop 3.0.0 MSIX (HWM-D chart):
 *   - userScriptsPromise: present (is a Promise)
 *   - _updateUserStudies: present (function)
 *   - _studies['Script$USER']: 6 entries at probe time
 */
// Lazy-init the Indicators dialog so `refreshCatalog` has state to refresh.
//
// TV builds `_studyMarket._dialog._initIndicatorsPromises` on the first dialog
// OPEN. After an app restart it does not exist, so `refreshCatalog` used to
// throw "dialog state not initialized" — which sent the descriptor lookup down
// its bare-title fallback, which `createStudy` rejects for user scripts. On the
// 2026-07-28 Patterns ship that chain removed the study and then failed every
// add retry, leaving the chart with NO indicator: strictly worse than the stale
// version it was replacing. The documented manual recovery was "click the
// indicators button, press Escape, retry" — so do exactly that, in code.
async function primeIndicatorsDialog() {
  const clicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="open-indicators-dialog"]');
      if (!btn) return { ok: false, reason: 'indicators button not found in DOM' };
      btn.click();
      return { ok: true };
    })()
  `);
  if (!clicked?.ok) return { primed: false, reason: clicked?.reason || 'click failed' };

  // Wait for TV to construct the dialog state, then dismiss it. Escape goes via
  // CDP rather than a synthetic KeyboardEvent — React's handler ignores
  // untrusted events (same reason watchlist.js dispatches it this way).
  let primed = false;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    const probe = await evaluate(`
      (function() {
        var d = window.TradingViewApi && window.TradingViewApi._studyMarket && window.TradingViewApi._studyMarket._dialog;
        return { ready: !!(d && d._initIndicatorsPromises && d._updateUserStudies) };
      })()
    `);
    if (probe?.ready) { primed = true; break; }
  }
  try {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  } catch (_) { /* dialog may already be closed; never fatal */ }
  return { primed, reason: primed ? null : 'dialog state did not appear within 3s' };
}

export async function refreshCatalog({ auto_prime = true } = {}) {
  let primed = null;
  let result = await _refreshCatalogOnce();
  if (result?.error && /dialog state not initialized/i.test(result.error) && auto_prime) {
    primed = await primeIndicatorsDialog();
    if (primed.primed) result = await _refreshCatalogOnce();
  }
  if (result && result.error) throw new Error(result.error + (primed && !primed.primed ? ` (auto-prime failed: ${primed.reason})` : ''));
  return {
    success: true,
    cache_before_count: result?.before ?? null,
    cache_after_count: result?.after ?? null,
    delta: (result?.after ?? 0) - (result?.before ?? 0),
    scripts: result?.scripts || [],
    ...(primed && { auto_primed: primed.primed }),
    source: 'pine_facade_rest',
    note: 'TV chart-side Indicators-dialog catalog refreshed. New scripts are now visible in the dialog without page reload.',
  };
}

async function _refreshCatalogOnce() {
  return evaluateAsync(`
    (function() {
      try {
        var market = window.TradingViewApi && window.TradingViewApi._studyMarket;
        if (!market) return { error: 'TradingViewApi._studyMarket not initialized' };
        var dlg = market._dialog;
        if (!dlg || !dlg._initIndicatorsPromises) {
          return { error: 'Indicators dialog state not initialized — open the dialog once before refreshing (TV lazy-initializes it).' };
        }
        var before = (dlg._studies && dlg._studies['Script$USER']) ? dlg._studies['Script$USER'].length : 0;
        // Replace the cached promise with a fresh fetch
        dlg._initIndicatorsPromises.userScriptsPromise = fetch(
          'https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',
          { credentials: 'include' }
        ).then(function(r) { return r.json(); });
        // _updateUserStudies awaits the (new) promise, transforms, and
        // replaces _studies['Script$USER']. Return its promise so awaitPromise
        // resolves only after the cache is rebuilt.
        return dlg._updateUserStudies().then(function() {
          var after = (dlg._studies && dlg._studies['Script$USER']) ? dlg._studies['Script$USER'].length : 0;
          var scripts = (dlg._studies['Script$USER'] || []).map(function(s) {
            return { id: s.id, title: s.title };
          });
          return { ok: true, before: before, after: after, scripts: scripts };
        }).catch(function(e) { return { error: '_updateUserStudies failed: ' + (e && e.message || String(e)) }; });
      } catch(e) { return { error: 'refreshCatalog threw: ' + e.message }; }
    })()
  `);
}

// ── T184 — layout save ──
//
// A Pine ship is NOT durable until the chart LAYOUT is saved. `withSave` updates
// the cloud script and swaps the LIVE study instance, but the layout's saved
// copy still references the previously-compiled version. Any page reload, layout
// re-sync or app restart re-instantiates from that copy and silently reverts the
// chart — under a FRESH entity id, so it does not read as a revert. Measured
// 2026-07-28: verification passed, the panel read the new version, and minutes
// later the chart was back on the old one.
//
// This matters because downstream automation restarts the app unattended and
// then reads the panel — so an un-saved ship means scheduled work can be scoring
// against an old indicator with nothing anywhere saying so.
//
// Do NOT substitute a blind Ctrl+S: TradingView's save target is sticky to
// whatever last had focus, so with the Pine Editor focused it saves the SCRIPT,
// not the layout (the same sticky-target hazard that deprecated `pine_save`).
export async function saveLayout({ timeout_ms = 8000 } = {}) {
  const t0 = Date.now();
  const before = await evaluate(`
    (function() {
      try {
        var cw = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
        if (!cw) return { error: 'chart widget collection not available' };
        if (!cw._saveChartService || typeof cw._saveChartService.saveChartSilently !== 'function')
          return { error: '_saveChartService.saveChartSilently not available' };
        var has = cw._hasChanges && typeof cw._hasChanges.value === 'function' ? cw._hasChanges.value() : null;
        cw._saveChartService.saveChartSilently();
        return { ok: true, has_changes_before: has };
      } catch (e) { return { error: 'saveLayout threw: ' + e.message }; }
    })()
  `);
  if (before?.error) throw new Error(before.error);

  // `_hasChanges` going true → false is the assertion that the save actually
  // flushed. Auto-save being enabled is NOT sufficient — it was on, and had not
  // flushed, on the ship that motivated this.
  let after = before.has_changes_before;
  while (Date.now() - t0 < timeout_ms) {
    await new Promise(r => setTimeout(r, 250));
    const probe = await evaluate(`
      (function() {
        var cw = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
        var h = cw && cw._hasChanges && typeof cw._hasChanges.value === 'function' ? cw._hasChanges.value() : null;
        return { has_changes: h };
      })()
    `);
    after = probe?.has_changes ?? after;
    if (after === false) break;
  }

  return {
    success: after === false,
    has_changes_before: before.has_changes_before,
    has_changes_after: after,
    ms: Date.now() - t0,
    ...(after !== false && {
      error: `_hasChanges is still ${String(after)} after ${Date.now() - t0}ms — the layout save did not flush. ` +
             'The chart will revert to the previously-saved study version on the next restart.',
    }),
  };
}

// Snapshot a study's input values. `remove + add` recreates the study at its
// DECLARED DEFAULTS, so any input the operator tuned by hand is silently lost —
// and saving the layout afterwards makes that loss permanent. Comparing this
// snapshot before and after the reload turns an invisible loss into a reported
// one, and gates the layout save on it.
// Only `in_<N>` are operator-facing. A Pine study's input list ALSO carries
// TradingView internals — `text` (the ~6 KB encrypted compiled source), `pineId`,
// `pineVersion`, `pineFeatures` — every one of which changes on a normal, correct
// ship. Diffing them would flag every single save as a settings loss and refuse
// every layout save, i.e. it would break the exact thing this is here to protect.
const USER_INPUT_RE = /^in_\d+$/;

async function studyInputs(entityId) {
  const res = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var study = chart.getStudyById(${JSON.stringify(entityId)});
        if (!study || typeof study.getInputValues !== 'function') return { error: 'inputs unsupported for this study' };
        var out = {};
        var vals = study.getInputValues() || [];
        for (var i = 0; i < vals.length; i++) out[vals[i].id] = vals[i].value;
        return { ok: true, inputs: out, count: vals.length };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()
  `);
  if (!res?.ok) return null;
  const user = {};
  for (const [k, v] of Object.entries(res.inputs || {})) if (USER_INPUT_RE.test(k)) user[k] = v;
  return { inputs: user, count: Object.keys(user).length };
}

// Re-apply a snapshot onto the freshly-added study, so an operator's tuned
// inputs survive the reload instead of merely being reported as lost. Guarded on
// the input COUNT matching: the ids are positional, so restoring across a
// version that added or removed an input would write values into the WRONG
// inputs — worse than the reset it is undoing. On a count change we restore
// nothing and let the diff refuse the layout save.
async function restoreStudyInputs(entityId, snapshot) {
  const current = await studyInputs(entityId);
  if (!current) return { restored: null, reason: 'could not read the new study inputs' };
  if (current.count !== snapshot.count) {
    return { restored: null, count_before: snapshot.count, count_after: current.count,
             reason: 'input count changed — positional ids no longer line up, restore refused' };
  }
  const wanted = {};
  for (const [k, v] of Object.entries(snapshot.inputs)) {
    if (JSON.stringify(current.inputs[k]) !== JSON.stringify(v)) wanted[k] = v;
  }
  if (!Object.keys(wanted).length) return { restored: [], reason: 'already at the snapshot values' };
  await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById(${JSON.stringify(entityId)});
      if (!study || typeof study.getInputValues !== 'function') return { error: 'inputs unsupported' };
      var vals = study.getInputValues();
      var want = ${JSON.stringify(wanted)};
      for (var i = 0; i < vals.length; i++) if (want.hasOwnProperty(vals[i].id)) vals[i].value = want[vals[i].id];
      study.setInputValues(vals);
      return { ok: true };
    })()
  `);
  return { restored: Object.keys(wanted), values: wanted };
}

// NB: Pine input ids are POSITIONAL (`in_0`, `in_1`, …), so a version that
// inserts or removes an input shifts the meaning of every id after it and this
// diff will report spurious changes. That is deliberately left noisy rather than
// silenced: the consequence is a refused layout save with the deltas printed,
// which a human resolves in seconds — whereas the failure it guards against
// (silently persisting a reset of tuned inputs) is unrecoverable.
function diffInputs(before, after) {
  if (!before || !after) return null;
  const changed = [];
  for (const k of Object.keys(before.inputs || {})) {
    if (!(k in (after.inputs || {}))) continue;          // input removed by the new version — not a loss
    if (JSON.stringify(before.inputs[k]) !== JSON.stringify(after.inputs[k])) {
      changed.push({ id: k, was: before.inputs[k], now: after.inputs[k] });
    }
  }
  return {
    count_before: before.count,
    count_after: after.count,
    changed,
    ...(before.count !== after.count && {
      note: 'the input COUNT changed, so the positional in_<N> ids no longer line up — ' +
            'treat any reported change as unreliable and verify by eye',
    }),
  };
}

// ── T110 — withPineSave orchestrator ──
// Composes pine_check + pine_save_source + pine_refresh_catalog +
// chart_manage_indicator(remove + add) + verify into a single MCP call.
// Built on top of T107 (cache-bust) + T108 (descriptor lookup + Escape recovery).
// Replaces the 4-5 manual MCP calls per save cycle with 1; built-in retry on
// cache miss / verification failure.
//
// Signature:
//   { script_id_or_name, source, expected_version?, indicator_display_name?,
//     max_retries=2, save_layout=true, force_layout_save=false }
// Response:
//   { success, steps: [{name, success, ms, detail}], final_verification,
//     total_ms, source_lines, has_il_blob, layout_saved, settings_delta }
//
// ── T184 hardening (2026-07-31), three changes, each from an observed failure ──
//
//  1. **The reload is ADD-then-REMOVE.** It used to remove every matching study
//     and then add the new one, which is not atomic: on the 2026-07-28 Patterns
//     ship the remove succeeded and every add retry failed, leaving the chart
//     with NO indicator — strictly worse than the stale version it was
//     replacing. Adding first means the worst case is "old version still on the
//     chart", which the caller can see and act on.
//
//  2. **A version mismatch is NOT retried.** Retries exist for a cache miss,
//     where a second attempt genuinely helps. A wrong `expected_version` cannot
//     be fixed by retrying — the string is wrong at the source — so retrying it
//     only churns the chart through more non-atomic mutations. That is exactly
//     what turned a half-bumped version into a two-minute hang on 2026-07-31.
//     Distinguished terminal status: `failed_version_mismatch`.
//
//  3. **The layout is saved, and gated on a settings-loss check.** See
//     `saveLayout` above for why the ship is not durable without it. `remove +
//     add` recreates the study at its declared defaults, so the inputs are
//     snapshotted before the reload and compared after; if anything the operator
//     had tuned was reset, they are RESTORED where that is safe (`restore_settings`,
//     default true) and the layout save is REFUSED on anything still lost
//     (persisting it would make the loss permanent) unless `force_layout_save`.

function _stepTimer() {
  const t = Date.now();
  return () => Date.now() - t;
}

export async function withSave({ script_id_or_name, source, expected_version, indicator_display_name,
                                 max_retries = 2, save_layout = true, force_layout_save = false,
                                 restore_settings = true } = {}) {
  if (!script_id_or_name) throw new Error('script_id_or_name required');
  if (!source) throw new Error('source required');
  const t0 = Date.now();
  const steps = [];
  const recordStep = (name, success, detail, ms) => steps.push({ name, success, ms, detail });

  // (a) pine_check — compile via REST
  let stepMs = _stepTimer();
  let checkRes;
  try {
    checkRes = await check({ source });
    const errorCount = checkRes?.error_count ?? checkRes?.errors?.length ?? 0;
    recordStep('pine_check', !!checkRes?.success && errorCount === 0, {
      errors: errorCount,
      warnings: checkRes?.warning_count ?? checkRes?.warnings?.length ?? null,
    }, stepMs());
    if (!checkRes?.success || errorCount > 0) {
      return {
        success: false,
        steps,
        final_verification: 'failed_compile',
        total_ms: Date.now() - t0,
        source_lines: source.split('\n').length,
        has_il_blob: false,
        error: 'pine_check reported compile errors',
      };
    }
  } catch (err) {
    recordStep('pine_check', false, { error: err.message }, stepMs());
    return { success: false, steps, final_verification: 'failed_compile', total_ms: Date.now() - t0, source_lines: source.split('\n').length, has_il_blob: false, error: err.message };
  }

  // (b) pine_save_source — REST save. Heuristic: TV cloud ids look like
  // `USER;<hex>` — strict prefix check. Anything else is treated as a name.
  stepMs = _stepTimer();
  let saveRes;
  try {
    const looksLikeId = /^USER;/i.test(script_id_or_name);
    saveRes = await saveSource(looksLikeId ? { id: script_id_or_name, source } : { name: script_id_or_name, source });
    recordStep('pine_save_source', !!saveRes?.success && !!saveRes?.has_il_blob, {
      id: saveRes?.id,
      source_chars: saveRes?.source_chars,
      has_il_blob: saveRes?.has_il_blob,
    }, stepMs());
    if (!saveRes?.success || !saveRes?.has_il_blob) {
      return { success: false, steps, final_verification: 'failed_save', total_ms: Date.now() - t0, source_lines: source.split('\n').length, has_il_blob: !!saveRes?.has_il_blob, error: 'pine_save_source returned no il_blob' };
    }
  } catch (err) {
    recordStep('pine_save_source', false, { error: err.message }, stepMs());
    return { success: false, steps, final_verification: 'failed_save', total_ms: Date.now() - t0, source_lines: source.split('\n').length, has_il_blob: false, error: err.message };
  }

  // (b2) settings snapshot — BEFORE any chart mutation. `remove + add` resets
  // every input to its declared default; without this the loss is invisible.
  let inputsBefore = null;
  let newEntityId = null;
  if (indicator_display_name) {
    stepMs = _stepTimer();
    try {
      const state = await chartGetState();
      const live = (state?.studies || []).find(s => (s.name || '').toLowerCase().includes(indicator_display_name.toLowerCase()));
      inputsBefore = live ? await studyInputs(live.id) : null;
      recordStep('settings_snapshot', !!inputsBefore, {
        entity_id: live?.id ?? null,
        input_count: inputsBefore?.count ?? null,
        note: live ? undefined : 'study not on chart before reload — nothing to lose',
      }, stepMs());
    } catch (err) {
      recordStep('settings_snapshot', false, { error: err.message, note: 'best-effort; continuing' }, stepMs());
    }
  }

  // (c)+(d)+(e) refresh + reload + verify. Retries cover cache/reload faults
  // ONLY — see the header note: a version mismatch is terminal, because a retry
  // cannot change a wrong version string and each retry is another non-atomic
  // chart mutation.
  let verification = 'not_attempted';
  let versionFound = null;
  for (let attempt = 0; attempt <= max_retries; attempt++) {
    const suffix = attempt > 0 ? `[retry${attempt}]` : '';

    // (c) refresh catalog — best-effort (self-primes the dialog since T184)
    stepMs = _stepTimer();
    try {
      const refRes = await refreshCatalog();
      recordStep('pine_refresh_catalog' + suffix, !!refRes?.success, {
        cache_after_count: refRes?.cache_after_count,
        delta: refRes?.delta,
        ...(refRes?.auto_primed !== undefined && { auto_primed: refRes.auto_primed }),
      }, stepMs());
    } catch (err) {
      recordStep('pine_refresh_catalog' + suffix, false, { error: err.message, note: 'best-effort; continuing' }, stepMs());
    }

    // (d) reload: ADD FIRST, then remove the old instances. Never the reverse —
    // a failed add after a successful remove leaves the chart with no indicator.
    if (indicator_display_name) {
      stepMs = _stepTimer();
      try {
        const state = await chartGetState();
        const existing = (state?.studies || []).filter(s => (s.name || '').toLowerCase().includes(indicator_display_name.toLowerCase()));
        const addRes = await manageIndicator({ action: 'add', indicator: indicator_display_name });
        const reloadOk = !!addRes?.success && !!addRes?.entity_id;
        let removed = 0;
        if (reloadOk) {
          newEntityId = addRes.entity_id;
          for (const e of existing) {
            if (e.id === newEntityId) continue;
            try { await manageIndicator({ action: 'remove', indicator: indicator_display_name, entity_id: e.id }); removed++; }
            catch (_) { /* a stale instance left behind is visible; not worth failing the ship */ }
          }
        }
        recordStep('chart_reload' + suffix, reloadOk, {
          order: 'add_then_remove',
          removed,
          kept_on_add_failure: reloadOk ? 0 : existing.length,
          add_resolution: addRes?.resolution,
          add_entity_id: addRes?.entity_id,
          ...(reloadOk ? {} : { error: addRes?.error, note: 'add failed — the OLD study was deliberately left on the chart' }),
        }, stepMs());
        if (!reloadOk) {
          if (attempt < max_retries) continue;
          return { success: false, steps, final_verification: 'failed_reload', total_ms: Date.now() - t0, source_lines: source.split('\n').length, has_il_blob: true, layout_saved: false, error: addRes?.error || 'chart_manage_indicator(add) failed' };
        }
      } catch (err) {
        recordStep('chart_reload' + suffix, false, { error: err.message }, stepMs());
        if (attempt < max_retries) continue;
        return { success: false, steps, final_verification: 'failed_reload', total_ms: Date.now() - t0, source_lines: source.split('\n').length, has_il_blob: true, layout_saved: false, error: err.message };
      }
    }

    // (e) verify — by expected_version label (preferred) or by row count.
    // Resolve the study we just ADDED by its entity id, not by name substring:
    // with an old instance transiently present, a name match can read either one.
    stepMs = _stepTimer();
    if (expected_version && indicator_display_name) {
      try {
        const state = await chartGetState();
        const reloaded = (state?.studies || []).find(s => s.id === newEntityId)
          || (state?.studies || []).find(s => (s.name || '').toLowerCase().includes(indicator_display_name.toLowerCase()));
        const found = reloaded ? reloaded.name : null;
        const matched = found && found.toLowerCase().includes(expected_version.toLowerCase());
        versionFound = found;
        recordStep('verify' + suffix, !!matched, { expected_version, found, matched }, stepMs());
        if (matched) { verification = 'passed'; break; }
        if (found) {
          // The study loaded and declares a DIFFERENT version. Terminal — a
          // retry churns the chart and cannot change the declared string.
          verification = 'failed_version_mismatch';
          break;
        }
      } catch (err) {
        recordStep('verify' + suffix, false, { error: err.message }, stepMs());
      }
    } else if (indicator_display_name) {
      try {
        const tables = await getPineTables({ study_filter: indicator_display_name });
        const rowCount = tables?.studies?.[0]?.rows?.length ?? 0;
        const ok = rowCount > 0;
        recordStep('verify' + suffix, ok, { row_count: rowCount, study_filter: indicator_display_name }, stepMs());
        if (ok) { verification = 'passed'; break; }
      } catch (err) {
        recordStep('verify' + suffix, false, { error: err.message }, stepMs());
      }
    } else {
      // No reload-and-verify probe specified — accept save+refresh as terminal success.
      verification = 'save_only';
      break;
    }
  }

  if (verification === 'not_attempted') verification = 'failed_after_retries';

  // (f) settings restore + loss check. The reload recreated the study at its
  // DECLARED DEFAULTS, so anything the operator had tuned is now reset. Put it
  // back where it is safe to do so, then diff — what remains changed after the
  // restore is a real, unrecoverable loss and blocks the layout save.
  let settingsDelta = null;
  if (inputsBefore && newEntityId) {
    stepMs = _stepTimer();
    let restore = null;
    if (restore_settings) {
      try { restore = await restoreStudyInputs(newEntityId, inputsBefore); }
      catch (err) { restore = { restored: null, reason: `restore threw: ${err.message}` }; }
    }
    const after = await studyInputs(newEntityId);
    settingsDelta = diffInputs(inputsBefore, after);
    recordStep('settings_precheck', !settingsDelta || settingsDelta.changed.length === 0, {
      inputs_compared: settingsDelta?.count_before ?? null,
      restored: restore?.restored ?? null,
      ...(restore?.reason && { restore_note: restore.reason }),
      changed: settingsDelta?.changed ?? null,
    }, stepMs());
  }

  // (g) layout save — the durability half. Skipped on a failed verification
  // (never persist a chart we could not confirm) and refused on a settings loss
  // (persisting it would make the loss permanent).
  let layoutSaved = false;
  const settingsLost = !!(settingsDelta && settingsDelta.changed.length);
  if (save_layout && verification === 'passed') {
    stepMs = _stepTimer();
    if (settingsLost && !force_layout_save) {
      recordStep('layout_save', false, {
        skipped: 'settings_loss',
        changed: settingsDelta.changed,
        note: 'reload reset inputs that differed from the declared defaults. Layout NOT saved — ' +
              'saving would make the loss permanent. Restore the inputs and save the layout, or ' +
              're-run with force_layout_save.',
      }, stepMs());
    } else {
      try {
        const ls = await saveLayout();
        layoutSaved = !!ls.success;
        recordStep('layout_save', layoutSaved, {
          has_changes_before: ls.has_changes_before,
          has_changes_after: ls.has_changes_after,
          ...(ls.error && { error: ls.error }),
        }, stepMs());
      } catch (err) {
        recordStep('layout_save', false, { error: err.message }, stepMs());
      }
    }
  }

  return {
    success: verification === 'passed' || verification === 'save_only',
    steps,
    final_verification: verification,
    ...(verification === 'failed_version_mismatch' && {
      error: `the reloaded study declares "${versionFound}" but expected_version was "${expected_version}". ` +
             'NOT retried — a retry cannot change a declared version string, it only churns the chart through ' +
             'more non-atomic mutations. Check that the version is bumped in BOTH the header comment AND the ' +
             'indicator() declaration, not only the version-history comment.',
    }),
    total_ms: Date.now() - t0,
    source_lines: source.split('\n').length,
    has_il_blob: !!saveRes?.has_il_blob,
    layout_saved: layoutSaved,
    ...(settingsDelta && { settings_delta: settingsDelta }),
    // A verified ship that did not persist is the exact silent-revert hazard.
    ...(verification === 'passed' && save_layout && !layoutSaved && {
      durability_warning: 'VERIFIED BUT NOT DURABLE — the chart layout was not saved, so the next app ' +
                          'restart or layout re-sync will re-instantiate the PREVIOUS version of this study.',
    }),
  };
}
