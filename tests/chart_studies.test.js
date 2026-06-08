/**
 * Unit tests for chart_manage_indicator study-input formatting.
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/chart_studies.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manageIndicator } from '../src/core/chart.js';

// Mock evaluate that records expressions and returns scripted study-id lists so
// the add() path resolves a new entity without a live chart.
function mockDeps() {
  const calls = [];
  let studyListCount = 0;
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('getAllStudies')) {
      // 1st call (before) → none; later (after) → one new study
      return studyListCount++ === 0 ? [] : ['study_new'];
    }
    return undefined;
  };
  evaluate.calls = calls;
  return { _deps: { evaluate, evaluateAsync: evaluate, waitForChartReady: async () => true, getChartApi: async () => 'window.__api' }, evaluate };
}

const createCall = (evaluate) => evaluate.calls.find((c) => c.includes('createStudy'));

describe('manageIndicator() — study input formatting', () => {
  it('passes inputs as a { key: value } object, not [{ id, value }]', async () => {
    const { _deps, evaluate } = mockDeps();
    await manageIndicator({ action: 'add', indicator: 'Moving Average', inputs: '{"length":50}', _deps });
    const call = createCall(evaluate);
    assert.ok(call, 'a createStudy expression should be emitted');
    assert.match(call, /\{"length":50\}/);          // object form
    assert.doesNotMatch(call, /"id":"length"/);      // not the ignored [{id,value}] form
  });

  it('accepts an already-parsed object for inputs', async () => {
    const { _deps, evaluate } = mockDeps();
    await manageIndicator({ action: 'add', indicator: 'Moving Average', inputs: { length: 200 }, _deps });
    assert.match(createCall(evaluate), /\{"length":200\}/);
  });

  it('emits an empty object when no inputs are given', async () => {
    const { _deps, evaluate } = mockDeps();
    await manageIndicator({ action: 'add', indicator: 'Volume', _deps });
    const call = createCall(evaluate);
    assert.match(call, /createStudy\([\s\S]*\{\}\)/);
    assert.doesNotMatch(call, /\[\{/);
  });

  it('reports the newly created study id', async () => {
    const { _deps } = mockDeps();
    const res = await manageIndicator({ action: 'add', indicator: 'Moving Average', inputs: '{"length":50}', _deps });
    assert.equal(res.success, true);
    assert.equal(res.entity_id, 'study_new');
  });

  it('remove requires an entity_id', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => manageIndicator({ action: 'remove', _deps }), /entity_id required/);
  });
});
