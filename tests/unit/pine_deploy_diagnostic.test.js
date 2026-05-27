import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger } from '../../src/core/_mutation_ledger.js';
import * as pine from '../../src/core/pine.js';

/**
 * C8 / A1-F8 / A2-F2: pine_deploy_* failure responses must include
 * step_completed, step_failed, compile_errors, ui_diagnostic. The
 * operator-session pattern (CC TV MCP.txt:277-292) wasted 3+ follow-up
 * probe calls to manually diagnose why "success:false" — that diagnosis
 * is now inline.
 *
 * Test scope: the early-step-failure path (set_source fails) is unit
 * testable with _deps. Later-step failures (add_to_chart_button_click,
 * study_added) exercise saveAs which uses module-level evaluate, covered
 * by live-CDP e2e.
 */

describe('pine.deployStrategy step diagnostic (C8)', () => {
  beforeEach(() => _resetLedger());

  it('set_source failure → step_failed:"set_source" + ui_diagnostic', async () => {
    const _deps = {
      // ORDER MATTERS: setValue eval contains FIND_MONACO which contains
      // 'pine-editor', so match the most-specific marker FIRST.
      evaluate: async (expr) => {
        const s = String(expr);
        if (/m\.editor\.setValue/.test(s)) return false; // setSource step fails
        if (/header-title-name|scriptTitle/.test(s) || /panel_open/.test(s)) {
          return { panel_open: true, source: '', script_name: null, dirty: false, compile_errors: [], action_button: null, modal: { present: false } };
        }
        return null;
      },
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.deployStrategy({
      source: '//@version=6\nindicator("X")',
      name: 'X',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.step_failed, 'set_source');
    assert.equal(r.step_completed, null);
    assert.match(r.ui_diagnostic, /Monaco editor not found/);
    assert.equal(r.study_id, null);
    assert.deepEqual(r.compile_errors, []);
    assert.match(r.note, /Deploy failed at step "set_source"/);
  });

  it('preflight refusal still returns the C2 shape (no C8 step_* fields)', async () => {
    // The C2 EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT path short-circuits before
    // step tracking begins. Verify the two shapes are distinct.
    const _deps = {
      evaluate: async () => ({
        panel_open: true, source: 'x', script_name: 'Stale', dirty: false,
        compile_errors: [], action_button: null,
        modal: { present: false, title: null, primary_label: null, secondary_label: null },
      }),
      ensurePineEditorOpen: async () => true,
    };
    const r = await pine.deployStrategy({
      source: '//@version=6\nindicator("New")\n',
      name: 'New',
      _deps,
    });
    assert.equal(r.success, false);
    assert.equal(r.code, 'EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT');
    // step_completed/step_failed not on the C2 path
    assert.equal(r.step_completed, undefined);
    assert.equal(r.step_failed, undefined);
  });
});
