// Smoke tests for snapshot tools (Yahoo Finance backed)
// node --test tests/snapshots.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yahoo from '../src/core/yahoo.js';
import * as btcMarket from '../src/core/bitcoin_market.js';
import * as extendedHours from '../src/core/extended_hours.js';
import * as options from '../src/core/options.js';

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

test('getUnusualOptionsActivity — ranks contracts by V/OI for AAPL', async () => {
  const result = await options.getUnusualOptionsActivity('AAPL', { top_n: 5, min_volume: 50, expiries: 2 });
  assert.equal(result.symbol, 'AAPL');
  if (!result.error) {
    assert.ok(Array.isArray(result.unusual));
    assert.ok(Array.isArray(result.expiries_scanned));
    if (result.unusual.length > 1) {
      assert.ok(result.unusual[0].v_oi_ratio >= result.unusual[1].v_oi_ratio, 'sorted desc by v_oi_ratio');
    }
  }
});

test('getOptionsChain — returns chain shape for AAPL', async () => {
  const result = await options.getOptionsChain('AAPL');
  assert.equal(result.symbol, 'AAPL');
  if (!result.error) {
    assert.ok(typeof result.underlying_price === 'number');
    assert.ok(Array.isArray(result.calls));
    assert.ok(Array.isArray(result.puts));
    assert.ok(Array.isArray(result.available_expiries));
  }
});

test('getExtendedHoursPrice — returns session breakdown for AAPL', async () => {
  const result = await extendedHours.getExtendedHoursPrice('AAPL');
  assert.equal(result.symbol, 'AAPL');
  if (!result.error) {
    assert.ok('previous_close' in result);
    assert.ok('pre_market' in result);
    assert.ok('regular' in result);
    assert.ok('post_market' in result);
  }
});

test('getBitcoinMarketPulse — returns macro context + assessment', async () => {
  const result = await btcMarket.getBitcoinMarketPulse();
  assert.equal(result.source, 'CoinGecko');
  assert.equal(result.tool, 'bitcoin_market_pulse');
  if (!result.error) {
    assert.ok('bitcoin' in result);
    assert.ok('dominance' in result);
    assert.ok('total_market' in result);
    assert.ok('assessment' in result);
    assert.ok(typeof result.assessment.label === 'string');
    assert.ok(typeof result.assessment.summary === 'string');
  }
});

test('getMarketSnapshot — returns grouped market data', async () => {
  const result = await yahoo.getMarketSnapshot();
  assert.ok('indices' in result);
  assert.ok('crypto' in result);
  assert.ok('fx' in result);
  assert.ok('etfs' in result);
  assert.ok(Array.isArray(result.indices));
  assert.ok(typeof result.timestamp === 'string');
});
