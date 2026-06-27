/**
 * Router / failure-signaling unit tests — no TradingView connection needed.
 * Covers the CLI exit-code decision and the data.js findStrategy snippet builder.
 *
 * Run: node --test tests/router.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor } from '../src/cli/router.js';
import { findStrategy } from '../src/core/data.js';
import { findBarIndexRange } from '../src/core/chart.js';
import { findCompileButton, listScripts } from '../src/core/pine.js';

describe('CLI — exitCodeFor', () => {
  it('returns 1 for an explicit success:false result', () => {
    assert.equal(exitCodeFor({ success: false, error: 'boom' }), 1);
  });

  it('returns 0 for a success:true result', () => {
    assert.equal(exitCodeFor({ success: true, data: [] }), 0);
  });

  it('returns 0 when success is absent (non-failure object)', () => {
    assert.equal(exitCodeFor({ foo: 'bar' }), 0);
  });

  it('returns 0 for null / non-object results', () => {
    assert.equal(exitCodeFor(null), 0);
    assert.equal(exitCodeFor(undefined), 0);
    assert.equal(exitCodeFor('done'), 0);
  });
});

describe('data — findStrategy snippet builder', () => {
  it('returns a non-empty snippet embedding the predicate', () => {
    const snippet = findStrategy('s.reportData || s.performance');
    assert.equal(typeof snippet, 'string');
    assert.ok(snippet.length > 0);
    assert.ok(snippet.includes('s.reportData || s.performance'));
    assert.ok(snippet.includes('var strat = null'));
    assert.ok(snippet.includes('dataSources()'));
  });
});

describe('chart — findBarIndexRange snippet builder', () => {
  it('embeds the from/to bounds and zooms the bar range', () => {
    const snippet = findBarIndexRange(1700000000, 1700100000);
    assert.equal(typeof snippet, 'string');
    assert.ok(snippet.includes('1700000000'));
    assert.ok(snippet.includes('1700100000'));
    assert.ok(snippet.includes('bars.firstIndex()'));
    assert.ok(snippet.includes('bars.lastIndex()'));
    assert.ok(snippet.includes('zoomToBarsRange(fromIdx, toIdx)'));
  });

  it('interpolates distinct bounds for distinct args', () => {
    assert.ok(findBarIndexRange(1, 2).includes('v[0] >= 1'));
    assert.ok(findBarIndexRange(1, 2).includes('v[0] <= 2'));
  });
});

describe('pine — findCompileButton snippet builder', () => {
  it('default (compile) prefix-matches and echoes the button text', () => {
    const snippet = findCompileButton();
    assert.equal(typeof snippet, 'string');
    assert.ok(snippet.includes('save and add to chart'));
    assert.ok(snippet.includes('/^(Add to chart|Update on chart)/i'));
    assert.ok(snippet.includes('return addBtn.textContent.trim()'));
    assert.ok(snippet.includes("return 'Pine Save'"));
  });

  it('exact (smartCompile) matches exactly and reports canonical labels', () => {
    const snippet = findCompileButton({ exact: true });
    assert.ok(snippet.includes('/^add to chart$/i'));
    assert.ok(snippet.includes('/^update on chart$/i'));
    assert.ok(snippet.includes("return 'Add to chart'"));
    assert.ok(snippet.includes("return 'Update on chart'"));
  });
});

describe('pine — listScripts throws instead of success-with-error', () => {
  it('throws when the pine-facade payload carries an error', async () => {
    const _deps = { evaluateAsync: async () => ({ scripts: [], error: 'pine-facade 403' }) };
    await assert.rejects(() => listScripts({ _deps }), /pine-facade 403/);
  });

  it('returns the success shape with no error field on the happy path', async () => {
    const _deps = { evaluateAsync: async () => ({ scripts: [{ id: 'a', name: 'X' }] }) };
    const r = await listScripts({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.ok(!('error' in r), 'no embedded error field on success');
  });
});
