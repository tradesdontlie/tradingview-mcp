/**
 * Tests for src/core/screener_screens.js — active, menu_actions, save + stretch stubs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  active,
  menu_actions,
  save,
  list,
  switchTo,
  save_as,
  remove,
  rename,
  createNew,
} from '../src/core/screener_screens.js';

function mockEvaluate(handler) {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return handler(expr, calls.length - 1); };
  fn.calls = calls;
  return fn;
}

// ── active() ────────────────────────────────────────────────────────────

describe('screener_screens.active()', () => {
  it('returns not-open when closed', async () => {
    const evaluate = mockEvaluate(() => null);
    const r = await active({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.open, false);
  });

  it('returns the current screen name', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await active({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'active');
    assert.equal(r.screen, 'All stocks');
  });

  it('surfaces no_title error from probe', async () => {
    const evaluate = mockEvaluate(() => ({ error: 'no_title' }));
    const r = await active({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'no_title');
  });
});

// ── menu_actions() ──────────────────────────────────────────────────────

describe('screener_screens.menu_actions()', () => {
  it('throws "not open" when screener is closed', async () => {
    const evaluate = mockEvaluate(() => false);
    await assert.rejects(() => menu_actions({ _deps: { evaluate } }), /not open/i);
  });

  it('returns available/disabled action split', async () => {
    const items = [
      { qaId: 'screener-screen-actions-save-screen', label: 'Save screen', disabled: false },
      { qaId: 'screener-screen-actions-share-screen', label: 'Share screen', disabled: true },
      { qaId: 'screener-screen-actions-save-screen-as', label: 'Make a copy…', disabled: false },
      { qaId: 'screener-screen-actions-rename-screen', label: 'Rename…', disabled: true },
    ];
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;                          // assertOpen
      if (idx === 1) return null;                          // open menu click
      if (idx === 2) return { items };                     // snapshot
      if (idx === 3) return null;                          // dismiss
      return null;
    });
    const r = await menu_actions({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.deepEqual(r.available, ['Save screen', 'Make a copy…']);
    assert.deepEqual(r.disabled, ['Share screen', 'Rename…']);
  });

  it('throws descriptive error if the menu never opens', async () => {
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;
      if (idx === 1) return null;
      if (idx === 2) return { err: 'menu_not_found' };
      return null;
    });
    await assert.rejects(() => menu_actions({ _deps: { evaluate } }), /menu_not_found/);
  });
});

// ── save() ──────────────────────────────────────────────────────────────

describe('screener_screens.save()', () => {
  it('throws "not open" when screener is closed', async () => {
    const evaluate = mockEvaluate(() => false);
    await assert.rejects(() => save({ _deps: { evaluate } }), /not open/i);
  });

  it('returns saved=true when save action is clicked', async () => {
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;                   // assertOpen
      if (idx === 1) return null;                   // open menu
      if (idx === 2) return { clicked: true };      // click save
      return null;
    });
    const r = await save({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.saved, true);
    assert.equal(r.action, 'save');
  });

  it('returns saved=false with hint when save is disabled', async () => {
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;
      if (idx === 1) return null;
      if (idx === 2) return { clicked: false, reason: 'item_disabled' };
      return null;
    });
    const r = await save({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.saved, false);
    assert.equal(r.reason, 'item_disabled');
    assert.match(r.hint, /built-in preset|unsaved changes/i);
  });

  it('returns saved=false with reason when menu item is missing', async () => {
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;
      if (idx === 1) return null;
      if (idx === 2) return { clicked: false, reason: 'item_not_found' };
      return null;
    });
    const r = await save({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.saved, false);
    assert.equal(r.reason, 'item_not_found');
  });

  it('includes "screener-screen-actions-save-screen" qa-id in the click expression', async () => {
    const captured = [];
    const evaluate = mockEvaluate((expr, idx) => {
      captured.push(expr);
      if (idx === 0) return true;
      if (idx === 1) return null;
      if (idx === 2) return { clicked: true };
      return null;
    });
    await save({ _deps: { evaluate } });
    // The third call is the click expression — must include the qa-id.
    assert.ok(captured[2].includes('screener-screen-actions-save-screen'),
      'expression references save-screen qa-id');
    // And must use JSON-stringified form via safeString.
    assert.ok(captured[2].includes('"screener-screen-actions-save-screen"'));
  });
});

// ── stretch stubs ───────────────────────────────────────────────────────

describe('screener_screens stretch actions', () => {
  it('list returns not-open when closed', async () => {
    const evaluate = mockEvaluate(() => null);
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.open, false);
  });

  it('list returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'not_implemented_yet');
    assert.ok(r.hint);
  });

  it('switchTo returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await switchTo({ name: 'Pre-market gainers', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('save_as returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await save_as({ name: 'My screen', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('remove returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await remove({ name: 'Old screen', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('rename returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await rename({ name: 'Old', new_name: 'New', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });

  it('createNew returns not_implemented_yet when open', async () => {
    const evaluate = mockEvaluate(() => ({ name: 'All stocks' }));
    const r = await createNew({ name: 'New screen', _deps: { evaluate } });
    assert.equal(r.error, 'not_implemented_yet');
  });
});
