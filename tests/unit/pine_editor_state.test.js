import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger } from '../../src/core/_mutation_ledger.js';
import * as pine from '../../src/core/pine.js';

/**
 * C2 / A1-F5 / A2-F2: pine_get_editor_state must surface editor binding
 * (script_name, dirty, action_button, modal, compile_errors). pine_deploy_*
 * MUST refuse with code:"EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT" when the
 * editor is bound to a different saved script and force_overwrite_editor
 * is false.
 *
 * Test scope: ONLY the preflight return shapes (read-only paths). The full
 * deploy flow (saveAs, button click, study wait) uses module-level evaluate()
 * which can't be mocked here; we test it in tests/e2e.test.js with live CDP.
 */
describe('pine.getEditorState (C2)', () => {
  beforeEach(() => _resetLedger());

  it('returns clean state when editor is empty', async () => {
    const _deps = {
      evaluate: async () => ({
        panel_open: true,
        source: '',
        script_name: null,
        dirty: false,
        compile_errors: [],
        action_button: null,
        modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.getEditorState({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.panel_open, true);
    assert.equal(r.script_name, null);
    assert.equal(r.dirty, false);
    assert.equal(r.action_button, null);
    assert.equal(r.modal.present, false);
    assert.ok(typeof r.source_hash === 'string');
  });

  it('surfaces editor-bound script_name + dirty flag', async () => {
    const _deps = {
      evaluate: async () => ({
        panel_open: true,
        source: '//@version=6\nindicator("Foo")',
        script_name: '6015 Americana 4H RSI',
        dirty: true,
        compile_errors: [],
        action_button: 'update_on_chart',
        modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.getEditorState({ _deps });
    assert.equal(r.script_name, '6015 Americana 4H RSI');
    assert.equal(r.dirty, true);
    assert.equal(r.action_button, 'update_on_chart');
  });

  it('include_source_hash=false suppresses source_hash', async () => {
    const _deps = {
      evaluate: async () => ({
        panel_open: true, source: 'x', script_name: 'X', dirty: false,
        compile_errors: [], action_button: null,
        modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.getEditorState({ _deps, include_source_hash: false });
    assert.equal(r.source_hash, null);
  });

  it('reports compile_errors from Monaco markers', async () => {
    const _deps = {
      evaluate: async () => ({
        panel_open: true, source: 'bad', script_name: null, dirty: true,
        compile_errors: [{ line: 14, column: 1, message: 'Mismatched input "+" expecting end of line', severity: 8 }],
        action_button: 'save', modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.getEditorState({ _deps });
    assert.equal(r.compile_errors.length, 1);
    assert.equal(r.compile_errors[0].line, 14);
    assert.match(r.compile_errors[0].message, /Mismatched input/);
  });

  it('reports blocking modal', async () => {
    const _deps = {
      evaluate: async () => ({
        panel_open: true, source: 'x', script_name: 'X', dirty: false,
        compile_errors: [], action_button: 'save_and_add_to_chart',
        modal: { present: true, title: 'Save script', primary_label: 'Save and add to chart', secondary_label: 'Cancel' },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.getEditorState({ _deps });
    assert.equal(r.modal.present, true);
    assert.equal(r.modal.title, 'Save script');
    assert.equal(r.modal.primary_label, 'Save and add to chart');
  });

  it('panel_open=false when editor unavailable', async () => {
    const _deps = {
      evaluate: async () => null,
      ensurePineEditorOpen: async () => false,
    };
    const r = await pine.getEditorState({ _deps });
    assert.equal(r.panel_open, false);
    assert.equal(r.success, false);
  });
});

describe('pine.deployStrategy preflight refusal (C2)', () => {
  beforeEach(() => _resetLedger());

  function _editorWith(scriptName) {
    return {
      evaluate: async () => ({
        panel_open: true,
        source: '//@version=6\nindicator("' + scriptName + '")',
        script_name: scriptName,
        dirty: false,
        compile_errors: [],
        action_button: 'update_on_chart',
        modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
  }

  it('REFUSES with EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT (default force=false)', async () => {
    const _deps = _editorWith('6015 Americana 4H RSI');
    const r = await pine.deployStrategy({
      source: '//@version=6\nindicator("EarnsExtractor")\n',
      name: 'EarnsExtractor',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.code, 'EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT');
    assert.equal(r.editor_saved_script_name, '6015 Americana 4H RSI');
    assert.equal(r.requested_script_name, 'EarnsExtractor');
    assert.match(r.remediation, /force_overwrite_editor=true|pine_new/);
  });

  it('REFUSES with completely different name (Foo RSI -> Bar EMA)', async () => {
    const _deps = _editorWith('Foo RSI');
    const r = await pine.deployStrategy({
      source: '//@version=6\nindicator("Bar EMA")\n',
      name: 'Bar EMA',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.code, 'EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT');
  });

  it('REFUSES when requested name is auto-derived from source', async () => {
    const _deps = _editorWith('Stale Script Name');
    // Name auto-derived from indicator() title in source
    const r = await pine.deployStrategy({
      source: '//@version=6\nindicator("AutoNamed")\n',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.code, 'EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT');
    assert.equal(r.requested_script_name, 'AutoNamed');
  });

  // For the "doesn't refuse" cases (same-script, force=true, empty editor),
  // pine.deployStrategy continues past the preflight and hits saveAs which
  // uses module-level evaluate() — those paths require live CDP and are
  // covered by tests/e2e.test.js. We don't assert them here to avoid hangs.
});
