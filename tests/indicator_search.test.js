/**
 * Tests for searchStudies/addStudyFromSearch in src/core/indicators.js.
 *
 * Covers a live-reproduced bug: TradingView's Indicators dialog does not
 * clear previously-rendered results when reopened, and community-script
 * search results can take anywhere from well under a second to several
 * seconds to render. A naive "read once after a fixed delay" either reads
 * stale leftover rows from the *previous* query (a false positive) or races
 * a genuinely slow render and reads nothing yet (a false "stuck" negative).
 * searchStudies now polls until the dialog shows either new content (a
 * diff against a pre-type baseline) or its own "No indicators matched your
 * criteria" empty-state message — the two real, observable terminal states
 * — and only reports a hard failure if neither appears within the timeout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchStudies, addStudyFromSearch } from '../src/core/indicators.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

// Simulates the Indicators dialog at the `evaluate` boundary: it recognizes
// which step of openDialog/typeQuery/READ_RESULTS_JS/closeDialog is being
// evaluated (by stable substrings from the real templates) and returns
// canned data instead of running the injected DOM-scanning JS for real.
//
// `readsByQuery` maps a query string to an array of "readouts" consumed one
// per read (baseline capture counts as a read too, so a fresh dialog with
// no prior query reads `readsByQuery[null]`); each readout is either an
// array of {title, section} rows, or the string 'EMPTY' for TradingView's
// own no-match message. Once a query's readouts are exhausted, the last one
// repeats — matching a dialog that's settled and stops changing.
function mockDialog({ readsByQuery }) {
  let dialogOpen = false;
  let currentQuery = null;
  const readIndex = {};

  const evaluate = async (expr) => {
    if (expr.includes("return 'already';")) {
      if (dialogOpen) return 'already';
      dialogOpen = true;
      return 'clicked';
    }
    if (expr.includes('!!document.querySelector(') && expr.includes('input')) {
      return dialogOpen;
    }
    if (expr.includes("dispatchEvent(new Event('input'")) {
      const m = expr.match(/setter\.call\(inp,\s*(".*?")\)/);
      currentQuery = m ? JSON.parse(m[1]) : null;
      return true;
    }
    if (expr.includes('var emptyState = false;')) {
      const seq = readsByQuery[currentQuery] || [[]];
      const i = readIndex[currentQuery] || 0;
      readIndex[currentQuery] = i + 1;
      const readout = seq[Math.min(i, seq.length - 1)];
      if (readout === 'EMPTY') return { open: true, results: [], emptyState: true };
      return { open: true, results: readout || [], emptyState: false };
    }
    if (expr.includes('data-name="close"')) {
      dialogOpen = false;
      return undefined;
    }
    return undefined;
  };
  evaluate.readIndex = readIndex;
  return evaluate;
}

// Small/fast values so tests don't wait on the real 400ms/30-poll (~12s) budget.
const FAST_DEPS = { pollIntervalMs: 2, maxPolls: 5 };

describe('searchStudies', () => {
  it('returns results once they render', async () => {
    const evaluate = mockDialog({
      readsByQuery: {
        supertrend: [[{ title: 'Supertrend', section: 'Technicals' }, { title: 'SuperTrend AI', section: 'Community' }]],
      },
    });
    const r = await searchStudies({ query: 'supertrend', _deps: { evaluate, ...FAST_DEPS } });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.deepEqual(r.results, [{ title: 'Supertrend', section: 'Technicals' }, { title: 'SuperTrend AI', section: 'Community' }]);
  });

  it('respects the limit and reports the capped count', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Study ${i}`, section: 'Technicals' }));
    const evaluate = mockDialog({ readsByQuery: { rsi: [many] } });
    const r = await searchStudies({ query: 'rsi', limit: 5, _deps: { evaluate, ...FAST_DEPS } });
    assert.equal(r.success, true);
    assert.equal(r.count, 5);
    assert.equal(r.results.length, 5);
  });

  it('waits out a slow render instead of reporting a false failure', async () => {
    // Two empty polls (still loading) before the real results land — must
    // not be mistaken for "no matches" or "stuck".
    const evaluate = mockDialog({
      readsByQuery: {
        ema: [[], [], [{ title: 'Moving Average Exponential', section: 'Technicals' }]],
      },
    });
    const r = await searchStudies({ query: 'ema', _deps: { evaluate, ...FAST_DEPS } });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(r.results[0].title, 'Moving Average Exponential');
  });

  it('does not mistake stale leftover rows from a previous query for a fresh match', async () => {
    // The dialog still shows the *previous* query's rows the instant after
    // typing (reopening doesn't clear them) — those must not be reported
    // as if they matched the new query. Baseline capture reads the stale
    // rows (keyed by the leftover/null query); the new query's first two
    // reads still show that same stale content before it actually updates.
    const stale = [{ title: 'Stale Old Result', section: 'Technicals' }];
    const evaluate = mockDialog({
      readsByQuery: {
        null: [stale],
        macd: [stale, stale, [{ title: 'MACD', section: 'Technicals' }]],
      },
    });
    const r = await searchStudies({ query: 'macd', _deps: { evaluate, ...FAST_DEPS } });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(r.results[0].title, 'MACD');
  });

  it('reports a clear, honest failure when the query never settles', async () => {
    const evaluate = mockDialog({ readsByQuery: { xyzzy: [[]] } });
    await assert.rejects(
      () => searchStudies({ query: 'xyzzy', _deps: { evaluate, ...FAST_DEPS } }),
      /did not settle/,
    );
  });

  it('requires a non-empty query', async () => {
    await assert.rejects(() => searchStudies({ query: '  ' }), /query is required/);
  });
});

describe('addStudyFromSearch', () => {
  function mockAddDeps({ after, clickResult }) {
    let readCount = 0;
    const evaluate = async (expr) => {
      // The "after" read asks for {id, name} objects; the "before" read (run
      // before the dialog even opens) just asks for bare ids.
      if (expr.includes('getAllStudies()') && expr.includes('name:')) return after;
      if (expr.includes('getAllStudies()')) return [];
      if (expr.includes('pick.row.click')) return clickResult;
      if (expr.includes("return 'already';")) return 'clicked';
      if (expr.includes('!!document.querySelector(')) return true;
      if (expr.includes("dispatchEvent(new Event('input'")) return true;
      if (expr.includes('var emptyState = false;')) {
        // First read is the pre-type baseline (empty); every read after
        // that reflects the query having rendered a real result row.
        readCount += 1;
        if (readCount === 1) return { open: true, results: [], emptyState: false };
        return { open: true, results: [{ title: 'placeholder', section: null }], emptyState: false };
      }
      return undefined;
    };
    return evaluate;
  }

  it('surfaces a clear error when no result matches', async () => {
    const evaluate = mockAddDeps({ after: [], clickResult: { error: 'No result matching "totally-bogus-name" found.' } });
    await assert.rejects(
      () => addStudyFromSearch({ query: 'totally-bogus-name', _deps: { evaluate, ...FAST_DEPS } }),
      /No result matching/,
    );
  });

  it('reports success and the new entity_id when a row is clicked and a study appears', async () => {
    const evaluate = mockAddDeps({
      after: [{ id: 'study_1', name: 'Supertrend' }],
      clickResult: { clicked: 'Supertrend', section: 'Technicals' },
    });
    const r = await addStudyFromSearch({ query: 'supertrend', _deps: { evaluate, ...FAST_DEPS } });
    assert.equal(r.success, true);
    assert.equal(r.entity_id, 'study_1');
    assert.equal(r.added_from_search, 'Supertrend');
  });
});
