import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lookupBuiltin, V6_ENUM_MEMBERS } from '../../src/core/v6_reference.js';

/**
 * C12 / A1-F12: pine_v6_reference must return enum members for builtins
 * that have closed enum string parameters (request.earnings field).
 */
describe('v6_reference — request.earnings.field enum (C12)', () => {
  it('lookupBuiltin(request.earnings) returns enums.field', () => {
    const r = lookupBuiltin('request.earnings');
    assert.equal(r.found, true);
    assert.equal(r.name, 'request.earnings');
    assert.ok(r.enums, 'expected enums field');
    assert.deepEqual(r.enums.field.valid, ['earnings.actual', 'earnings.estimate', 'earnings.standardized']);
    const acpMistake = r.enums.field.common_mistakes.find(m => m.tried === 'earnings.actual_period');
    assert.ok(acpMistake, 'expected actual_period to be a documented common mistake');
    assert.match(acpMistake.fix, /actual_period|request\.financial/);
  });

  it('V6_ENUM_MEMBERS exports the enum map directly for static callers', () => {
    assert.ok(V6_ENUM_MEMBERS['request.earnings']);
    assert.deepEqual(V6_ENUM_MEMBERS['request.earnings'].field.valid, ['earnings.actual', 'earnings.estimate', 'earnings.standardized']);
    assert.ok(V6_ENUM_MEMBERS['request.dividends']);
    assert.deepEqual(V6_ENUM_MEMBERS['request.dividends'].field.valid, ['dividends.gross', 'dividends.net']);
  });

  it('lookupBuiltin still works for functions without enums (no .enums field)', () => {
    const r = lookupBuiltin('ta.rsi');
    assert.equal(r.found, true);
    assert.equal(r.enums, undefined);
  });
});
