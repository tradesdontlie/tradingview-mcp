// Smoke tests for news + sentiment tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as news from '../src/core/news.js';

test('fetchNewsSummary — stocks category returns items', async () => {
  const result = await news.fetchNewsSummary({ category: 'stocks', limit: 5 });
  assert.equal(result.category, 'stocks');
  assert.ok(typeof result.count === 'number');
  assert.ok(Array.isArray(result.items));
  assert.ok(typeof result.timestamp === 'string');
});

test('fetchNewsSummary — crypto category returns items', async () => {
  const result = await news.fetchNewsSummary({ category: 'crypto', limit: 5 });
  assert.equal(result.category, 'crypto');
  assert.ok(Array.isArray(result.items));
});

test('fetchNewsSummary — symbol filter narrows', async () => {
  const result = await news.fetchNewsSummary({ symbol: 'BTC', category: 'crypto', limit: 5 });
  assert.equal(result.symbol, 'BTC');
  // Just check structure — filter may yield 0+ items depending on day.
  assert.ok(Array.isArray(result.items));
});
