/**
 * Offline unit tests for the input-validation hardening (harden-input-validation).
 *
 * Covers the pure, importable pieces:
 *   - parseJsonArg()    — defensive JSON parsing with a friendly error
 *   - mapKey()          — keyboard key → DOM code/vk mapping (digits, letters, named)
 *   - assertBatchSize() — total-iteration cap for batchRun
 *   - safeString()      — selector-value sanitization is the canonical escaper
 *   - z.enum behaviour  — finite-value args reject typos / accept valid values
 *
 * No TradingView connection required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseJsonArg, safeString } from '../src/connection.js';
import { mapKey } from '../src/core/ui.js';
import { assertBatchSize, MAX_BATCH_ITERATIONS } from '../src/core/batch.js';

// --- parseJsonArg -----------------------------------------------------------

test('parseJsonArg returns undefined for nullish input', () => {
  assert.equal(parseJsonArg(undefined, 'inputs'), undefined);
  assert.equal(parseJsonArg(null, 'inputs'), undefined);
});

test('parseJsonArg passes through non-string objects untouched', () => {
  const obj = { length: 20 };
  assert.equal(parseJsonArg(obj, 'inputs'), obj);
});

test('parseJsonArg parses valid JSON strings', () => {
  assert.deepEqual(parseJsonArg('{"length":20}', 'inputs'), { length: 20 });
  assert.deepEqual(parseJsonArg('[1,2,3]', 'inputs'), [1, 2, 3]);
});

test('parseJsonArg throws a friendly error (not raw SyntaxError) on malformed JSON', () => {
  assert.throws(
    () => parseJsonArg('{not valid json', 'inputs'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(/inputs must be valid JSON/.test(err.message), `message was: ${err.message}`);
      assert.ok(!/SyntaxError/.test(err.message));
      return true;
    },
  );
});

test('parseJsonArg truncates the preview of long malformed input', () => {
  const long = '{' + 'x'.repeat(200);
  assert.throws(() => parseJsonArg(long, 'overrides'), (err) => {
    assert.ok(err.message.includes('…'));
    assert.ok(err.message.length < 120);
    return true;
  });
});

// --- mapKey -----------------------------------------------------------------

test('mapKey maps digits to Digit<n> (not Key<n>)', () => {
  assert.deepEqual(mapKey('1'), { code: 'Digit1', vk: '1'.charCodeAt(0) });
  assert.deepEqual(mapKey('0'), { code: 'Digit0', vk: '0'.charCodeAt(0) });
});

test('mapKey maps single letters to Key<X> uppercase with correct vk', () => {
  assert.deepEqual(mapKey('a'), { code: 'KeyA', vk: 65 });
  assert.deepEqual(mapKey('Z'), { code: 'KeyZ', vk: 90 });
});

test('mapKey maps named keys', () => {
  assert.deepEqual(mapKey('Enter'), { code: 'Enter', vk: 13 });
  assert.deepEqual(mapKey('Escape'), { code: 'Escape', vk: 27 });
  assert.deepEqual(mapKey('ArrowUp'), { code: 'ArrowUp', vk: 38 });
  assert.deepEqual(mapKey('F12'), { code: 'F12', vk: 123 });
});

test('mapKey returns null for unsupported keys', () => {
  assert.equal(mapKey('ctrl+s'), null);
  assert.equal(mapKey('SuperFakeKey'), null);
  assert.equal(mapKey('ab'), null);
  assert.equal(mapKey(''), null);
  assert.equal(mapKey(undefined), null);
});

// --- assertBatchSize --------------------------------------------------------

test('assertBatchSize allows sweeps at or under the cap', () => {
  assert.equal(assertBatchSize(['A', 'B', 'C'], ['D', '60']), 6);
  assert.equal(assertBatchSize(['A'], undefined), 1);
  assert.equal(assertBatchSize(['A'], []), 1);
});

test('assertBatchSize throws when symbols × timeframes exceeds the cap', () => {
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  const timeframes = Array.from({ length: 10 }, (_, i) => `${i}`);
  assert.throws(
    () => assertBatchSize(symbols, timeframes),
    (err) => {
      assert.ok(/Batch too large/.test(err.message));
      assert.ok(err.message.includes(String(MAX_BATCH_ITERATIONS)));
      return true;
    },
  );
});

// --- safeString (selector sanitization) -------------------------------------

test('safeString produces a quoted JS string literal that cannot break out', () => {
  // A value crafted to terminate a selector / inject extra queries.
  const malicious = 'x"]'; // would close [attr="..."] and inject if unescaped
  const lit = safeString(malicious);
  // It is a valid JS string literal whose parsed value round-trips exactly.
  assert.equal(JSON.parse(lit), malicious);
  // The literal is wrapped in quotes (so it is a string, not bare code).
  assert.equal(lit[0], '"');
  assert.equal(lit[lit.length - 1], '"');
});

test('safeString neutralizes backticks, backslashes and newlines', () => {
  const v = 'a`b\\c\n d"';
  assert.equal(JSON.parse(safeString(v)), v);
});

// --- z.enum behaviour for finite-value args ---------------------------------

test('z.enum rejects an out-of-set action and accepts a valid one', () => {
  const action = z.enum(['screenshot', 'get_ohlcv', 'get_strategy_results']);
  assert.throws(() => action.parse('screenshto')); // typo
  assert.equal(action.parse('screenshot'), 'screenshot');
});

test('numeric .max() bound rejects over-cap and accepts in-range', () => {
  const count = z.coerce.number().int().positive().max(500);
  assert.throws(() => count.parse('501'));
  assert.equal(count.parse('100'), 100);
  assert.throws(() => count.parse('0'));      // not positive
  assert.throws(() => count.parse('abc'));    // NaN
});

test('array .max() bound rejects oversized arrays', () => {
  const symbols = z.array(z.string()).max(20);
  assert.throws(() => symbols.parse(Array.from({ length: 21 }, () => 'X')));
  assert.equal(symbols.parse(['A', 'B']).length, 2);
});
