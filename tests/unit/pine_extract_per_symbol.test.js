import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetLedger, recordChartMutation } from '../../src/core/_mutation_ledger.js';
import * as batch from '../../src/core/batch.js';

/**
 * C6 / A1-F1: pine_extract_per_symbol collapses N × (ensure + wait + read)
 * into one tool. Tests verify per-symbol rows, mutation_id provenance,
 * verify_with_known_good fail-fast, abort_after_consecutive_empty, and
 * error handling per symbol.
 */

function _makeDeps({ symbolPayloads, ensureMutationIds = {}, waitFailures = {} } = {}) {
  // symbolPayloads: { 'TADAWUL:2222': [{name, total_labels, count, items}], ... }
  // waitFailures: { 'TADAWUL:1031': true } → returns success:false from waitForOutput
  let _currentSymbol = null;
  let _id = 0;
  return {
    ensureSymbol: async ({ symbol }) => {
      _currentSymbol = symbol;
      _id += 1;
      const mid = ensureMutationIds[symbol] ?? _id;
      recordChartMutation({ kind: 'ensureSymbol', symbol });
      return { success: true, resolved_symbol: symbol, mutation_id: mid, delayed_feed: false };
    },
    waitForOutput: async ({ study_filter, expected_for_symbol, emit }) => {
      if (waitFailures[expected_for_symbol]) {
        return { success: false, code: 'PINE_WAIT_TIMEOUT', last_result: null, wait_ms_elapsed: 50 };
      }
      const studies = symbolPayloads[expected_for_symbol] || [];
      return { success: true, emit, study_filter, studies, total_count: studies.reduce((s, x) => s + (x.total_labels || x.total_lines || x.total_boxes || 0), 0), wait_ms_elapsed: 100 };
    },
    getPineLabels: async ({ expected_for_symbol }) => {
      const studies = symbolPayloads[expected_for_symbol] || [];
      return { success: true, studies };
    },
    getPineLines: async ({ expected_for_symbol }) => ({ success: true, studies: [] }),
    getPineBoxes: async ({ expected_for_symbol }) => ({ success: true, studies: [] }),
    getPineTables: async ({ expected_for_symbol }) => ({ success: true, studies: [] }),
  };
}

describe('batch.extractPerSymbol (C6)', () => {
  beforeEach(() => _resetLedger());

  it('returns one row per symbol with mutation_id provenance', async () => {
    const _deps = _makeDeps({
      symbolPayloads: {
        'TADAWUL:2222': [{ name: 'EarnsExtractor', total_labels: 27, count: 27 }],
        'TADAWUL:1120': [{ name: 'EarnsExtractor', total_labels: 58, count: 58 }],
        'TADAWUL:1031': [{ name: 'EarnsExtractor', total_labels: 12, count: 12 }],
      },
    });
    const r = await batch.extractPerSymbol({
      study_filter: 'EarnsExtractor',
      symbols: ['TADAWUL:2222', 'TADAWUL:1120', 'TADAWUL:1031'],
      emit: ['labels'],
      _deps,
    });
    assert.equal(r.success, true);
    assert.equal(r.aborted, false);
    assert.equal(r.symbols_requested, 3);
    assert.equal(r.symbols_processed, 3);
    assert.equal(r.successful, 3);
    assert.equal(r.rows.length, 3);
    for (const row of r.rows) {
      assert.equal(row.success, true);
      assert.ok(typeof row.mutation_id_after_ensure === 'number');
      assert.ok(typeof row.mutation_id_after_read === 'number');
      assert.ok(row.payload.labels && row.payload.labels.length === 1);
      assert.ok(row.total_items > 0);
    }
  });

  it('handles per-symbol wait failures (empty studies) as success:false rows', async () => {
    const _deps = _makeDeps({
      symbolPayloads: {
        'TADAWUL:2222': [{ name: 'EarnsExtractor', total_labels: 1, count: 1 }],
        'TADAWUL:9999': [], // no data
      },
      waitFailures: { 'TADAWUL:9999': true },
    });
    const r = await batch.extractPerSymbol({
      study_filter: 'EarnsExtractor',
      symbols: ['TADAWUL:2222', 'TADAWUL:9999'],
      _deps,
    });
    assert.equal(r.symbols_processed, 2);
    assert.equal(r.successful, 1);
    assert.equal(r.empty, 1);
    assert.equal(r.rows[0].success, true);
    assert.equal(r.rows[1].success, false);
    assert.equal(r.rows[1].error, 'PINE_WAIT_TIMEOUT');
  });

  it('verify_with_known_good aborts the sweep when known-good returns empty', async () => {
    const _deps = _makeDeps({
      symbolPayloads: { 'TADAWUL:2222': [] }, // empty even though it's supposed to be the known-good
      waitFailures: { 'TADAWUL:2222': true },
    });
    const r = await batch.extractPerSymbol({
      study_filter: 'EarnsExtractor',
      symbols: ['TADAWUL:1120', 'TADAWUL:1031'],
      verify_with_known_good: 'TADAWUL:2222',
      _deps,
    });
    assert.equal(r.aborted, true);
    assert.match(r.abort_reason, /verify_with_known_good="TADAWUL:2222"/);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].symbol, 'TADAWUL:2222');
  });

  it('verify_with_known_good passes through when known-good has data', async () => {
    const _deps = _makeDeps({
      symbolPayloads: {
        'TADAWUL:2222': [{ name: 'E', total_labels: 5, count: 5 }],
        'TADAWUL:1120': [{ name: 'E', total_labels: 3, count: 3 }],
      },
    });
    const r = await batch.extractPerSymbol({
      study_filter: 'E',
      symbols: ['TADAWUL:1120'],
      verify_with_known_good: 'TADAWUL:2222',
      _deps,
    });
    assert.equal(r.aborted, false);
    assert.equal(r.symbols_processed, 2); // known-good + requested
    assert.equal(r.successful, 2);
  });

  it('abort_after_consecutive_empty bails after N empties', async () => {
    const _deps = _makeDeps({
      symbolPayloads: {
        'A': [{ name: 'E', total_labels: 5, count: 5 }],
        'B': [], 'C': [], 'D': [], 'E': [{ name: 'E', total_labels: 3, count: 3 }],
      },
      waitFailures: { B: true, C: true, D: true },
    });
    const r = await batch.extractPerSymbol({
      study_filter: 'E',
      symbols: ['A', 'B', 'C', 'D', 'E'],
      abort_after_consecutive_empty: 3,
      _deps,
    });
    assert.equal(r.aborted, true);
    assert.match(r.abort_reason, /3 consecutive empty/);
    assert.equal(r.rows.length, 4); // A, B, C, D — stops before E
    assert.equal(r.rows[r.rows.length - 1].symbol, 'D');
  });

  it('rejects empty symbols array', async () => {
    let threw = false;
    try { await batch.extractPerSymbol({ study_filter: 'X', symbols: [] }); }
    catch (e) { threw = true; assert.match(e.message, /non-empty array/); }
    assert.equal(threw, true);
  });

  it('rejects > 500 symbols', async () => {
    let threw = false;
    try {
      await batch.extractPerSymbol({ study_filter: 'X', symbols: Array.from({ length: 501 }, (_, i) => 'S' + i) });
    } catch (e) { threw = true; assert.match(e.message, /capped at 500/); }
    assert.equal(threw, true);
  });

  it('rejects bad emit values', async () => {
    let threw = false;
    try { await batch.extractPerSymbol({ study_filter: 'X', symbols: ['A'], emit: ['NOPE'] }); }
    catch (e) { threw = true; assert.match(e.message, /emit must be one or more/); }
    assert.equal(threw, true);
  });
});
