/**
 * Input-validation guards that must reject BEFORE any chart/CDP side effect.
 * These run offline: each guard throws before the function touches connection.js,
 * so a live TradingView is never needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { focus, setSymbol } from '../src/core/pane.js';
import { batchRun, BATCH_ACTIONS, MAX_BATCH_ITERATIONS } from '../src/core/batch.js';
import { add, addBulk, remove } from '../src/core/watchlist.js';

describe('pane index validation', () => {
  it('rejects non-numeric, negative, and non-integer indices', async () => {
    for (const bad of ['abc', undefined, null, NaN, -1, 1.5, Infinity]) {
      await assert.rejects(() => focus({ index: bad }), /index must be/, `focus(${bad})`);
      await assert.rejects(() => setSymbol({ index: bad, symbol: 'AAPL' }), /index must be/, `setSymbol(${bad})`);
    }
  });
});

describe('batch_run validation', () => {
  it('rejects an empty or non-array symbol list', async () => {
    await assert.rejects(() => batchRun({ symbols: [], action: 'screenshot' }), /non-empty array/);
    await assert.rejects(() => batchRun({ symbols: 'AAPL', action: 'screenshot' }), /non-empty array/);
  });

  it('rejects an unknown action before switching any symbol', async () => {
    await assert.rejects(
      () => batchRun({ symbols: ['AAPL'], action: 'delete_everything' }),
      new RegExp(BATCH_ACTIONS.join('.*')),
    );
  });

  it('rejects a run that exceeds the iteration cap', async () => {
    const symbols = Array.from({ length: MAX_BATCH_ITERATIONS + 1 }, (_, i) => `SYM${i}`);
    await assert.rejects(() => batchRun({ symbols, action: 'screenshot' }), /over the .* cap/);
  });

  it('counts symbols × timeframes against the cap', async () => {
    const symbols = Array.from({ length: 26 }, (_, i) => `SYM${i}`); // 26 × 2 = 52 > 50
    await assert.rejects(
      () => batchRun({ symbols, timeframes: ['D', '60'], action: 'screenshot' }),
      /over the .* cap/,
    );
  });
});

describe('watchlist symbol validation', () => {
  it('rejects a missing or blank single symbol', async () => {
    for (const bad of [undefined, '', '   ', 42]) {
      await assert.rejects(() => add({ symbol: bad }), /non-empty string/, `add(${bad})`);
    }
  });

  it('rejects an empty or non-array symbol list for add_bulk and remove', async () => {
    for (const fn of [addBulk, remove]) {
      await assert.rejects(() => fn({ symbols: [] }), /non-empty array/);
      await assert.rejects(() => fn({ symbols: undefined }), /non-empty array/);
      await assert.rejects(() => fn({ symbols: ['AAPL', ''] }), /non-empty string/);
    }
  });
});
