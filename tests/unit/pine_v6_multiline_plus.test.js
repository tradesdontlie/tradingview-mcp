import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/core/pine.js';

/**
 * C10 / A1-F10: pine_lint must flag Pine v6 multi-line `+` continuations
 * that are not wrapped in parentheses. The audit (CC TV MCP.txt:335)
 * surfaced "Mismatched input '+' expecting end of line at line 14" only
 * via a user-supplied screenshot.
 */

describe('analyze — v6-multi-line-plus rule (C10)', () => {
  it('flags leading-+ on a continuation line not inside parens', () => {
    const src = `//@version=6
indicator("EarnsExtractor")
label.new(bar_index, close,
   "EARN|" + str.tostring(close)
   + " | est=" + str.tostring(estimate))
`;
    // This source is actually OK (inside the label.new() parens). But the
    // pathological case from the audit is the SAME pattern OUTSIDE parens:
    const bad = `//@version=6
indicator("X")
text = "EARN|" + str.tostring(close)
       + " | est=" + str.tostring(close + 1)
plot(close)
`;
    const r = analyze({ source: bad });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.ok(v6Hits.length >= 1, `expected at least one v6-multi-line-plus diagnostic, got ${JSON.stringify(r.diagnostics)}`);
    assert.equal(v6Hits[0].severity, 'error');
    assert.match(v6Hits[0].message, /Pine v6 does not support implicit line continuation/);
    assert.match(v6Hits[0].message, /C10\/A1-F10/);
  });

  it('does NOT flag leading-+ inside open parens (label.new continuation)', () => {
    const src = `//@version=6
indicator("X")
label.new(bar_index, close,
   "EARN|" + str.tostring(close)
   + " | est=" + str.tostring(close + 1))
plot(close)
`;
    const r = analyze({ source: src });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.equal(v6Hits.length, 0);
  });

  it('does NOT flag when previous line ends with `+`', () => {
    const src = `//@version=6
indicator("X")
text = "EARN|" +
       str.tostring(close)
plot(close)
`;
    const r = analyze({ source: src });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.equal(v6Hits.length, 0);
  });

  it('does NOT flag clean scripts', () => {
    const src = `//@version=6
indicator("Clean")
length = input.int(14)
rsi = ta.rsi(close, length)
plot(rsi)
`;
    const r = analyze({ source: src });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.equal(v6Hits.length, 0);
  });

  it('does NOT false-positive inside a string literal', () => {
    const src = `//@version=6
indicator("Plus in comment")
// Some + comment with + plus signs
note = "1 + 2 = 3"
plot(close)
`;
    const r = analyze({ source: src });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.equal(v6Hits.length, 0);
  });

  it('respects line numbering (1-based)', () => {
    const src = `//@version=6
indicator("X")
foo = "a" + "b"
text = "c"
       + "d"
plot(close)
`;
    const r = analyze({ source: src });
    const v6Hits = r.diagnostics.filter(d => /v6-multi-line-plus/.test(d.message));
    assert.equal(v6Hits.length, 1);
    assert.equal(v6Hits[0].line, 5);
  });
});
