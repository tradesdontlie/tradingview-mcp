/**
 * Unit tests for src/core/pine.js — covers bug fixes B5, B9, B12.
 *
 * Approach: rather than mocking the live TradingView DOM, we mock the
 * `evaluate()` function via the `_deps` DI hook and a JS-side simulation
 * of the page. Each test sets up a virtual page state and the mock
 * evaluate() interprets the snippet text and returns the simulated answer.
 *
 * Run: node --test tests/pine.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compile, smartCompile, ensurePineEditorOpen } from '../src/core/pine.js';

// ── Mock helpers ────────────────────────────────────────────────────────

/**
 * Build a mock `evaluate()` that reads "page state" and returns scripted values
 * based on which IIFE in pine.js is being invoked.
 *
 * Each call to `evaluate(expr)` is dispatched by matching well-known fragments
 * of the IIFE source against the `expr` string.
 *
 * @param {object} page — virtual page state. Mutated by the simulated DOM ops.
 *   - monacoReady: bool (default true)
 *   - panelPresent / panelVisible / containerPresent / containerVisible: bools
 *   - studies: number (current study count). Buttons mutate this.
 *   - buttons: Array<{ text: string, visible?: bool, isSave?: bool }>
 *     Order matters — first match wins per the IIFE logic.
 *   - errors: Array<{ line, column, message, severity }> — returned for monaco markers.
 *   - studyCountReadable: bool (default true) — if false, study count expr returns null.
 *   - onClick: optional function called with the clicked button text.
 */
function mockEvaluate(page) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);

    // PROBE inside ensurePineEditorOpen
    if (expr.includes('monaco_ready')) {
      return {
        monaco_ready: page.monacoReady !== false,
        container_present: page.containerPresent !== false,
        container_visible: page.containerVisible !== false,
        panel_present: page.panelPresent !== false,
        panel_visible: page.panelVisible !== false,
      };
    }

    // Study-count expression (compile and smartCompile both use STUDY_COUNT_EXPR)
    if (expr.includes('getAllStudies')) {
      if (page.studyCountReadable === false) return null;
      return page.studies;
    }

    // Activation snippets — no return value needed
    if (expr.includes('activateScriptEditorTab') || expr.includes('aria-label="Pine"')) {
      return undefined;
    }

    // Button-click snippet — appears in both compile and smartCompile.
    // Both snippets do `document.querySelectorAll('button')` then iterate.
    // We detect by the regex patterns inside.
    if (expr.includes("document.querySelectorAll('button')") && expr.includes('save and add to chart')) {
      // Replicate priority logic.
      const isSmartCompile = expr.includes('^update on chart$');
      const isCompile = !isSmartCompile && expr.includes('Update on chart');

      let saveAndAdd = null;
      let addBtn = null;
      let updateBtn = null;
      let saveBtn = null;

      for (const b of (page.buttons || [])) {
        const text = b.text;
        if (!saveAndAdd && /save and add to chart/i.test(text)) saveAndAdd = b;
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = b;
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = b;
        if (!saveBtn && b.isSave && b.visible !== false) saveBtn = b;
      }

      const click = (b, label) => {
        if (page.onClick) page.onClick(label, b);
        if (label === 'Add to chart' || label === 'Save and add to chart') {
          page.studies = (page.studies || 0) + 1;
        }
        return label;
      };

      if (saveAndAdd) return click(saveAndAdd, 'Save and add to chart');

      if (isSmartCompile) {
        // B5 fix: Update > Add > Save
        if (updateBtn) return click(updateBtn, 'Update on chart');
        if (addBtn) return click(addBtn, 'Add to chart');
        if (saveBtn) return click(saveBtn, 'Pine Save');
        return null;
      }
      // compile() priority: Add OR Update first (whichever matched first), then Save.
      // The compile() IIFE picks the first matching Add/Update via a "fallback"
      // variable. For our tests we treat them equivalently.
      if (addBtn) return click(addBtn, 'Add to chart');
      if (updateBtn) return click(updateBtn, 'Update on chart');
      if (saveBtn) return click(saveBtn, 'Pine Save');
      return null;
    }

    // Monaco markers (errors)
    if (expr.includes('getModelMarkers')) {
      return page.errors || [];
    }

    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockGetClient(onKeyboard) {
  return async () => ({
    Input: {
      dispatchKeyEvent: async (evt) => {
        if (onKeyboard) onKeyboard(evt);
      },
    },
  });
}

// ── B5: smartCompile button priority ────────────────────────────────────

describe('smartCompile() — B5: button priority', () => {
  it('prefers "Add to chart" over "Save" when both are present', async () => {
    let clicked = null;
    const page = {
      studies: 3,
      buttons: [
        { text: 'Save', isSave: true, visible: true },
        { text: 'Add to chart' },
      ],
      onClick: (label) => { clicked = label; },
    };
    const evaluate = mockEvaluate(page);
    const result = await smartCompile({
      _deps: { evaluate, getClient: mockGetClient() },
    });
    assert.equal(result.button_clicked, 'Add to chart');
    assert.equal(clicked, 'Add to chart');
    assert.equal(result.study_added, true);
    assert.equal(result.study_updated, false);
    assert.equal(result.study_saved, false);
  });

  it('prefers "Update on chart" over "Add to chart" and "Save"', async () => {
    let clicked = null;
    const page = {
      studies: 2,
      buttons: [
        { text: 'Save', isSave: true, visible: true },
        { text: 'Add to chart' },
        { text: 'Update on chart' },
      ],
      onClick: (label) => { clicked = label; },
    };
    const evaluate = mockEvaluate(page);
    const result = await smartCompile({
      _deps: { evaluate, getClient: mockGetClient() },
    });
    assert.equal(result.button_clicked, 'Update on chart');
    assert.equal(clicked, 'Update on chart');
    assert.equal(result.study_updated, true);
    assert.equal(result.study_added, false);
  });

  it('falls back to "Save" only when no Add/Update button exists and marks study_added=false', async () => {
    let clicked = null;
    const page = {
      studies: 1,
      buttons: [{ text: 'Save', isSave: true, visible: true }],
      onClick: (label) => { clicked = label; },
    };
    const evaluate = mockEvaluate(page);
    const result = await smartCompile({
      _deps: { evaluate, getClient: mockGetClient() },
    });
    assert.equal(result.button_clicked, 'Pine Save');
    assert.equal(clicked, 'Pine Save');
    assert.equal(result.study_added, false);
    assert.equal(result.study_saved, true);
    assert.ok(result.note && /not.*added/i.test(result.note), 'note explains script was not added');
  });

  it('reports study_added=true based on before/after count delta', async () => {
    const page = {
      studies: 4,
      buttons: [{ text: 'Add to chart' }],
    };
    const evaluate = mockEvaluate(page);
    const result = await smartCompile({
      _deps: { evaluate, getClient: mockGetClient() },
    });
    assert.equal(result.studies_before, 4);
    assert.equal(result.studies_after, 5);
    assert.equal(result.study_added, true);
  });

  it('reports study_added=false when count did not change after Add click', async () => {
    // Simulate a failed add (e.g., compile error): override behavior so studies don't change.
    const page = {
      studies: 4,
      buttons: [{ text: 'Add to chart' }],
      onClick: () => { /* swallow side effect — but mockEvaluate already +1'd */ },
    };
    // Manually subtract: we want studies_after == studies_before. So override studies count
    // by setting studyCountReadable to return same value both calls.
    let readCount = 0;
    const baseEval = mockEvaluate(page);
    const evaluate = async (expr) => {
      if (expr.includes('getAllStudies')) {
        readCount++;
        return 4; // same both before and after
      }
      return baseEval(expr);
    };
    evaluate.calls = baseEval.calls;
    const result = await smartCompile({
      _deps: { evaluate, getClient: mockGetClient() },
    });
    assert.equal(result.studies_before, 4);
    assert.equal(result.studies_after, 4);
    assert.equal(result.study_added, false);
  });

  it('falls through to keyboard fallback when no buttons exist and reports verification', async () => {
    let keyPressed = false;
    const page = {
      studies: 0,
      buttons: [],
      studyCountReadable: false,
    };
    const evaluate = mockEvaluate(page);
    const result = await smartCompile({
      _deps: {
        evaluate,
        getClient: mockGetClient(() => { keyPressed = true; }),
      },
    });
    assert.equal(keyPressed, true, 'Ctrl+Enter dispatched');
    assert.equal(result.button_clicked, 'keyboard_shortcut');
    assert.equal(result.study_added, null);
    assert.equal(result.verification, 'unverified_keyboard_fallback');
  });
});

// ── B9: compile() keyboard fallback verification ─────────────────────────

describe('compile() — B9: keyboard fallback verification', () => {
  it('reports honest study_added when keyboard fallback adds a study', async () => {
    // No buttons → keyboard fallback. Simulate study count increase post-keypress.
    const studyCounts = [3, 4]; // before, after
    let readIdx = 0;
    let keyPressed = false;
    const page = { buttons: [] };
    const baseEval = mockEvaluate(page);
    const evaluate = async (expr) => {
      if (expr.includes('getAllStudies')) return studyCounts[Math.min(readIdx++, 1)];
      return baseEval(expr);
    };
    evaluate.calls = baseEval.calls;
    const result = await compile({
      _deps: {
        evaluate,
        getClient: mockGetClient(() => { keyPressed = true; }),
      },
    });
    assert.equal(keyPressed, true);
    assert.equal(result.button_clicked, 'keyboard_shortcut');
    assert.equal(result.studies_before, 3);
    assert.equal(result.studies_after, 4);
    assert.equal(result.study_added, true);
  });

  it('reports study_added=null with verification flag when count cannot be read', async () => {
    let keyPressed = false;
    const page = { buttons: [], studyCountReadable: false };
    const evaluate = mockEvaluate(page);
    const result = await compile({
      _deps: {
        evaluate,
        getClient: mockGetClient(() => { keyPressed = true; }),
      },
    });
    assert.equal(keyPressed, true);
    assert.equal(result.study_added, null);
    assert.equal(result.verification, 'unverified_keyboard_fallback');
  });

  it('reports honest study_added=false when keyboard fallback does NOT add a study', async () => {
    let keyPressed = false;
    const page = { buttons: [], studies: 5 };
    const baseEval = mockEvaluate(page);
    // studies stays the same — keyboard didn't take effect
    const evaluate = async (expr) => {
      if (expr.includes('getAllStudies')) return 5;
      return baseEval(expr);
    };
    evaluate.calls = baseEval.calls;
    const result = await compile({
      _deps: {
        evaluate,
        getClient: mockGetClient(() => { keyPressed = true; }),
      },
    });
    assert.equal(keyPressed, true);
    assert.equal(result.study_added, false);
    // verification flag only attached when count is unreadable
    assert.equal(result.verification, undefined);
  });
});

// ── B12: ensurePineEditorOpen diagnostic state ──────────────────────────

describe('ensurePineEditorOpen() — B12: diagnostic state on timeout', () => {
  it('returns ready=true with state when monaco is already loaded', async () => {
    const page = { monacoReady: true };
    const evaluate = mockEvaluate(page);
    const r = await ensurePineEditorOpen({ _evaluate: evaluate });
    assert.equal(r.ready, true);
    assert.ok(r.lastState);
    assert.equal(r.lastState.monaco_ready, true);
  });

  it('returns ready=false with lastState describing why when monaco never loads', async () => {
    const page = {
      monacoReady: false,
      containerPresent: true,
      containerVisible: true,
      panelPresent: true,
      panelVisible: true,
    };
    const evaluate = mockEvaluate(page);
    const r = await ensurePineEditorOpen({ _evaluate: evaluate });
    assert.equal(r.ready, false);
    assert.ok(r.lastState, 'lastState surfaced');
    assert.equal(r.lastState.monaco_ready, false);
    assert.equal(r.lastState.container_present, true);
    assert.equal(r.lastState.panel_visible, true);
  });

  it('surfaces panel-not-present in lastState', async () => {
    const page = {
      monacoReady: false,
      containerPresent: false,
      containerVisible: false,
      panelPresent: false,
      panelVisible: false,
    };
    const evaluate = mockEvaluate(page);
    const r = await ensurePineEditorOpen({ _evaluate: evaluate });
    assert.equal(r.ready, false);
    assert.equal(r.lastState.panel_present, false);
    assert.equal(r.lastState.container_present, false);
  });

  it('compile() throws an error message containing diagnostic detail when editor never opens', async () => {
    const page = {
      monacoReady: false,
      containerPresent: true,
      containerVisible: false,
      panelPresent: true,
      panelVisible: false,
    };
    const evaluate = mockEvaluate(page);
    await assert.rejects(
      () => compile({ _deps: { evaluate, getClient: mockGetClient() } }),
      (err) => {
        assert.ok(/Could not open Pine Editor/.test(err.message));
        // Diagnostic detail in parentheses
        assert.ok(/\(/.test(err.message) && /\)/.test(err.message),
          `error message should include parenthesized diagnostic: ${err.message}`);
        return true;
      },
    );
  });
});
