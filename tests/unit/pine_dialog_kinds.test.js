import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIALOG_KINDS } from '../../src/core/pine.js';

/**
 * C7 / A1-F7: pine_dismiss_dialog must know specific dialog kinds and
 * select kind-specific primary buttons (e.g. "Save and add to chart"
 * not just generic "Save").
 *
 * The DOM-mutating path requires live CDP; here we unit-test the kind
 * regex map to confirm each kind's `test` regex matches its dialog body
 * text and `primary` regex matches its expected button label.
 */

describe('pine.DIALOG_KINDS regex coverage (C7)', () => {
  const fixtures = [
    {
      kind: 'save_and_add_to_chart',
      bodyHits: [
        'Save and add to chart',
        'Save Script',
        'You have unsaved changes. Save and add to chart?',
      ],
      primaryHits: ['Save and add to chart', 'Save'],
      primaryMisses: ['Cancel', 'Discard'],
    },
    {
      kind: 'unsaved_changes',
      bodyHits: [
        'You have unsaved changes',
        'Unsaved version of this script',
      ],
      primaryHits: ['Save', "Don't save", 'Discard', 'save and add'],
      primaryMisses: ['Cancel', 'OK'],
    },
    {
      kind: 'overwrite_existing_study',
      bodyHits: [
        'A study with this name already exists. Overwrite?',
        'overwrite the existing study',
      ],
      primaryHits: ['Overwrite', 'Yes', 'Confirm'],
      primaryMisses: ['Cancel'],
    },
    {
      kind: 'save_as_new',
      bodyHits: ['Save Script', 'Save as new'],
      primaryHits: ['Save', 'OK', 'Save as'],
      primaryMisses: ['Cancel'],
    },
    {
      kind: 'compile_error_modal',
      bodyHits: ['Compile error', 'Compilation failed'],
      primaryHits: ['Close', 'OK', 'Dismiss'],
      primaryMisses: ['Cancel'],
    },
  ];

  for (const fx of fixtures) {
    it(`kind=${fx.kind}: body regex matches expected texts`, () => {
      const entry = DIALOG_KINDS[fx.kind];
      assert.ok(entry, `kind ${fx.kind} missing from DIALOG_KINDS`);
      for (const txt of fx.bodyHits) {
        assert.ok(entry.test.test(txt), `${fx.kind}.test should match "${txt}"`);
      }
    });
    it(`kind=${fx.kind}: primary regex matches expected buttons + rejects negatives`, () => {
      const entry = DIALOG_KINDS[fx.kind];
      for (const btn of fx.primaryHits) {
        assert.ok(entry.primary.test(btn), `${fx.kind}.primary should match "${btn}"`);
      }
      for (const miss of fx.primaryMisses) {
        assert.equal(entry.primary.test(miss), false, `${fx.kind}.primary should NOT match "${miss}"`);
      }
    });
  }

  it('all 5 kinds enumerated', () => {
    const expected = ['unsaved_changes', 'save_and_add_to_chart', 'overwrite_existing_study', 'save_as_new', 'compile_error_modal'];
    for (const k of expected) {
      assert.ok(DIALOG_KINDS[k], `missing kind ${k}`);
    }
  });
});
