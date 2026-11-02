import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchlistSections, planCreateSection, planMoveToSection, getWatchlistSections, createWatchlistSection, moveToWatchlistSection, watchlistRevision } from '../src/core/watchlist-sections.js';

const entries = ['NASDAQ:AAPL', '###First', 'NASDAQ:MSFT', 'NYSE:IBM', '###Second', 'NASDAQ:NVDA'];
function backend() {
  let state = { id: '42', type: 'custom', name: 'Test', modified: 'one', symbols: [...entries] };
  let reads = 0, writes = 0;
  return {
    get state() { return state; }, get reads() { return reads; }, get writes() { return writes; },
    _deps: {
      readList: async () => { reads++; return structuredClone(state); },
      writeList: async (initial, next) => { writes++; state = { ...state, symbols: [...next], modified: 'two' }; },
    },
  };
}

it('parses native separators without losing ungrouped, empty or ordered entries', () => {
  const parsed = parseWatchlistSections([...entries, '###Empty']);
  assert.deepEqual(parsed.map(s => s.name), [null, 'First', 'Second', 'Empty']);
  assert.deepEqual(parsed[0].symbols, ['NASDAQ:AAPL']);
  assert.deepEqual(parsed[1].symbols, ['NASDAQ:MSFT', 'NYSE:IBM']);
  assert.deepEqual(parsed.at(-1).symbols, []);
});

it('creates an empty section idempotently and rejects ambiguous duplicate headers', () => {
  assert.deepEqual(planCreateSection(entries, 'First'), entries);
  const created = planCreateSection(entries, 'New');
  assert.deepEqual(created, [...entries, '###New']);
  assert.deepEqual(planCreateSection(created, 'New'), created);
  assert.throws(() => planCreateSection(['###Same', '###Same'], 'Same'), /ambiguous/);
});

it('moves only existing exact entries and preserves both moved and unrelated order', () => {
  const result = planMoveToSection(entries, 'Second', ['NYSE:IBM', 'NASDAQ:AAPL']);
  assert.deepEqual(result, ['###First', 'NASDAQ:MSFT', '###Second', 'NASDAQ:NVDA', 'NASDAQ:AAPL', 'NYSE:IBM']);
  assert.deepEqual(planMoveToSection(result, 'Second', ['NASDAQ:AAPL', 'NYSE:IBM']), result);
  assert.throws(() => planMoveToSection(entries, 'Second', ['AAPL']), /SOURCE:TICKER/);
  assert.throws(() => planMoveToSection(entries, 'Missing', ['NASDAQ:AAPL']), /not found/);
  assert.throws(() => planMoveToSection(entries, 'Second', ['NASDAQ:UNKNOWN']), /not in watchlist/);
  assert.throws(() => planMoveToSection([...entries, 'NASDAQ:AAPL'], 'Second', ['NASDAQ:AAPL']), /more than once/);
});

it('reads sections and returns a revision that stale edits must reject', async () => {
  const mock = backend();
  const read = await getWatchlistSections({ list_id: '42', _deps: mock._deps });
  assert.equal(read.revision, watchlistRevision(mock.state));
  await assert.rejects(createWatchlistSection({ list_id: '42', section: 'New', expected_revision: '0'.repeat(64), _deps: mock._deps }), /revision is stale/);
  assert.equal(mock.writes, 0);
});

it('performs a preflight, verifies exact server state, and does not duplicate a retried create', async () => {
  const mock = backend();
  const first = await createWatchlistSection({ list_id: '42', section: 'New', _deps: mock._deps });
  assert.equal(first.success, true);
  assert.equal(first.verified, true);
  assert.equal(first.atomic_compare_and_swap, false);
  assert.equal(first.ui_refresh_required, true);
  assert.equal(mock.reads, 3);
  const retry = await createWatchlistSection({ list_id: '42', section: 'New', _deps: mock._deps });
  assert.equal(retry.changed, false);
  assert.equal(mock.writes, 1);
});

it('fails before POST when another writer changes state during preflight', async () => {
  const mock = backend();
  const read = mock._deps.readList;
  mock._deps.readList = async () => {
    const result = await read();
    if (mock.reads === 2) result.symbols.push('NASDAQ:NVDA');
    return result;
  };
  await assert.rejects(createWatchlistSection({ list_id: '42', section: 'New', _deps: mock._deps }), /changed concurrently/);
  assert.equal(mock.writes, 0);
});

it('rereads after response loss and confirms a committed write without replaying it', async () => {
  const mock = backend();
  const write = mock._deps.writeList;
  mock._deps.writeList = async (...args) => { await write(...args); throw new Error('Response lost'); };
  const result = await moveToWatchlistSection({ list_id: '42', section: 'Second', symbols: ['NASDAQ:AAPL'], _deps: mock._deps });
  assert.equal(result.success, true);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(mock.writes, 1);
});

it('does not overwrite newer remote edits with an automatic rollback or repeat', async () => {
  const mock = backend();
  const write = mock._deps.writeList;
  mock._deps.writeList = async (initial, next) => { await write(initial, [...next, 'NYSE:GE']); };
  const result = await createWatchlistSection({ list_id: '42', section: 'New', _deps: mock._deps });
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(mock.writes, 1);
  assert.equal(mock.state.symbols.at(-1), 'NYSE:GE');
});

it('reports an unknown result when post-write verification is unavailable', async () => {
  const mock = backend();
  const read = mock._deps.readList;
  mock._deps.readList = async () => {
    if (mock.writes) throw new Error('Server unavailable');
    return read();
  };
  const result = await createWatchlistSection({ list_id: '42', section: 'New', _deps: mock._deps });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.success, false);
  assert.equal(mock.writes, 1);
});

it('rejects invalid list ids and section names without touching a backend', async () => {
  const mock = backend();
  await assert.rejects(createWatchlistSection({ list_id: '../escape', section: 'New', _deps: mock._deps }), /Invalid list_id/);
  for (const name of ['', ' bad ', '###bad', 'bad\nname']) assert.throws(() => planCreateSection(entries, name), /section must/);
  assert.equal(mock.reads, 0);
});

it('reports uncertain changes and refresh after a dispatched write observes a different remote edit', async () => {
  const mock = backend();
  mock._deps.writeList = async () => { mock.state.symbols.push('###Other'); };
  const result = await createWatchlistSection({ list_id: '42', section: 'Wanted', _deps: mock._deps });
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.changed, null);
  assert.equal(result.observed_state_changed, true);
  assert.equal(result.ui_refresh_required, true);
  assert.equal(result.write_dispatched, true);
});
