/**
 * Tests for the shared MCP response formatter (src/tools/_format.js).
 * jsonResult() is used by every tool file, so its output shape and the
 * conditional isError flag are worth pinning down.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResult } from '../src/tools/_format.js';

describe('jsonResult', () => {
  it('wraps an object in the MCP content shape with pretty-printed JSON', () => {
    const result = jsonResult({ success: true, value: 42 });
    assert.deepEqual(result.content, [
      { type: 'text', text: JSON.stringify({ success: true, value: 42 }, null, 2) },
    ]);
  });

  it('round-trips the payload through the text field', () => {
    const payload = { a: 1, nested: { b: [2, 3], c: 'x' } };
    const result = jsonResult(payload);
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
  });

  it('pretty-prints with 2-space indentation', () => {
    const result = jsonResult({ a: 1 });
    assert.ok(result.content[0].text.includes('\n  "a": 1'));
  });

  it('omits isError when not an error (default)', () => {
    const result = jsonResult({ ok: true });
    assert.ok(!('isError' in result), 'isError should be absent by default');
  });

  it('omits isError when isError is explicitly false', () => {
    const result = jsonResult({ ok: true }, false);
    assert.ok(!('isError' in result), 'isError should be absent when false');
  });

  it('sets isError: true when flagged as an error', () => {
    const result = jsonResult({ error: 'boom' }, true);
    assert.equal(result.isError, true);
  });
});
