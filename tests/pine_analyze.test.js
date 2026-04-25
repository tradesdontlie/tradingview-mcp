/**
 * Unit tests for pine_analyze static analysis logic.
 * No TradingView connection needed.
 *
 * Run: node --test tests/pine_analyze.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const describeNetwork = process.env.SKIP_NETWORK_TESTS === '1' ? describe.skip : describe;

// Extracted analyze function matching the tool's logic
function analyze(source) {
  const lines = source.split('\n');
  const diagnostics = [];
  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  // Array OOB
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  // Unguarded first/last on empty arrays
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array`,
          severity: 'warning',
        });
      }
    }
  }

  // strategy.entry without strategy()
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1,
          message: 'strategy.entry/close used but no strategy() declaration found',
          severity: 'error',
        });
        break;
      }
    }
  }

  // Old version warning
  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6`,
        severity: 'info',
      });
    }
  }

  return diagnostics;
}

describe('pine_analyze — static analysis', () => {
  it('clean v6 script — no issues', () => {
    const diags = analyze(`//@version=6
indicator("Test", overlay=true)
a = array.from(1, 2, 3)
val = array.get(a, 1)
plot(close)`);
    assert.equal(diags.length, 0);
  });

  it('array.get out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
val = array.get(a, 5)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('out of bounds'));
    assert.ok(diags[0].message.includes('index 5'));
    assert.ok(diags[0].message.includes('size is 3'));
  });

  it('array.get negative index', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
val = array.get(a, -1)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
  });

  it('array.set out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(3)
array.set(a, 10, 99.0)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('array.set'));
  });

  it('array.get valid index — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(10, 20, 30, 40, 50)
val = array.get(a, 4)`);
    assert.equal(diags.length, 0);
  });

  it('.first() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.first()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
    assert.ok(diags[0].message.includes('empty array'));
  });

  it('.last() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.last()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
  });

  it('.first() on non-empty array — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
x = a.first()`);
    assert.equal(diags.length, 0);
  });

  it('strategy.entry without strategy() declaration', () => {
    const diags = analyze(`//@version=6
indicator("Test")
strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('no strategy() declaration'));
  });

  it('strategy.entry WITH strategy() — no issue', () => {
    const diags = analyze(`//@version=6
strategy("Test", overlay=true)
if close > open
    strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 0);
  });

  it('old version v3 warning', () => {
    const diags = analyze(`//@version=3
study("Test")
plot(close)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'info');
    assert.ok(diags[0].message.includes('v3'));
    assert.ok(diags[0].message.includes('upgrading'));
  });

  it('v5 — no version warning', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    assert.equal(diags.length, 0);
  });

  it('multiple issues at once', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
b = array.new_float(0)
x = array.get(a, 5)
y = b.first()
strategy.entry("Long", strategy.long)`);
    assert.ok(diags.length >= 3, `Expected >= 3 issues, got ${diags.length}`);
    const errors = diags.filter(d => d.severity === 'error');
    const warnings = diags.filter(d => d.severity === 'warning');
    assert.ok(errors.length >= 2, 'Should have OOB error + strategy error');
    assert.ok(warnings.length >= 1, 'Should have empty array warning');
  });
});

describeNetwork('pine_check — server compile', () => {
  it('should compile valid Pine Script via TradingView API', async () => {
    const source = `//@version=6
indicator("API Test", overlay=true)
plot(close, "Close", color=color.blue)`;

    const formData = new URLSearchParams();
    formData.append('source', source);

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    assert.ok(response.ok, `API returned ${response.status}`);
    const result = await response.json();
    assert.ok(result.result || result.error === undefined, 'Should compile successfully');
  });

  it('should return errors for invalid Pine Script', async () => {
    const source = `//@version=6
indicator("Bad")
this_function_does_not_exist()`;

    const formData = new URLSearchParams();
    formData.append('source', source);

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    assert.ok(response.ok, `API returned ${response.status}`);
    const result = await response.json();
    // API returns { success: true, result: { errors2: [...] } } for compile errors
    const errors = result?.result?.errors2 || [];
    assert.ok(errors.length > 0, `Should have compilation errors, got: ${JSON.stringify(result).slice(0, 200)}`);
    // Error message may be interpolated or templated (e.g., "Could not find {kind} '{fullName}'")
    const msg = errors[0].message || '';
    const ctx = errors[0].ctx || {};
    const mentionsBadFn = msg.includes('this_function_does_not_exist') || ctx.fullName === 'this_function_does_not_exist';
    assert.ok(mentionsBadFn, 'Error should mention the bad function via message or ctx.fullName');
  });

  it('should handle empty source gracefully', async () => {
    const formData = new URLSearchParams();
    formData.append('source', '');

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    // Empty source returns 400 — that's correct behavior
    assert.ok(response.status === 400 || response.status === 200, `Unexpected status: ${response.status}`);
  });
});
