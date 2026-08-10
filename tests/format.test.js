/**
 * Tests for the shared MCP response formatting helper.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResult } from '../src/tools/_format.js';

describe('jsonResult() — MCP response formatting', () => {
  it('wraps an object as pretty-printed JSON text content', () => {
    const result = jsonResult({ success: true, value: 42 });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: JSON.stringify({ success: true, value: 42 }, null, 2) }],
    });
  });

  it('does not set isError by default', () => {
    const result = jsonResult({ success: true });
    assert.equal('isError' in result, false);
  });

  it('sets isError: true when the isError flag is passed', () => {
    const result = jsonResult({ success: false, error: 'boom' }, true);
    assert.equal(result.isError, true);
  });
});
