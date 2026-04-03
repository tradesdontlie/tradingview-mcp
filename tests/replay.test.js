/**
 * Tests for replay.js — autoplay delay validation and hideReplayToolbar removal.
 * Covers the fixes for issue #19 (cloud account state corruption).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Direct import for autoplay validation test
import { autoplay, setResolution } from '../src/core/replay.js';

const VALID_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

describe('replay autoplay — delay validation', () => {
  for (const delay of VALID_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      // autoplay() will throw on CDP connection since TradingView isn't running,
      // but it should NOT throw the validation error for valid delays.
      try {
        await autoplay({ speed: delay });
      } catch (err) {
        // Connection errors are expected (no TradingView running).
        // Validation errors are NOT expected.
        assert.ok(
          !err.message.includes('Invalid autoplay delay'),
          `Valid delay ${delay} was rejected: ${err.message}`,
        );
      }
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms`, async () => {
      await assert.rejects(
        () => autoplay({ speed: delay }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          assert.ok(err.message.includes('Valid values:'));
          return true;
        },
      );
    });
  }

  it('skips validation when speed is 0 (just toggle)', async () => {
    try {
      await autoplay({ speed: 0 });
    } catch (err) {
      assert.ok(
        !err.message.includes('Invalid autoplay delay'),
        `speed=0 should skip validation: ${err.message}`,
      );
    }
  });

  it('skips validation when speed is omitted', async () => {
    try {
      await autoplay({});
    } catch (err) {
      assert.ok(
        !err.message.includes('Invalid autoplay delay'),
        `omitted speed should skip validation: ${err.message}`,
      );
    }
  });
});

describe('replay setResolution — interval validation', () => {
  // Valid resolutions are dynamic (depend on chart timeframe), so validation
  // happens at runtime by querying TradingView. Without a live connection,
  // we can only verify that "auto"/omitted resolve correctly before the CDP call.

  it('accepts "auto" (resolves to null internally, no validation error)', async () => {
    try {
      await setResolution({ interval: 'auto' });
    } catch (err) {
      // Connection errors are expected (no TradingView running).
      // Validation errors should NOT happen for "auto".
      assert.ok(
        !err.message.includes('Invalid replay resolution'),
        `"auto" should be accepted: ${err.message}`,
      );
    }
  });

  it('accepts omitted interval (defaults to auto)', async () => {
    try {
      await setResolution({});
    } catch (err) {
      assert.ok(
        !err.message.includes('Invalid replay resolution'),
        `omitted interval should default to auto: ${err.message}`,
      );
    }
  });

  it('setResolution is exported and callable', () => {
    assert.equal(typeof setResolution, 'function');
  });
});

describe('replay — no hideReplayToolbar calls (issue #19)', () => {
  it('stop() does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    const stopFn = source.slice(source.indexOf('export async function stop('));
    const stopBody = stopFn.slice(0, stopFn.indexOf('\nexport ') > 0 ? stopFn.indexOf('\nexport ') : stopFn.length);
    assert.ok(
      !stopBody.includes('hideReplayToolbar'),
      'stop() must not call hideReplayToolbar — it corrupts cloud account state',
    );
  });

  it('start() error recovery does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    // Check the toast error recovery block specifically
    const toastBlock = source.slice(source.indexOf('if (toast)'), source.indexOf('const started = await'));
    assert.ok(
      !toastBlock.includes('hideReplayToolbar'),
      'start() error recovery must not call hideReplayToolbar — it corrupts cloud account state',
    );
  });

  it('hideReplayToolbar appears nowhere in the file', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(
      !source.includes('hideReplayToolbar'),
      'hideReplayToolbar must not appear anywhere in replay.js — it syncs hidden state to cloud account',
    );
  });
});
