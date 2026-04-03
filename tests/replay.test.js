/**
 * Replay safety tests for issue #19.
 * These tests are offline and only verify local guardrails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { autoplay } from '../src/core/replay.js';

const INVALID_DELAYS = [50, 99, 101, 500, 750, 1500, 9999, 20000, 60000];
const EXPECTED_DELAYS = '[100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000]';

describe('replay autoplay guardrails', () => {
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms`, async () => {
      await assert.rejects(
        () => autoplay({ speed: delay }),
        err => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          assert.ok(err.message.includes('Valid values:'));
          return true;
        },
      );
    });
  }

  it('keeps the exact safe delay list in source', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(source.includes(`const VALID_AUTOPLAY_DELAYS = ${EXPECTED_DELAYS};`));
  });
});

describe('replay toolbar safety', () => {
  it('replay core does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'));
  });
});
