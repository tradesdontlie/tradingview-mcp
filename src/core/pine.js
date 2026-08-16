/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

let lastCompiledStudyIds = [];

// ── Monaco finder (injected into TV page) ──
export const FIND_MONACO = `
  (function findMonacoEditor() {
    var containers = Array.from(document.querySelectorAll('.monaco-editor.pine-editor-monaco'));
    var visible = containers.filter(function(container) {
      var rect = container.getBoundingClientRect();
      return container.isConnected && container.offsetParent !== null && rect.width > 0 && rect.height > 0;
    });

    for (var c = 0; c < visible.length; c++) {
      var container = visible[c];
      var el = container;
      var fiberKey;
      for (var i = 0; i < 40; i++) {
        if (!el) break;
        fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fiberKey) break;
        el = el.parentElement;
      }
      if (!fiberKey) continue;

      var current = el[fiberKey];
      for (var d = 0; d < 40; d++) {
        if (!current) break;
        if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
          var env = current.memoizedProps.value.monacoEnv;
          if (env.editor && typeof env.editor.getEditors === 'function') {
            var editors = env.editor.getEditors();
            var matched = editors.find(function(editor) {
              if (typeof editor.getDomNode !== 'function') return false;
              var node = editor.getDomNode();
              return node === container;
            });
            if (matched) return { editor: matched, env: env };

            var active = editors.find(function(editor) {
              if (typeof editor.getDomNode !== 'function') return false;
              var node = editor.getDomNode();
              if (!node || !node.isConnected || node.offsetParent === null) return false;
              var rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (active) return { editor: active, env: env };
          }
        }
        current = current.return;
      }
    }
    return null;
  })()
`;

// TradingView's Pine toolbar uses icon-only buttons in some layouts. The
// action is then exposed through title/data-tooltip instead of textContent.
export const FIND_PINE_ACTION_BUTTON = `
  (function findPineActionButton() {
    function isVisible(button) {
      if (!button || !button.isConnected || button.offsetParent === null) return false;
      var rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labels(button) {
      return [
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-tooltip'),
      ].filter(Boolean).map(function(label) { return label.trim().replace(/\\s+/g, ' '); });
    }

    var buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
    var actions = [
      { name: 'Save and add to chart', pattern: /^save and add to chart$/i },
      { name: 'Add to chart', pattern: /^add to chart$/i },
      { name: 'Update on chart', pattern: /^update on chart$/i },
    ];

    for (var a = 0; a < actions.length; a++) {
      for (var b = 0; b < buttons.length; b++) {
        if (labels(buttons[b]).some(function(label) { return actions[a].pattern.test(label); })) {
          return { button: buttons[b], action: actions[a].name };
        }
      }
    }
    return null;
  })()
`;

export const FIND_SAVE_BEFORE_ADD_BUTTON = `
  (function findSaveBeforeAddButton() {
    function isVisible(element) {
      if (!element || !element.isConnected || element.offsetParent === null) return false;
      var rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    var dialogs = Array.from(document.querySelectorAll('[data-name="confirm-dialog"]')).filter(isVisible);
    var dialog = dialogs.find(function(element) {
      return element.textContent.toLowerCase().includes('save this script before adding?');
    });
    if (!dialog) return null;

    var button = dialog.querySelector('button[data-qa-id="yes-btn"], button[name="yes"]');
    return isVisible(button) ? button : null;
  })()
`;

export const READ_PINE_CONSOLE = `
  (function readPineConsole() {
    function isVisible(element) {
      if (!element || !element.isConnected || element.offsetParent === null) return false;
      var rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    var wrappers = Array.from(document.querySelectorAll('[class*="consoleWrapper"]')).filter(isVisible);
    var wrapper = wrappers.find(function(element) {
      return /consoleWrapperOpen/.test(String(element.className));
    }) || wrappers[0];
    if (!wrapper) return { available: false, entries: [] };

    var rows = wrapper.querySelectorAll('table[class*="messages"] tbody tr');
    var entries = Array.from(rows).map(function(row) {
      var cells = Array.from(row.querySelectorAll('td'));
      var timestamp = null;
      var messageCells = cells;
      if (cells.length > 1 && /time/i.test(String(cells[0].className))) {
        timestamp = cells[0].textContent.trim() || null;
        messageCells = cells.slice(1);
      }
      var message = messageCells.map(function(cell) { return cell.textContent.trim(); }).filter(Boolean).join(' ');
      if (!message && cells.length === 0) message = row.textContent.trim();

      var signal = String(row.className) + ' ' + message;
      var type = 'info';
      if (/\\berror\\b/i.test(signal)) type = 'error';
      else if (/\\bwarn(?:ing)?\\b/i.test(signal)) type = 'warning';
      else if (/compil/i.test(message)) type = 'compile';
      return { timestamp: timestamp, type: type, message: message };
    }).filter(function(entry) { return entry.message; });

    return { available: true, entries: entries };
  })()
`;

export const READ_PINE_STUDY_LOGS = `
  (function readPineStudyLogs(preferredStudyIds) {
    var chart;
    try {
      chart = window.TradingViewApi._activeChartWidgetWV.value();
    } catch (e) {
      return { available: false, entries: [] };
    }
    if (!chart || !chart._chartWidget) return { available: false, entries: [] };

    var model = chart._chartWidget.model().model();
    var sources = typeof model.dataSources === 'function' ? model.dataSources() : [];
    var entries = [];
    var available = false;
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      if (typeof source.logs !== 'function' || typeof source.logLevelMask !== 'function') continue;

      var id;
      try { id = String(typeof source.id === 'function' ? source.id() : source.id); }
      catch (e) { continue; }
      var mask = source.logLevelMask() || {};
      var selected = preferredStudyIds.indexOf(id) !== -1 || mask.error || mask.warning || mask.info;
      if (!selected) continue;
      available = true;

      var title = '';
      try { title = String(typeof source.title === 'function' ? source.title() : source.title || ''); }
      catch (e) {}
      var logs = source.logs();
      var values = logs && typeof logs.values === 'function' ? Array.from(logs.values()) : [];
      for (var l = 0; l < values.length; l++) {
        var item = values[l] || {};
        var level = Number(item.level);
        var type = level === 1 ? 'error' : level === 2 ? 'warning' : 'info';
        var time = Number(item.time);
        entries.push({
          timestamp: Number.isFinite(time) ? new Date(time).toISOString() : null,
          type: type,
          level: Number.isFinite(level) ? level : null,
          message: String(item.message || ''),
          bar_time: Number.isFinite(Number(item.barTime)) ? Number(item.barTime) : null,
          study_id: id,
          study: title,
          line: item.source && item.source.start ? item.source.start.line : null,
          column: item.source && item.source.start ? item.source.start.column : null,
          source: 'pine_logs',
        });
      }
    }

    entries.sort(function(a, b) {
      return (a.bar_time || 0) - (b.bar_time || 0) || a.study_id.localeCompare(b.study_id);
    });
    return { available: available, entries: entries };
  })
`;

async function clickPineActionButton() {
  const action = await evaluate(`
    (function() {
      var match = ${FIND_PINE_ACTION_BUTTON};
      if (!match) return null;
      match.button.click();
      return match.action;
    })()
  `);

  if (!action) {
    throw new Error('Could not find a visible Add to chart or Update on chart control.');
  }
  return action;
}

async function handleSaveBeforeAddDialog() {
  for (let i = 0; i < 20; i++) {
    const handled = await evaluate(`
      (function() {
        var button = ${FIND_SAVE_BEFORE_ADD_BUTTON};
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    if (handled) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function enablePineLogs(studyIds) {
  if (!studyIds || studyIds.length === 0) return [];
  return evaluate(`
    (function() {
      var chart;
      try { chart = window.TradingViewApi._activeChartWidgetWV.value(); }
      catch (e) { return []; }
      if (!chart || !chart._chartWidget) return [];

      var wanted = ${JSON.stringify(studyIds)};
      var model = chart._chartWidget.model().model();
      var sources = typeof model.dataSources === 'function' ? model.dataSources() : [];
      var enabled = [];
      for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        if (typeof source.setLogLevelMask !== 'function') continue;
        var id;
        try { id = String(typeof source.id === 'function' ? source.id() : source.id); }
        catch (e) { continue; }
        if (wanted.indexOf(id) === -1) continue;
        source.setLogLevelMask({ error: true, warning: true, info: true });
        enabled.push(id);
      }
      return enabled;
    })()
  `);
}

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
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await clickPineActionButton();
  const saveBeforeAddHandled = /add to chart/i.test(clicked)
    ? await handleSaveBeforeAddDialog()
    : false;

  await new Promise(r => setTimeout(r, 2000));
  return {
    success: true,
    button_clicked: clicked,
    save_before_add_handled: saveBeforeAddHandled,
    source: 'pine_toolbar',
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

  const studyResult = await evaluate(
    `${READ_PINE_STUDY_LOGS}(${JSON.stringify(lastCompiledStudyIds)})`
  );

  const consoleState = await evaluate(`
    (function() {
      var visible = function(element) {
        if (!element || !element.isConnected || element.offsetParent === null) return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      var openButton = Array.from(document.querySelectorAll('button[data-tooltip="Open console"]')).find(visible);
      if (openButton) {
        openButton.click();
        return { available: true, opened: true };
      }
      var closeButton = Array.from(document.querySelectorAll('button[data-tooltip="Close console"]')).find(visible);
      return { available: !!closeButton, opened: false };
    })()
  `);

  if (consoleState?.opened) await new Promise(r => setTimeout(r, 250));

  const result = await evaluate(READ_PINE_CONSOLE);
  const studyEntries = studyResult?.entries || [];
  const consoleEntries = (result?.entries || []).map(entry => ({ ...entry, source: 'pine_console' }));
  const entries = [...studyEntries, ...consoleEntries];
  return {
    success: true,
    pine_logs_available: studyResult?.available || false,
    pine_log_entry_count: studyEntries.length,
    console_available: result?.available || consoleState?.available || false,
    console_opened: consoleState?.opened || false,
    entries,
    entry_count: entries.length,
    source: studyEntries.length > 0 ? 'pine_logs_and_console' : 'pine_console',
  };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') {
          return chart.getAllStudies().map(function(study) { return String(study.id); });
        }
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await clickPineActionButton();
  const expectsNewStudy = /add to chart/i.test(buttonClicked);
  const saveBeforeAddHandled = expectsNewStudy
    ? await handleSaveBeforeAddDialog()
    : false;
  if (expectsNewStudy) {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const added = await evaluate(`
        (function() {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            if (!chart || typeof chart.getAllStudies !== 'function') return false;
            var before = ${JSON.stringify(studiesBefore)};
            return chart.getAllStudies().some(function(study) { return before.indexOf(String(study.id)) === -1; });
          } catch(e) { return false; }
        })()
      `);
      if (added) break;
    }
  } else {
    await new Promise(r => setTimeout(r, 2500));
  }

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
        if (chart && typeof chart.getAllStudies === 'function') {
          return chart.getAllStudies().map(function(study) { return String(study.id); });
        }
      } catch(e) {}
      return null;
    })()
  `);

  const studyIdsAdded = (studiesBefore !== null && studiesAfter !== null)
    ? studiesAfter.filter(id => !studiesBefore.includes(id))
    : null;
  const studyAdded = studyIdsAdded === null ? null : studyIdsAdded.length > 0;
  if (expectsNewStudy && studyAdded === false && !(errors?.length > 0)) {
    throw new Error('Add to chart control was clicked but no study was added.');
  }
  if (studyIdsAdded && studyIdsAdded.length > 0) lastCompiledStudyIds = studyIdsAdded;
  const pineLogsEnabledFor = await enablePineLogs(lastCompiledStudyIds);
  if (pineLogsEnabledFor.length > 0) await new Promise(r => setTimeout(r, 250));

  return {
    success: true,
    button_clicked: buttonClicked,
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    study_ids_added: studyIdsAdded || [],
    save_before_add_handled: saveBeforeAddHandled,
    pine_logs_enabled_for: pineLogsEnabledFor,
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
