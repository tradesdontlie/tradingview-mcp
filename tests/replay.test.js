import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { replayDateToUnixSeconds } from '../src/tools/replay.js';

describe('replayDateToUnixSeconds', () => {
  it('keeps unix second strings as numbers', () => {
    assert.equal(replayDateToUnixSeconds('1711929600'), 1711929600);
  });

  it('parses YYYY-MM-DD as UTC midnight seconds', () => {
    assert.equal(replayDateToUnixSeconds('2024-04-01'), 1711929600);
  });

  it('parses ISO datetime strings without appending a duplicate time suffix', () => {
    assert.equal(replayDateToUnixSeconds('2024-04-01T12:30:00Z'), 1711974600);
  });

  it('returns null for omitted dates and rejects invalid dates', () => {
    assert.equal(replayDateToUnixSeconds(''), null);
    assert.throws(() => replayDateToUnixSeconds('not-a-date'), /Invalid replay date/);
  });
});
