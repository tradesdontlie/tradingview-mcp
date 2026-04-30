import { z } from 'zod';
import { evaluate, getClient } from '../connection.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Helper JS snippet (injected into TV page) that finds the Monaco editor
 * through the React fiber tree. Monaco is NOT on window.monaco — it's scoped
 * inside a React component prop called `monacoEnv`.
 *
 * Path: .monaco-editor.pine-editor-monaco → __reactFiber$ → walk .return →
 *       memoizedProps.value.monacoEnv → .editor.getEditors()[0]
 */
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
async function ensurePineEditorOpen() {
  // Check if Monaco is already accessible via fiber
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  // Open the Pine editor panel via bottomWidgetBar
  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  // Also click the Pine button in the DOM as fallback
  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  // Poll for Monaco to load (up to 10 seconds)
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

function formatPineCompilerMessage(item) {
  let message = item?.message || '';
  const ctx = item?.ctx;
  if (ctx && typeof ctx === 'object') {
    for (const [key, value] of Object.entries(ctx)) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
  }
  return message;
}

export function registerPineTools(server) {

  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor or Monaco not found in React fiber tree.' }, null, 2) }], isError: true };
      }

      const source = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return null;
          return m.editor.getValue();
        })()
      `);

      if (source === null || source === undefined) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Monaco editor found but getValue() returned null.' }, null, 2) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, source, line_count: source.split('\n').length, char_count: source.length }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      const escaped = JSON.stringify(source);
      const set = await evaluate(`
        (function() {
          var m = ${FIND_MONACO};
          if (!m) return false;
          m.editor.setValue(${escaped});
          return true;
        })()
      `);

      if (!set) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Monaco found but setValue() failed.' }, null, 2) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, lines_set: source.split('\n').length }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      // Priority: "Save and add to chart" > "Add to chart" > "Update on chart" > Pine editor Save button
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
            // Pine editor's own Save button (class contains 'saveButton')
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
        // Fallback: Ctrl+Enter
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
      }

      await new Promise(r => setTimeout(r, 2000));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, button_clicked: clicked || 'keyboard_shortcut' }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
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

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        has_errors: errors?.length > 0,
        error_count: errors?.length || 0,
        errors: errors || [],
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
      await new Promise(r => setTimeout(r, 500));

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'Ctrl+S dispatched' }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── pine_get_console ─────────────────────────────────────────────────
  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      const entries = await evaluate(`
        (function() {
          // The Pine console lives inside the bottom layout area, below the Monaco editor.
          // Try multiple selector strategies to find log rows.
          var results = [];

          // Strategy 1: consoleRow-style classes
          var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
          if (rows.length === 0) {
            // Strategy 2: look inside the bottom area for message-like elements
            var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
              || document.querySelector('[class*="bottom-widgetbar-content"]');
            if (bottomArea) {
              rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
            }
          }
          if (rows.length === 0) {
            // Strategy 3: look for elements near the pine editor that contain timestamps (HH:MM:SS pattern)
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

            // Parse timestamp if present (HH:MM:SS or YYYY-MM-DD HH:MM:SS)
            var ts = null;
            var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
            if (tsMatch) ts = tsMatch[0];

            // Classify type
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

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        entries: entries || [],
        entry_count: entries?.length || 0,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── pine_smart_compile ───────────────────────────────────────────────
  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      // Snapshot study count before compile
      const studiesBefore = await evaluate(`
        (function() {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
          } catch(e) {}
          return null;
        })()
      `);

      // Detect and click the appropriate compile button
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
        // Fallback: Ctrl+Enter
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
      }

      // Wait for compilation
      await new Promise(r => setTimeout(r, 2500));

      // Check for errors via Monaco markers
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

      // Snapshot study count after compile
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

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        button_clicked: buttonClicked || 'keyboard_shortcut',
        has_errors: errors?.length > 0,
        errors: errors || [],
        study_added: studyAdded,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── pine_new ─────────────────────────────────────────────────────────
  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      const escapedType = JSON.stringify(type);

      // Click the script dropdown/title at the top of the Pine editor toolbar
      const opened = await evaluate(`
        (function() {
          // The dropdown trigger is a button in the Pine editor toolbar area showing the script name
          var pineToolbar = document.querySelector('[class*="pine-editor"] [class*="toolbar"]')
            || document.querySelector('[class*="editorToolbar"]')
            || document.querySelector('[class*="layout__area--bottom"] [class*="toolbar"]');
          if (!pineToolbar) {
            // Fallback: find the dropdown arrow button near script name
            var dropBtns = document.querySelectorAll('[class*="layout__area--bottom"] button');
            for (var i = 0; i < dropBtns.length; i++) {
              var cls = dropBtns[i].className || '';
              if (/dropdown|scriptTitle|scriptName/i.test(cls) || dropBtns[i].querySelector('[class*="arrow"]')) {
                dropBtns[i].click();
                return 'dropdown_clicked';
              }
            }
          }
          // Try clicking a recognizable dropdown in the toolbar
          if (pineToolbar) {
            var btns = pineToolbar.querySelectorAll('button');
            for (var j = 0; j < btns.length; j++) {
              var c = btns[j].className || '';
              if (/dropdown|title|script/i.test(c) || btns[j].querySelector('svg')) {
                btns[j].click();
                return 'toolbar_btn_clicked';
              }
            }
            // Click first button as last resort
            if (btns.length > 0) { btns[0].click(); return 'first_btn_clicked'; }
          }
          return null;
        })()
      `);

      await new Promise(r => setTimeout(r, 300));

      // Look for the "New" menu items and click the matching type
      const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
      const escapedLabel = JSON.stringify(typeMap[type]);

      const clicked = await evaluate(`
        (function() {
          var label = ${escapedLabel};
          // Look for menu items that mention "New indicator script", "New strategy script", "New library"
          var items = document.querySelectorAll('[class*="menu"] [class*="item"], [class*="dropdown"] [class*="item"], [role="menuitem"], [class*="popup"] [class*="item"]');
          for (var i = 0; i < items.length; i++) {
            var text = items[i].textContent.trim().toLowerCase();
            if (text.indexOf('new') !== -1 && text.indexOf(label) !== -1) {
              items[i].click();
              return text;
            }
          }
          // Broader search: any clickable element in any popup/overlay
          var allClickable = document.querySelectorAll('[class*="menuWrap"] *, [class*="popup"] *, [class*="overlay"] *');
          for (var j = 0; j < allClickable.length; j++) {
            var t = allClickable[j].textContent.trim().toLowerCase();
            if (t.indexOf('new') !== -1 && t.indexOf(label) !== -1) {
              allClickable[j].click();
              return t;
            }
          }
          return null;
        })()
      `);

      if (!clicked) {
        // Close any open menu
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not find "New ' + type + '" menu item. Dropdown may not have opened or menu structure differs.' }, null, 2) }], isError: true };
      }

      await new Promise(r => setTimeout(r, 500));

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, type, action: 'new_script_created' }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── pine_open ────────────────────────────────────────────────────────
  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      // Click the script dropdown/title to open the script list
      await evaluate(`
        (function() {
          var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
          if (!bottomArea) return;
          var btns = bottomArea.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var cls = btns[i].className || '';
            if (/dropdown|scriptTitle|scriptName|title/i.test(cls) || btns[i].querySelector('[class*="arrow"]')) {
              btns[i].click();
              return;
            }
          }
          // Fallback: look for a toolbar and click the first plausible button
          var toolbar = bottomArea.querySelector('[class*="toolbar"]');
          if (toolbar) {
            var tbtns = toolbar.querySelectorAll('button');
            if (tbtns.length > 0) tbtns[0].click();
          }
        })()
      `);

      await new Promise(r => setTimeout(r, 300));

      const escapedName = JSON.stringify(name.toLowerCase());

      const found = await evaluate(`
        (function() {
          var target = ${escapedName};
          var items = document.querySelectorAll('[class*="menu"] [class*="item"], [class*="dropdown"] [class*="item"], [role="menuitem"], [class*="popup"] [class*="item"], [class*="menuWrap"] *');
          for (var i = 0; i < items.length; i++) {
            var text = items[i].textContent.trim();
            if (text.toLowerCase() === target || text.toLowerCase().indexOf(target) !== -1) {
              items[i].click();
              return text;
            }
          }
          return null;
        })()
      `);

      if (!found) {
        // Close dropdown
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Script "' + name + '" not found in dropdown list.' }, null, 2) }], isError: true };
      }

      await new Promise(r => setTimeout(r, 500));

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, name: found, opened: true }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── pine_list_scripts ────────────────────────────────────────────────
  server.tool('pine_list_scripts', 'List saved Pine Scripts from the editor dropdown', {}, async () => {
    try {
      const editorReady = await ensurePineEditorOpen();
      if (!editorReady) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open Pine Editor.' }, null, 2) }], isError: true };
      }

      // Click the script dropdown/title to open the script list
      await evaluate(`
        (function() {
          var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
          if (!bottomArea) return;
          var btns = bottomArea.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var cls = btns[i].className || '';
            if (/dropdown|scriptTitle|scriptName|title/i.test(cls) || btns[i].querySelector('[class*="arrow"]')) {
              btns[i].click();
              return;
            }
          }
          var toolbar = bottomArea.querySelector('[class*="toolbar"]');
          if (toolbar) {
            var tbtns = toolbar.querySelectorAll('button');
            if (tbtns.length > 0) tbtns[0].click();
          }
        })()
      `);

      await new Promise(r => setTimeout(r, 300));

      // Scrape all script names from the dropdown
      const scripts = await evaluate(`
        (function() {
          var names = [];
          var items = document.querySelectorAll('[class*="menu"] [class*="item"], [class*="dropdown"] [class*="item"], [role="menuitem"], [class*="popup"] [class*="item"], [class*="menuWrap"] [class*="item"]');
          for (var i = 0; i < items.length; i++) {
            var text = items[i].textContent.trim();
            // Filter out action items like "New indicator script", "Open...", etc.
            if (text && !/^(new |open |save |rename |delete |make a copy)/i.test(text)) {
              if (names.indexOf(text) === -1) names.push(text);
            }
          }
          return names;
        })()
      `);

      // Close the dropdown
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        scripts: scripts || [],
        count: scripts?.length || 0,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── Pine Static Analysis (offline, no TradingView connection needed) ──
  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try {
      const lines = source.split('\n');
      const diagnostics = [];

      // Check version
      let isV6 = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
        if (trimmed.startsWith('//@version=')) break;
        if (trimmed === '' || trimmed.startsWith('//')) continue;
        break;
      }

      // Collect array declarations
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

      // Check array.get/set out of bounds
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

      // Check unguarded array.first()/array.last() on potentially empty arrays
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
        let match;
        while ((match = firstLastPattern.exec(line)) !== null) {
          const arrName = match[1];
          if (arrName === 'array') continue; // skip array.first() without context
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

      // Check for common issues
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Warn on strategy.entry without strategy declaration
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

        // Warn on plot() in strategy without overlay
        if (trimmed.startsWith('plot(') || trimmed.startsWith('plotshape(') || trimmed.startsWith('plotchar(')) {
          // Just a note — not necessarily wrong
        }
      }

      // Version-specific checks
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

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        issue_count: diagnostics.length,
        diagnostics,
        note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });

  // ── Pine Server Compile (via TradingView's pine-facade API, no chart needed) ──
  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try {
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
        return { content: [{ type: 'text', text: JSON.stringify({
          success: false,
          error: `TradingView API returned ${response.status}: ${response.statusText}`,
          hint: 'pine-facade API may be rate-limited or require authentication for some operations.',
        }, null, 2) }], isError: true };
      }

      const result = await response.json();

      // Parse the response — TV API returns { success, result: { errors2, warnings2, functions2 } }
      const errors = [];
      const warnings = [];
      const inner = result?.result;

      if (inner) {
        // errors2 array: [{start: {line, column}, end: {line, column}, message}]
        if (inner.errors2 && inner.errors2.length > 0) {
          for (const e of inner.errors2) {
            errors.push({
              line: e.start?.line,
              column: e.start?.column,
              end_line: e.end?.line,
              end_column: e.end?.column,
              message: formatPineCompilerMessage(e),
              code: e.code,
            });
          }
        }

        // warnings2 array (same format)
        if (inner.warnings2 && inner.warnings2.length > 0) {
          for (const w of inner.warnings2) {
            warnings.push({
              line: w.start?.line,
              column: w.start?.column,
              message: formatPineCompilerMessage(w),
              code: w.code,
            });
          }
        }
      }

      // Also handle top-level error (malformed request etc)
      if (result.error && typeof result.error === 'string') {
        errors.push({ message: result.error });
      }

      const compiled = errors.length === 0;

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        compiled,
        error_count: errors.length,
        warning_count: warnings.length,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        note: compiled ? 'Pine Script compiled successfully.' : undefined,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
    }
  });
}
