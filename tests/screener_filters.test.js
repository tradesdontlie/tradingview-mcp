/**
 * Tests for src/core/screener_filters.js — list, remove, clear + stretch stubs.
 * All tests use dependency injection; no live TradingView required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { list, remove, clear, add, modify } from '../src/core/screener_filters.js';

// ── mock evaluate ───────────────────────────────────────────────────────

function mockEvaluate(handler) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    return handler(expr, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

// Common helpers to script typical flows ────────────────────────────────

function closedScreener() {
  // Any LIST_EXPR returns null when screener closed.
  return mockEvaluate((expr) => {
    if (/screenerContainer/.test(expr)) return null;
    return null;
  });
}

// ── list() ──────────────────────────────────────────────────────────────

describe('screener_filters.list()', () => {
  it('returns not-open result when screener is closed', async () => {
    const evaluate = closedScreener();
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.action, 'list');
    assert.equal(r.open, false);
    assert.match(r.error, /not open/i);
  });

  it('returns the pill list when screener is open', async () => {
    const pills = [
      { label: 'Price', id: 'screener-filter-pill-abc' },
      { label: 'Market cap', id: 'screener-filter-pill-def' },
    ];
    const evaluate = mockEvaluate(() => pills);
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'list');
    assert.equal(r.count, 2);
    assert.deepEqual(r.filters, pills);
  });

  it('returns empty list when screener has no pills', async () => {
    const evaluate = mockEvaluate(() => []);
    const r = await list({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.count, 0);
    assert.deepEqual(r.filters, []);
  });
});

// ── remove() ────────────────────────────────────────────────────────────

/**
 * Build a content-matching mock so the tests are stable across call-order
 * changes (e.g., the pre-click popover cleanup adds probes we don't want to
 * count by index).
 */
function scriptedEvaluate({ open = true, listBefore = [], listAfter = [], clickResult, removeResult }) {
  return mockEvaluate((expr) => {
    // IS_OPEN_EXPR check
    if (/return !!visible/.test(expr)) return open;
    // closeAnyPopover: probe-any-visible-popover → return false to skip click
    if (/\[class\*="popover"\]/.test(expr) && /return true/.test(expr) && !/remove-button/.test(expr)) return false;
    // LIST_EXPR
    if (/screener-filter-pill-/.test(expr) && /out\.push/.test(expr)) {
      // First call returns before, subsequent calls return after
      if (!scriptedEvaluate._state.listCallCount) scriptedEvaluate._state.listCallCount = 0;
      scriptedEvaluate._state.listCallCount++;
      return scriptedEvaluate._state.listCallCount === 1 ? listBefore : listAfter;
    }
    // Click-match expression (the pill-match click in remove())
    if (/pills\.length/.test(expr) && /match\.click/.test(expr)) return clickResult;
    // Remove button search
    if (/popover-header-remove-button/.test(expr)) return removeResult;
    return null;
  });
}
// Reset state between tests
function resetState() { scriptedEvaluate._state = { listCallCount: 0 }; }

describe('screener_filters.remove()', () => {
  it('throws when filter argument is missing or empty', async () => {
    resetState();
    const evaluate = scriptedEvaluate({});
    await assert.rejects(() => remove({ _deps: { evaluate } }), /non-empty/);
    await assert.rejects(() => remove({ filter: '', _deps: { evaluate } }), /non-empty/);
    await assert.rejects(() => remove({ filter: '   ', _deps: { evaluate } }), /non-empty/);
  });

  it('throws "not open" when screener is closed', async () => {
    resetState();
    const evaluate = scriptedEvaluate({ open: false });
    await assert.rejects(() => remove({ filter: 'Price', _deps: { evaluate } }), /not open/i);
  });

  it('is idempotent when the named filter does not exist', async () => {
    resetState();
    const evaluate = scriptedEvaluate({
      listBefore: [{ label: 'Price', id: 'p1' }],
      clickResult: { found: false },
    });
    const r = await remove({ filter: 'DoesNotExist', _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'remove');
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.remaining, ['Price']);
    assert.match(r.note, /not found/);
  });

  it('sanitizes filter name (safeString) in DOM query', async () => {
    resetState();
    const captured = [];
    const evaluate = mockEvaluate((expr) => {
      captured.push(expr);
      if (/return !!visible/.test(expr)) return true;
      if (/\[class\*="popover"\]/.test(expr) && /return true/.test(expr) && !/remove-button/.test(expr)) return false;
      if (/screener-filter-pill-/.test(expr) && /out\.push/.test(expr)) return [];
      if (/pills\.length/.test(expr) && /match\.click/.test(expr)) return { found: false };
      return null;
    });
    const payload = `"); alert('xss'); ("`;
    await remove({ filter: payload, _deps: { evaluate } });
    // Find the click-match expression — must contain the JSON-stringified payload
    const clickExpr = captured.find(e => /pills\.length/.test(e) && /match\.click/.test(e));
    assert.ok(clickExpr, 'click expression was dispatched');
    const safe = JSON.stringify(payload.trim().toLowerCase());
    assert.ok(clickExpr.includes(safe),
      'payload must be inlined via safeString/JSON.stringify');
    assert.equal(safe[0], '"');
    assert.equal(safe[safe.length - 1], '"');
  });

  it('happy path: clicks pill, clicks remove button, returns diff', async () => {
    resetState();
    const evaluate = scriptedEvaluate({
      listBefore: [
        { label: 'Price', id: 'p1' },
        { label: 'Market cap', id: 'p2' },
        { label: 'Beta', id: 'p3' },
      ],
      listAfter: [
        { label: 'Price', id: 'p1' },
        { label: 'Market cap', id: 'p2' },
      ],
      clickResult: { found: true, matchedLabel: 'Beta' },
      removeResult: { ok: true },
    });
    const r = await remove({ filter: 'Beta', _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'remove');
    assert.equal(r.filter, 'Beta');
    assert.deepEqual(r.removed, ['Beta']);
    assert.deepEqual(r.remaining, ['Price', 'Market cap']);
  });

  it('returns non-throwing "not_removable" when popover has no remove button (market-source pill)', async () => {
    resetState();
    const evaluate = scriptedEvaluate({
      listBefore: [{ label: 'Index', id: 'p1' }],
      clickResult: { found: true, matchedLabel: 'Index' },
      removeResult: { ok: false, reason: 'no_remove_button' },
    });
    const r = await remove({ filter: 'Index', _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'not_removable');
    assert.deepEqual(r.removed, []);
    assert.match(r.hint, /market source/i);
  });

  it('throws when no popover appears at all', async () => {
    resetState();
    const evaluate = scriptedEvaluate({
      listBefore: [{ label: 'Beta', id: 'p1' }],
      clickResult: { found: true, matchedLabel: 'Beta' },
      removeResult: { ok: false, reason: 'no_popover' },
    });
    await assert.rejects(
      () => remove({ filter: 'Beta', _deps: { evaluate } }),
      /no_popover/,
    );
  });
});

// ── clear() ─────────────────────────────────────────────────────────────

describe('screener_filters.clear()', () => {
  it('throws "not open" when screener is closed', async () => {
    const evaluate = mockEvaluate(() => false);
    await assert.rejects(() => clear({ _deps: { evaluate } }), /not open/i);
  });

  it('is a no-op when there are no pills', async () => {
    const evaluate = mockEvaluate((expr, idx) => {
      if (idx === 0) return true;              // assertOpen
      if (idx === 1) return [];                // LIST (before)
      if (idx === 2) return [];                // LIST (loop iter 1) → empty, break
      if (idx === 3) return [];                // LIST (after)
      return null;
    });
    const r = await clear({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'clear');
    assert.equal(r.removed_count, 0);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.remaining, []);
  });

  it('removes pills one-by-one until empty', async () => {
    let pills = [
      { label: 'Price', id: 'p1' },
      { label: 'Beta', id: 'p2' },
    ];
    const evaluate = mockEvaluate((expr) => {
      // assertOpen
      if (/screenerContainer/.test(expr) && /return !!visible/.test(expr)) return true;
      // LIST_EXPR — returns current pills (clone to avoid mutation aliasing)
      if (/screener-filter-pill-/.test(expr) && /out\.push/.test(expr)) return pills.map(p => ({...p}));
      // Pill click by id (now uses data-name selector)
      if (/document\.querySelector\('\[data-name="/.test(expr)) {
        if (pills.length === 0) return { found: false };
        return { found: true, label: pills[0].label };
      }
      // Remove button click
      if (/popover-header-remove-button/.test(expr)) {
        pills = pills.slice(1);
        return { ok: true };
      }
      return null;
    });
    const r = await clear({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.removed_count, 2);
    assert.deepEqual(r.removed.sort(), ['Beta', 'Price']);
    assert.deepEqual(r.remaining, []);
  });

  it('skips non-removable pills and continues (no infinite loop)', async () => {
    // "Index" has no remove button — clear should skip it and succeed on the rest.
    let pills = [
      { label: 'Index', id: 'p1' },
      { label: 'Price', id: 'p2' },
    ];
    let lastClicked = null;
    const evaluate = mockEvaluate((expr) => {
      if (/screenerContainer/.test(expr) && /return !!visible/.test(expr)) return true;
      if (/screener-filter-pill-/.test(expr) && /out\.push/.test(expr)) return pills.map(p => ({...p}));
      if (/document\.querySelector\('\[data-name="/.test(expr)) {
        if (expr.includes('"p1"')) { lastClicked = 'Index'; return { found: true, label: 'Index' }; }
        if (expr.includes('"p2"')) { lastClicked = 'Price'; return { found: true, label: 'Price' }; }
        return { found: false };
      }
      if (/popover-header-remove-button/.test(expr)) {
        if (lastClicked === 'Index') return { ok: false };
        if (lastClicked === 'Price') {
          pills = pills.filter(p => p.label !== 'Price');
          return { ok: true };
        }
        return { ok: false };
      }
      return null;
    });
    const r = await clear({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.removed_count, 1);
    assert.deepEqual(r.removed, ['Price']);
    assert.deepEqual(r.remaining, ['Index']);
    assert.deepEqual(r.skipped, ['Index']);
  });
});

// ── stretch stubs ───────────────────────────────────────────────────────

describe('screener_filters stretch actions', () => {
  it('add returns not_implemented_yet with hint when screener is open', async () => {
    const evaluate = mockEvaluate(() => []);
    const r = await add({ filter: 'Price', _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'not_implemented_yet');
    assert.ok(r.hint);
  });

  it('add returns not-open result when screener is closed', async () => {
    const evaluate = mockEvaluate(() => null);
    const r = await add({ filter: 'Price', _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.open, false);
  });

  it('modify returns not_implemented_yet with hint when screener is open', async () => {
    const evaluate = mockEvaluate(() => []);
    const r = await modify({ filter: 'Price', value: 100, _deps: { evaluate } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'not_implemented_yet');
  });
});
