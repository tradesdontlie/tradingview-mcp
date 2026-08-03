import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';

import {
  WATCHLIST_ACTIVE_READ_EXPRESSION,
  get,
} from '../src/core/watchlist.js';

const ACTIVE = Object.freeze({
  id: 329572122,
  name: 'SMRs',
  type: 'custom',
  symbols: ['NYSE:OKLO', 'NYSE:SMR', 'NASDAQ:NNE'],
});

function read(value = ACTIVE, overrides = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      id: value.id,
      name: value.name,
      type: value.type,
      symbols: [...value.symbols],
      symbol_count: value.symbols.length,
    },
    ...overrides,
  };
}

function pair(first = read(), second = read()) {
  return { first, second };
}

function fixture(result = pair()) {
  const calls = [];
  return {
    calls,
    deps: {
      evaluateAsync: async expression => {
        calls.push(expression);
        return result;
      },
    },
  };
}

test('page expression performs exactly two authenticated no-store active-list reads', async () => {
  const calls = [];
  const payload = {
    id: 7,
    name: 'Core',
    type: 'custom',
    symbols: ['###Holdings', 'NASDAQ:AAPL'],
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: name => name === 'content-type' ? 'application/json' : null },
      json: async () => payload,
    };
  };

  const result = await vm.runInNewContext(WATCHLIST_ACTIVE_READ_EXPRESSION, { fetch });
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(plain.first, plain.second);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, '/api/v1/symbols_list/active/');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.headers.Accept, 'application/json');
  }
});

test('returns the complete canonical active list without touching panel or scroll state', async () => {
  const first = read({
    id: 'list-1',
    name: ' Growth\u0000\nList ',
    type: 'custom',
    symbols: ['###Technology', 'NASDAQ:AAPL', 'NASDAQ:MSFT'],
  });
  const fixtureResult = fixture(pair(first, structuredClone(first)));
  const result = await get({ _deps: fixtureResult.deps });

  assert.equal(result.success, true);
  assert.equal(result.source, 'active_list_rest_api');
  assert.equal(result.list_id, 'list-1');
  assert.equal(result.list_name, 'Growth List');
  assert.equal(result.count, 2);
  assert.deepEqual(result.symbols, [
    { symbol: 'NASDAQ:AAPL', last: null, change: null, change_percent: null, volume: null },
    { symbol: 'NASDAQ:MSFT', last: null, change: null, change_percent: null, volume: null },
  ]);
  assert.deepEqual(result.traversal, {
    complete: true,
    metadata_verified: true,
    consistency_reads: 2,
    expected_count: 2,
    filtered_section_count: 1,
  });
  assert.equal(result.restoration.ui_mutation, false);
  assert.deepEqual(result.restoration.panel, {
    required: false,
    attempted: false,
    changed: false,
    verified: true,
    baseline_mode: 'not_touched',
    final_mode: 'not_touched',
  });
  assert.equal(result.restoration.scroll.verified, true);
  assert.equal(fixtureResult.calls.length, 1);
  assert.match(fixtureResult.calls[0], /watchlist-reader:active-rest-v1/);
  assert.doesNotMatch(fixtureResult.calls[0], /\.click\(|scrollTop/);
});

test('accepts an authoritative empty active list instead of inferring emptiness from the DOM', async () => {
  const empty = read({ id: 8, name: 'Empty', type: 'custom', symbols: [] });
  const result = await get({ _deps: fixture(pair(empty, structuredClone(empty))).deps });
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.symbols, []);
  assert.equal(result.traversal.expected_count, 0);
});

test('fails closed if active-list identity, name, membership, or order changes', async () => {
  const cases = [
    read({ ...ACTIVE, id: 999 }),
    read({ ...ACTIVE, name: 'Another' }),
    read({ ...ACTIVE, symbols: ['NYSE:OKLO', 'NASDAQ:NNE'] }),
    read({ ...ACTIVE, symbols: [...ACTIVE.symbols].reverse() }),
  ];
  for (const second of cases) {
    await assert.rejects(
      get({ _deps: fixture(pair(read(), second)).deps }),
      error => error.code === 'watchlist_active_changed'
        && /identity or membership changed/.test(error.message),
    );
  }
});

test('fails closed on HTTP, non-JSON, missing-field, or oversized responses', async () => {
  const invalidReads = [
    { ok: false, status: 401, error: 'http_error' },
    { ok: false, status: 200, error: 'non_json_response' },
    read({ id: null, name: 'Missing ID', type: 'custom', symbols: [] }),
    read(ACTIVE, { data: { ...ACTIVE, symbols: ['NYSE:OKLO'], symbol_count: 10_001 } }),
  ];
  for (const invalid of invalidReads) {
    await assert.rejects(
      get({ _deps: fixture(pair(invalid, invalid)).deps }),
      error => error.code === 'watchlist_active_read_failed',
    );
  }
});

test('rejects malformed, duplicate, unqualified, and control-bearing symbols', async () => {
  const cases = [
    ['NASDAQ:AAPL', 'nasdaq:aapl'],
    ['AAPL'],
    ['NASDAQ:AAPL\u0000'],
    [null],
  ];
  for (const symbols of cases) {
    const invalid = read({ id: 9, name: 'Bad', type: 'custom', symbols });
    await assert.rejects(get({ _deps: fixture(pair(invalid, invalid)).deps }));
  }
});

test('serializes simultaneous reads and releases the lock after completion', async () => {
  let calls = 0;
  let releaseFirst;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const deps = {
    evaluateAsync: async () => {
      calls++;
      if (calls === 1) {
        markStarted();
        await gate;
      }
      return pair();
    },
  };

  const first = get({ _deps: deps });
  await started;
  const second = get({ _deps: deps });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});
