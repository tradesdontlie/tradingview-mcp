/**
 * Tests for manageIndicator input application in src/core/chart.js (#249).
 * Verifies that inputs are applied post-create via setInputValues (not the
 * unreliable createStudy 4th arg) and that unknown keys are reported.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manageIndicator } from '../src/core/chart.js';

// A mock evaluate that simulates a chart with one study whose inputs are
// getInputValues/setInputValues-backed. Tracks the study's current inputs.
function mockChart({ defaults }) {
  const state = { studyInputs: defaults.map((d) => ({ ...d })), created: false };
  const evaluate = async (expr) => {
    if (/getAllStudies\(\)\.map/.test(expr)) {
      return state.created ? ['study_1'] : [];
    }
    if (/createStudy/.test(expr)) { state.created = true; return undefined; }
    if (/getInputValues[\s\S]*setInputValues/.test(expr)) {
      // Emulate the applied-inputs IIFE: parse the overrides object literal.
      const m = expr.match(/var overrides = (\{[\s\S]*?\});/);
      const overrides = m ? JSON.parse(m[1]) : {};
      const applied = {}, unknown = [];
      const ids = new Set(state.studyInputs.map((i) => i.id));
      for (const k of Object.keys(overrides)) {
        if (ids.has(k)) { state.studyInputs.find((i) => i.id === k).value = overrides[k]; applied[k] = overrides[k]; }
        else unknown.push(k);
      }
      const confirmed = {};
      for (const i of state.studyInputs) if (k_in(applied, i.id)) confirmed[i.id] = i.value;
      return { confirmed, unknown };
    }
    return undefined;
  };
  const k_in = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  return { _deps: { evaluate }, state };
}

describe('manageIndicator add — input application (#249)', () => {
  it('applies overrides and confirms them via read-back', async () => {
    const { _deps, state } = mockChart({ defaults: [{ id: 'length', value: 9 }, { id: 'source', value: 'close' }] });
    const r = await manageIndicator({ action: 'add', indicator: 'Moving Average Exponential', inputs: JSON.stringify({ length: 99, source: 'open' }), _deps });
    assert.equal(r.success, true);
    assert.equal(r.entity_id, 'study_1');
    assert.deepEqual(r.inputs.applied, { length: 99, source: 'open' });
    assert.equal(state.studyInputs.find((i) => i.id === 'length').value, 99);
  });

  it('reports unknown input keys without failing', async () => {
    const { _deps } = mockChart({ defaults: [{ id: 'length', value: 9 }] });
    const r = await manageIndicator({ action: 'add', indicator: 'X', inputs: JSON.stringify({ length: 20, bogus: 5 }), _deps });
    assert.deepEqual(r.inputs.applied, { length: 20 });
    assert.deepEqual(r.inputs.unknown_inputs, ['bogus']);
  });

  it('adds without inputs cleanly (no inputs field)', async () => {
    const { _deps } = mockChart({ defaults: [{ id: 'length', value: 9 }] });
    const r = await manageIndicator({ action: 'add', indicator: 'Volume', _deps });
    assert.equal(r.success, true);
    assert.equal(r.inputs, undefined);
  });
});
