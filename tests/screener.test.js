/**
 * Tests for src/core/screener.js — status, open, close, get.
 * All tests use dependency injection; no live TradingView required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { status, open, close, get } from '../src/core/screener.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockEvaluate(sequence) {
  let idx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    const val = sequence[Math.min(idx, sequence.length - 1)];
    idx++;
    return val;
  };
  fn.calls = calls;
  return fn;
}

function mockClient() {
  const mouseEvents = [];
  return {
    Input: {
      dispatchMouseEvent: async (opts) => { mouseEvents.push(opts); },
    },
    _mouseEvents: mouseEvents,
  };
}

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('returns open=false when no container in DOM', async () => {
    const evaluate = mockEvaluate([{ open: false }]);
    const result = await status({ _deps: { evaluate } });
    assert.equal(result.success, true);
    assert.equal(result.open, false);
    assert.equal(result.width, null);
    assert.equal(result.height, null);
  });

  it('returns open=true with dimensions when screener is visible', async () => {
    const evaluate = mockEvaluate([{ open: true, width: 540, height: 772, data_loaded: true }]);
    const result = await status({ _deps: { evaluate } });
    assert.equal(result.open, true);
    assert.equal(result.width, 540);
    assert.equal(result.height, 772);
  });

  it('status check expression references screenerContainer and js-dialog', async () => {
    const evaluate = mockEvaluate([{ open: false }]);
    await status({ _deps: { evaluate } });
    const expr = evaluate.calls[0];
    assert.match(expr, /screenerContainer/);
    assert.match(expr, /js-dialog/);
    assert.match(expr, /visible-/);
  });
});

// ── open() ───────────────────────────────────────────────────────────────

describe('open()', () => {
  it('returns already_open without clicking when screener already visible', async () => {
    const evaluate = mockEvaluate([{ open: true, width: 540, height: 772, data_loaded: true }]);
    const client = mockClient();
    const result = await open({ _deps: { evaluate, getClient: async () => client } });
    assert.equal(result.action, 'already_open');
    assert.equal(result.open, true);
    assert.equal(client._mouseEvents.length, 0, 'no mouse events dispatched');
  });

  it('dispatches mouse press+release at button center when closed', async () => {
    const evaluate = mockEvaluate([
      { open: false },              // initial status
      { x: 1129.5, y: 519 },        // button rect
      { open: true, width: 540, height: 772, data_loaded: true }, // first poll after click
    ]);
    const client = mockClient();
    const result = await open({ _deps: { evaluate, getClient: async () => client } });
    assert.equal(result.action, 'opened');
    assert.equal(result.open, true);
    const types = client._mouseEvents.map(e => e.type);
    assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(client._mouseEvents[1].x, 1129.5);
    assert.equal(client._mouseEvents[1].y, 519);
    assert.equal(client._mouseEvents[1].button, 'left');
  });

  it('throws when the screener toolbar button is missing', async () => {
    const evaluate = mockEvaluate([{ open: false }, null]);
    const client = mockClient();
    await assert.rejects(
      open({ _deps: { evaluate, getClient: async () => client } }),
      /toolbar button not found/
    );
  });

  it('throws if dialog never appears after clicking', async () => {
    const evaluate = mockEvaluate([
      { open: false },
      { x: 100, y: 200 },
      { open: false }, // every subsequent poll also returns closed
    ]);
    const client = mockClient();
    await assert.rejects(
      open({ _deps: { evaluate, getClient: async () => client } }),
      /did not open within/
    );
  });

  it('returns warning when dialog opens but rows never load', async () => {
    const evaluate = mockEvaluate([
      { open: false },
      { x: 100, y: 200 },
      // every poll: dialog visible but data_loaded=false
      { open: true, width: 540, height: 772, data_loaded: false },
    ]);
    const client = mockClient();
    const result = await open({ _deps: { evaluate, getClient: async () => client } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'opened');
    assert.equal(result.open, true);
    assert.match(result.warning, /rows did not populate/);
  });

  it('rejects non-finite button coordinates from DOM probe', async () => {
    const evaluate = mockEvaluate([{ open: false }, { x: NaN, y: 200 }]);
    const client = mockClient();
    await assert.rejects(
      open({ _deps: { evaluate, getClient: async () => client } }),
      /button\.x must be a finite number/
    );
  });
});

// ── close() ──────────────────────────────────────────────────────────────

describe('close()', () => {
  it('returns already_closed without clicking when screener not visible', async () => {
    const evaluate = mockEvaluate([{ open: false }]);
    const result = await close({ _deps: { evaluate } });
    assert.equal(result.action, 'already_closed');
    assert.equal(result.open, false);
    // Only the status check was executed — no close click issued
    assert.equal(evaluate.calls.length, 1);
  });

  it('clicks close button when open and polls for close', async () => {
    const evaluate = mockEvaluate([
      { open: true, width: 540, height: 772, data_loaded: true }, // initial status
      { found: true },                         // close button click result
      { open: false },                         // first poll after click
    ]);
    const result = await close({ _deps: { evaluate } });
    assert.equal(result.action, 'closed');
    assert.equal(result.open, false);
  });

  it('throws descriptive error when close button missing', async () => {
    const evaluate = mockEvaluate([
      { open: true, width: 540, height: 772, data_loaded: true },
      { found: false, reason: 'no_close_button' },
    ]);
    await assert.rejects(
      close({ _deps: { evaluate } }),
      /no_close_button/
    );
  });

  it('throws if dialog does not disappear after click', async () => {
    const evaluate = mockEvaluate([
      { open: true, width: 540, height: 772, data_loaded: true },
      { found: true },
      { open: true, width: 540, height: 772, data_loaded: true },
    ]);
    await assert.rejects(
      close({ _deps: { evaluate } }),
      /did not close within/
    );
  });
});

// ── get() ────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns error when screener is not open', async () => {
    const evaluate = mockEvaluate([{ open: false }]);
    const result = await get({ _deps: { evaluate } });
    assert.equal(result.success, false);
    assert.equal(result.open, false);
    assert.match(result.error, /not open/);
  });

  it('maps columns to values per row', async () => {
    const evaluate = mockEvaluate([{
      open: true,
      title: 'All stocks',
      columns: ['Symbol', 'Price', 'Change %'],
      row_count: 100,
      returned: 2,
      rows: [
        { symbol: 'NVDA', Price: '196.51 USD', 'Change %': '+3.80%' },
        { symbol: 'AAPL', Price: '258.83 USD', 'Change %': '-0.14%' },
      ],
      filters: ['Price', 'Market cap'],
    }]);
    const result = await get({ _deps: { evaluate } });
    assert.equal(result.success, true);
    assert.equal(result.open, true);
    assert.equal(result.screen, 'All stocks');
    assert.deepEqual(result.columns, ['Symbol', 'Price', 'Change %']);
    assert.equal(result.row_count, 100);
    assert.equal(result.returned, 2);
    assert.equal(result.rows[0].symbol, 'NVDA');
    assert.equal(result.rows[0]['Price'], '196.51 USD');
    assert.deepEqual(result.filters, ['Price', 'Market cap']);
  });

  it('clamps limit into [1, 500] when computing the query', async () => {
    const evaluate = mockEvaluate([{
      open: true, title: '', columns: [], row_count: 0, returned: 0, rows: [], filters: [],
    }]);
    await get({ limit: 9999, _deps: { evaluate } });
    // Max = 500 so the generated expression must reference that cap
    assert.match(evaluate.calls[0], /500\)/);

    const ev2 = mockEvaluate([{
      open: true, title: '', columns: [], row_count: 0, returned: 0, rows: [], filters: [],
    }]);
    await get({ limit: 0, _deps: { evaluate: ev2 } });
    // Min = 1
    assert.match(ev2.calls[0], /, 1\)/);
  });

  it('defaults limit to 100 when not provided', async () => {
    const evaluate = mockEvaluate([{
      open: true, title: '', columns: [], row_count: 0, returned: 0, rows: [], filters: [],
    }]);
    await get({ _deps: { evaluate } });
    assert.match(evaluate.calls[0], /, 100\)/);
  });

  it('propagates table_not_found error from the DOM probe', async () => {
    const evaluate = mockEvaluate([{ open: true, error: 'table_not_found' }]);
    const result = await get({ _deps: { evaluate } });
    assert.equal(result.success, false);
    assert.equal(result.open, true);
    assert.equal(result.error, 'table_not_found');
  });
});
