/**
 * Offline failure-path unit tests for src/core/alerts.js via the `_deps`
 * injection seam. No live TradingView required.
 *
 * Covers:
 *   - create() THROWS when the dialog's Create button can't be found
 *     (the final evaluate resolves falsy) — the normalized failure contract.
 *   - create() succeeds when every page-side step resolves truthy.
 *   - deleteAlerts() deletes by id / array / delete_all via the pricealerts REST
 *     API, and THROWS when no target is given or the API returns non-ok.
 *   - list() THROWS on a page-side error instead of returning success-with-error.
 *
 * Run: node --test tests/alerts.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, deleteAlerts, list } from '../src/core/alerts.js';

// A scripted evaluate that classifies each page-side expression the rewritten
// create() issues and returns a canned result, plus a fake CDP client that
// records mouse/key input. This lets us exercise the open -> apply-condition ->
// verify -> price -> Create flow entirely offline, and simulate each failure
// (dialog won't open, condition control missing, option not offered, read-back
// mismatch, Create button missing) by flipping one flag.
function scriptedDeps({
  paneFound = true,
  dialogOpens = true,
  rowFound = true,
  optionFound = true,
  readback = 'Crossing',
  priceRectFound = true,
  priceReadback = undefined,   // undefined => echo whatever was typed (commits cleanly)
  createFound = true,
  msgTextarea = false,
} = {}) {
  const calls = [];
  const mouse = [];
  const keys = [];
  const typed = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    if (/chart-gui-wrapper|chart-markup-table|canvas/.test(expr)) return paneFound ? { x: 50, y: 50 } : null;
    if (/Add alert on/.test(expr)) return { x: 60, y: 60 };
    if (/!!document\.querySelector/.test(expr)) return dialogOpens;                       // dialog-present probe
    if (/operatorRow/.test(expr) && /getBoundingClientRect/.test(expr)) return rowFound ? { x: 70, y: 70 } : null;
    if (/\[role="option"\]/.test(expr)) return optionFound ? { x: 80, y: 80 } : null;     // option lookup by label
    if (/operatorRow/.test(expr) && /textContent/.test(expr)) return readback;            // condition read-back
    if (/textarea/.test(expr) && /getBoundingClientRect/.test(expr)) return msgTextarea ? { x: 85, y: 85 } : null;
    if (/input\[type="text"\]/.test(expr) && /getBoundingClientRect/.test(expr)) return priceRectFound ? { x: 88, y: 88 } : null;
    if (/input\[type="text"\]/.test(expr) && /\.value/.test(expr)) {                       // price read-back
      return priceReadback !== undefined ? priceReadback : (typed.length ? typed[typed.length - 1] : null);
    }
    if (/\^create\$/.test(expr)) return createFound ? { x: 90, y: 90 } : null;            // Create button rect
    return undefined;
  };
  const fakeClient = {
    Input: {
      dispatchMouseEvent: async (e) => { if (e.type === 'mousePressed') mouse.push(e); },
      dispatchKeyEvent: async (e) => { keys.push(e); },
      insertText: async (e) => { typed.push(e.text); },
    },
  };
  return { _deps: { evaluate, getClient: async () => fakeClient }, calls, mouse, keys, typed };
}

describe('alerts.create — applies and verifies the condition', () => {
  it('selects the requested condition and reports the read-back, not a blind echo', async () => {
    const { _deps, calls, typed } = scriptedDeps({ readback: 'Crossing' });
    const r = await create({ condition: 'crossing', price: 100, _deps });
    assert.equal(r.success, true);
    assert.equal(r.price, 100);
    assert.equal(r.condition_requested, 'crossing');   // what was asked
    assert.equal(r.condition, 'Crossing');             // what the dialog confirmed
    assert.equal(r.source, 'applied');
    assert.equal(r.price_set, true);
    // proves a condition-selection step actually ran (option lookup by label)
    assert.ok(calls.some(c => /\[role="option"\]/.test(c)), 'issued the condition-select evaluate');
    // proves the price was driven by trusted keyboard input, not a DOM write
    assert.ok(typed.includes('100'), 'typed the price into the dialog');
  });

  it('throws when the price did not commit (read-back differs from requested)', async () => {
    // the value field shows a different number than requested -> fail before Create
    const { _deps } = scriptedDeps({ priceReadback: '84,174.29' });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 75000, _deps }),
      /Alert price not applied/,
    );
  });

  it('throws when the price input is not found in the dialog', async () => {
    const { _deps } = scriptedDeps({ priceRectFound: false });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 100, _deps }),
      /Could not find the price input/,
    );
  });

  it('maps each enum value to the matching dialog label on read-back', async () => {
    const { _deps } = scriptedDeps({ readback: 'Crossing Down' });
    const r = await create({ condition: 'crossing_down', price: 5, _deps });
    assert.equal(r.condition_requested, 'crossing_down');
    assert.equal(r.condition, 'Crossing Down');
  });

  it('throws when the condition control is not in the dialog', async () => {
    const { _deps } = scriptedDeps({ rowFound: false });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 1, _deps }),
      /condition control not found/,
    );
  });

  it('throws when the requested option is not offered by this build', async () => {
    const { _deps } = scriptedDeps({ optionFound: false });
    await assert.rejects(
      () => create({ condition: 'crossing_up', price: 1, _deps }),
      /not offered by this TradingView build/,
    );
  });

  it('throws when the read-back does not match the requested condition', async () => {
    // requested crossing (label "Crossing") but the dialog reports "Crossing Up"
    const { _deps } = scriptedDeps({ readback: 'Crossing Up' });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 1, _deps }),
      /Alert condition not applied/,
    );
  });

  it('throws when the Create button is not found (after the condition is applied)', async () => {
    const { _deps } = scriptedDeps({ createFound: false });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 100, _deps }),
      /Could not find Create button/,
    );
  });

  it('throws when the dialog never opens', async () => {
    const { _deps } = scriptedDeps({ dialogOpens: false });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 1, _deps }),
      /Could not open the alert dialog/,
    );
  });
});

describe('alerts.deleteAlerts — REST deletion via pricealerts API', () => {
  // Scripted evaluateAsync: classifies list_alerts vs delete_alerts by URL.
  function delDeps({ listAlerts = [], deleteResult = { s: 'ok' } } = {}) {
    const calls = [];
    const evaluateAsync = async (expr) => {
      calls.push(expr);
      if (/list_alerts/.test(expr)) return { alerts: listAlerts };
      if (/delete_alerts/.test(expr)) return deleteResult;
      return undefined;
    };
    return { _deps: { evaluateAsync }, calls };
  }

  it('throws when no target (no alert_ids, no delete_all) is given', async () => {
    const { _deps } = delDeps();
    await assert.rejects(
      () => deleteAlerts({ _deps }),
      /Pass alert_ids \(one id or an array\) or delete_all:true/,
    );
  });

  it('deletes a single id and reports it, issuing the payload-wrapped POST', async () => {
    const { _deps, calls } = delDeps({ deleteResult: { s: 'ok' } });
    const r = await deleteAlerts({ alert_ids: 123, _deps });
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 1);
    assert.deepEqual(r.deleted_ids, [123]);
    assert.equal(r.source, 'pricealerts_api');
    const del = calls.find(c => /delete_alerts/.test(c));
    assert.ok(/payload/.test(del) && /alert_ids/.test(del) && /\[123\]/.test(del), 'sends {payload:{alert_ids:[123]}}');
    assert.ok(/text\/plain/.test(del), 'uses text/plain content-type');
  });

  it('deletes an array of ids', async () => {
    const { _deps } = delDeps();
    const r = await deleteAlerts({ alert_ids: [1, 2, 3], _deps });
    assert.equal(r.deleted_count, 3);
    assert.deepEqual(r.deleted_ids, [1, 2, 3]);
  });

  it('delete_all lists then deletes every id', async () => {
    const { _deps, calls } = delDeps({ listAlerts: [{ alert_id: 11 }, { alert_id: 22 }] });
    const r = await deleteAlerts({ delete_all: true, _deps });
    assert.equal(r.deleted_count, 2);
    assert.deepEqual(r.deleted_ids, [11, 22]);
    assert.ok(calls.some(c => /list_alerts/.test(c)), 'listed first');
    assert.ok(calls.some(c => /delete_alerts/.test(c) && /\[11,22\]/.test(c.replace(/\s/g, ''))), 'bulk-deleted');
  });

  it('delete_all with no alerts succeeds with deleted_count 0 and skips the delete call', async () => {
    const { _deps, calls } = delDeps({ listAlerts: [] });
    const r = await deleteAlerts({ delete_all: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 0);
    assert.ok(!calls.some(c => /delete_alerts/.test(c)), 'no delete issued when nothing to delete');
  });

  it('throws when the REST call returns a non-ok status', async () => {
    const { _deps } = delDeps({ deleteResult: { s: 'error', errmsg: 'invalid_request' } });
    await assert.rejects(() => deleteAlerts({ alert_ids: 7, _deps }), /delete_alerts failed: invalid_request/);
  });

  it('throws on a transport error from the page fetch', async () => {
    const { _deps } = delDeps({ deleteResult: { error: 'Failed to fetch' } });
    await assert.rejects(() => deleteAlerts({ alert_ids: 7, _deps }), /Failed to fetch/);
  });
});

describe('alerts.list — throws instead of success-with-error', () => {
  it('throws when the page payload carries an error', async () => {
    const _deps = { evaluateAsync: async () => ({ alerts: [], error: 'list_alerts failed: 503' }) };
    await assert.rejects(() => list({ _deps }), /list_alerts failed: 503/);
  });

  it('returns the success shape with no error field on the happy path', async () => {
    const _deps = { evaluateAsync: async () => ({ alerts: [{ alert_id: 1 }, { alert_id: 2 }] }) };
    const r = await list({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.alert_count, 2);
    assert.ok(!('error' in r), 'no embedded error field on success');
  });
});
