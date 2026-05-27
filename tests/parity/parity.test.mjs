/**
 * Numerical parity tests: tradingview-mcp JS implementations vs the canonical
 * Python reference in siyolah-v3 scripts/inference_upgrades.py.
 *
 * Fixtures live in tests/parity/fixtures/. Regenerate via:
 *   python tests/parity/generate_python_fixtures.py
 *
 * If fixtures are missing the tests skip with a clear message instead of failing.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pboCscv, hacInference, deflateSharpeSiyolah } from '../../src/core/quant.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function loadFixture(name) {
  const p = join(FIXTURES, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function assertClose(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    assert.equal(actual, expected, label);
    return;
  }
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= tolerance,
    `${label}: actual=${actual} expected=${expected} diff=${diff} tol=${tolerance}`);
}

test('alpha_pbo_cscv parity vs siyolah-v3 pbo_cscv', { concurrency: false }, (t) => {
  const fx = loadFixture('pbo.json');
  if (!fx) {
    t.skip('fixtures/pbo.json missing — run `python tests/parity/generate_python_fixtures.py` first');
    return;
  }
  const result = pboCscv(fx.input);
  assert.equal(result.success, true, 'pboCscv returned success=true');
  assertClose(result.pbo, fx.expected.pbo, fx.tolerance, 'pbo');
});

test('alpha_hac_inference parity vs siyolah-v3 newey_west_se (intercept-only)', { concurrency: false }, (t) => {
  const fx = loadFixture('hac.json');
  if (!fx) {
    t.skip('fixtures/hac.json missing — run `python tests/parity/generate_python_fixtures.py` first');
    return;
  }
  const result = hacInference(fx.input);
  assert.equal(result.success, true);
  const tArith = fx.tolerance_arith ?? 1e-10;
  const tCdf = fx.tolerance_cdf ?? 1e-6;
  assertClose(result.mean, fx.expected.mean, tArith, 'mean');
  assertClose(result.hac_se, fx.expected.hac_se, tArith, 'hac_se');
  assertClose(result.t_zero, fx.expected.t_zero, tArith, 't_zero');
  assertClose(result.t_breakeven, fx.expected.t_breakeven, tArith, 't_breakeven');
  assertClose(result.p_one_sided_zero, fx.expected.p_one_sided_zero, tCdf, 'p_one_sided_zero');
  assertClose(result.p_one_sided_breakeven, fx.expected.p_one_sided_breakeven, tCdf, 'p_one_sided_breakeven');
  assert.equal(result.lag_used, fx.expected.lag_used, 'lag_used');
});

test('alpha_deflate_sharpe_siyolah parity vs siyolah-v3 deflated_sharpe_ratio', { concurrency: false }, (t) => {
  const fx = loadFixture('dsr.json');
  if (!fx) {
    t.skip('fixtures/dsr.json missing — run `python tests/parity/generate_python_fixtures.py` first');
    return;
  }
  const result = deflateSharpeSiyolah(fx.input);
  assert.equal(result.success, true);
  const tol = fx.tolerance;
  assertClose(result.sharpe, fx.expected.sharpe, 1e-12, 'sharpe (pure arithmetic)');
  assertClose(result.expected_max_sharpe_under_null, fx.expected.expected_max_sharpe_under_null, tol, 'sr0');
  assertClose(result.dsr, fx.expected.dsr, tol, 'dsr');
});
