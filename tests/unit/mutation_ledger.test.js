import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextMutationId,
  recordChartMutation,
  currentMutationId,
  currentMutation,
  lastMutationFor,
  _resetLedger,
} from '../../src/core/_mutation_ledger.js';

describe('mutation_ledger', () => {
  beforeEach(() => _resetLedger());

  it('nextMutationId is monotonic', () => {
    const a = nextMutationId();
    const b = nextMutationId();
    const c = nextMutationId();
    assert.equal(b, a + 1);
    assert.equal(c, b + 1);
  });

  it('recordChartMutation returns ascending IDs and bumps currentMutationId', () => {
    assert.equal(currentMutationId(), 0);
    const id1 = recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    assert.equal(id1, 1);
    assert.equal(currentMutationId(), 1);
    const id2 = recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    assert.equal(id2, 2);
    assert.equal(currentMutationId(), 2);
  });

  it('currentMutation reflects last record (kind/symbol/timeframe)', () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    recordChartMutation({ kind: 'setTimeframe', timeframe: '60' });
    const cur = currentMutation();
    assert.equal(cur.kind, 'setTimeframe');
    assert.equal(cur.timeframe, '60');
    // symbol persists across timeframe-only mutations
    assert.equal(cur.symbol, 'TADAWUL:2222');
  });

  it('lastMutationFor returns per-symbol record', () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    const m2222 = lastMutationFor('TADAWUL:2222');
    const m1120 = lastMutationFor('TADAWUL:1120');
    const mNone = lastMutationFor('TADAWUL:9999');
    assert.equal(m2222.mutation_id, 1);
    assert.equal(m1120.mutation_id, 2);
    assert.equal(mNone, null);
  });

  it('lastMutationFor(null/undefined) returns null', () => {
    assert.equal(lastMutationFor(null), null);
    assert.equal(lastMutationFor(undefined), null);
    assert.equal(lastMutationFor(''), null);
  });

  it('hash is propagated through (for pine deploy provenance)', () => {
    recordChartMutation({ kind: 'pine_deploy_strategy', hash: 'abc123' });
    const cur = currentMutation();
    assert.equal(cur.hash, 'abc123');
    assert.equal(cur.kind, 'pine_deploy_strategy');
  });

  it('_resetLedger zeros counter + clears per-symbol map', () => {
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:2222' });
    recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:1120' });
    _resetLedger();
    assert.equal(currentMutationId(), 0);
    assert.equal(lastMutationFor('TADAWUL:2222'), null);
    const id = recordChartMutation({ kind: 'setSymbol', symbol: 'TADAWUL:9999' });
    assert.equal(id, 1);
  });
});

describe('mutation_ledger wired into chart.js (mocked deps)', () => {
  it('chart.setSymbol returns mutation_id', async () => {
    _resetLedger();
    const chart = await import('../../src/core/chart.js');
    const _deps = {
      evaluate: async () => ({ symbol: 'TADAWUL:2222', exchange: 'TADAWUL' }),
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.setSymbol({ symbol: 'TADAWUL:2222', _deps });
    assert.equal(typeof r.mutation_id, 'number');
    assert.equal(r.mutation_id, 1);
    assert.equal(currentMutationId(), 1);
  });

  it('chart.ensureSymbol returns mutation_id and registers symbol', async () => {
    _resetLedger();
    const chart = await import('../../src/core/chart.js');
    const _deps = {
      evaluate: async () => ({ symbol: 'TADAWUL:1120', exchange: 'TADAWUL', description: 'Al Rajhi', type: 'stock' }),
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.ensureSymbol({ symbol: 'TADAWUL:1120', _deps });
    assert.ok(r.mutation_id >= 1);
    const last = lastMutationFor('TADAWUL:1120');
    assert.ok(last !== null);
    assert.equal(last.kind, 'ensureSymbol');
  });

  it('chart.setTimeframe returns mutation_id', async () => {
    _resetLedger();
    const chart = await import('../../src/core/chart.js');
    const _deps = {
      evaluate: async () => null,
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.setTimeframe({ timeframe: '60', _deps });
    assert.equal(typeof r.mutation_id, 'number');
    assert.equal(currentMutation().timeframe, '60');
  });
});

function _resetLedgerImport() {
  // workaround for ESM caching — re-import resets module-level state via _resetLedger()
}
