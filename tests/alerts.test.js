/**
 * Tests for src/core/alerts.js.
 * Focus: the delete_all confirmation guard (irreversible bulk delete must not fire
 * from a bare boolean), plus create validation and dependency injection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, list, deleteAlerts, DELETE_ALL_CONFIRMATION } from '../src/core/alerts.js';
import { getRegisteredHandler } from '../src/cli/router.js';
import '../src/cli/commands/alerts.js';

// Build DI deps with spies. evaluate handles create/delete; evaluateAsync handles list.
function mockDeps({ alerts = [], deleteOk = true } = {}) {
  const state = { evaluateCalls: 0, evaluateAsyncCalls: 0, lastDeleteIds: null };
  const deps = {
    evaluate: async (js) => {
      state.evaluateCalls++;
      if (js.includes('delete_alerts')) {
        const m = js.match(/alert_ids:\s*(\[[^\]]*\])/);
        state.lastDeleteIds = m ? JSON.parse(m[1]) : null;
        return { ok: deleteOk, status: deleteOk ? 200 : 500, response: '' };
      }
      // create path
      return { success: true, source: 'internal_api', alert_id: 999 };
    },
    evaluateAsync: async () => {
      state.evaluateAsyncCalls++;
      return { alerts };
    },
  };
  return { deps, state };
}

describe('deleteAlerts() — bulk delete confirmation guard', () => {
  it('refuses delete_all without a confirmation token, before any network call', async () => {
    const { deps, state } = mockDeps({ alerts: [{ alert_id: 1 }, { alert_id: 2 }] });
    const r = await deleteAlerts({ delete_all: true, _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /confirmation/i);
    assert.equal(state.evaluateCalls, 0, 'no delete request issued');
    assert.equal(state.evaluateAsyncCalls, 0, 'not even the list request issued');
  });

  it('refuses delete_all with a near-match confirmation token', async () => {
    for (const confirm of [DELETE_ALL_CONFIRMATION.toLowerCase(), `${DELETE_ALL_CONFIRMATION} `, 'true', 'yes']) {
      const { deps, state } = mockDeps({ alerts: [{ alert_id: 1 }] });
      const r = await deleteAlerts({ delete_all: true, confirm, _deps: deps });
      assert.equal(r.success, false);
      assert.equal(state.evaluateCalls, 0);
    }
  });

  it('deletes all alerts with the exact confirmation token', async () => {
    const { deps, state } = mockDeps({ alerts: [{ alert_id: 1 }, { alert_id: 2 }, { alert_id: 3 }] });
    const r = await deleteAlerts({ delete_all: true, confirm: DELETE_ALL_CONFIRMATION, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 3);
    assert.deepEqual(r.alert_ids, [1, 2, 3]);
    assert.deepEqual(state.lastDeleteIds, [1, 2, 3]);
    assert.equal(state.evaluateAsyncCalls, 1, 'listed once to resolve ids');
  });

  it('deletes a single alert by id without any confirmation token', async () => {
    const { deps, state } = mockDeps();
    const r = await deleteAlerts({ alert_id: 42, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 1);
    assert.deepEqual(state.lastDeleteIds, [42]);
    assert.equal(state.evaluateAsyncCalls, 0, 'no list needed for a targeted delete');
  });

  it('reports when there is nothing to delete', async () => {
    const { deps } = mockDeps();
    const r = await deleteAlerts({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /Provide delete_all/);
  });
});

describe('create() — validation and DI', () => {
  it('rejects a non-finite price before touching the page', async () => {
    const { deps, state } = mockDeps();
    await assert.rejects(() => create({ price: 'not-a-number', _deps: deps }), /finite number/);
    assert.equal(state.evaluateCalls, 0);
  });

  it('passes a valid alert through the injected evaluate', async () => {
    const { deps, state } = mockDeps();
    const r = await create({ condition: 'greater_than', price: 100, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(state.evaluateCalls, 1);
  });
});

describe('list() — DI', () => {
  it('reports the injected alert set', async () => {
    const { deps } = mockDeps({ alerts: [{ alert_id: 7 }, { alert_id: 8 }] });
    const r = await list({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.alert_count, 2);
  });
});

describe('alert delete — registered CLI boundary', () => {
  it('refuses --all without --confirm before any network call', async () => {
    const { deps, state } = mockDeps({ alerts: [{ alert_id: 1 }] });
    const handler = getRegisteredHandler('alert', 'delete');
    const r = await handler({ all: true }, [], deps);
    assert.equal(r.success, false);
    assert.match(r.error, /confirmation/i);
    assert.equal(state.evaluateCalls, 0);
    assert.equal(state.evaluateAsyncCalls, 0);
  });

  it('deletes all through the CLI with the exact --confirm token', async () => {
    const { deps } = mockDeps({ alerts: [{ alert_id: 1 }, { alert_id: 2 }] });
    const handler = getRegisteredHandler('alert', 'delete');
    const r = await handler({ all: true, confirm: DELETE_ALL_CONFIRMATION }, [], deps);
    assert.equal(r.success, true);
    assert.equal(r.deleted_count, 2);
  });
});
