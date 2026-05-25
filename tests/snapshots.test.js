// Smoke tests for snapshot tools (Yahoo Finance backed)
// node --test tests/snapshots.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yahoo from '../src/core/yahoo.js';

test('getPrice — known stock returns expected shape', async () => {
  const result = await yahoo.getPrice('AAPL');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.source, 'Yahoo Finance');
  assert.ok(typeof result.timestamp === 'string');
  if (!result.error) {
    assert.ok(typeof result.price === 'number', 'price should be number');
    assert.ok('previous_close' in result);
    assert.ok('currency' in result);
    assert.ok('52w_high' in result);
  }
});

test('getPrice — crypto symbol works (BTC-USD)', async () => {
  const result = await yahoo.getPrice('BTC-USD');
  assert.equal(result.symbol, 'BTC-USD');
  if (!result.error) {
    assert.ok(typeof result.price === 'number');
    assert.ok(result.currency === 'USD');
  }
});

test('getPrice — invalid symbol returns error block, not throws', async () => {
  const result = await yahoo.getPrice('NOTAREALTICKER_XYZ_123');
  assert.equal(result.symbol, 'NOTAREALTICKER_XYZ_123');
  assert.ok('error' in result || result.price == null);
});
