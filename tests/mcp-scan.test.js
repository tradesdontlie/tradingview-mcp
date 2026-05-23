/**
 * mcp-scan.test.js — Offline tests for cli/scan.js and mcpDataProvider.
 *
 * All tests run without a TradingView connection.
 * The CLI smoke tests rely on MCP connect/health failing fast (ECONNREFUSED)
 * when port 9222 is not open.
 *
 * Run: node --test tests/mcp-scan.test.js
 */

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { spawnSync }    from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { normalizeBar }  from '../data/mcpDataProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN      = join(__dirname, '..', 'cli', 'scan.js');

/** Spawns cli/scan.js with given args, returns spawnSync result. */
function runScan(args = [], timeoutMs = 25_000) {
  return spawnSync('node', [SCAN, ...args], {
    timeout:  timeoutMs,
    encoding: 'utf8',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeBar() — pure unit tests, no process spawn
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeBar()', () => {
  it('handles TradingView format { time(s), open, high, low, close, volume }', () => {
    const b = { time: 1748000000, open: 100, high: 102, low: 99, close: 101, volume: 1000 };
    const n = normalizeBar(b);
    assert.equal(n.ts,    1748000000 * 1000, 'ts should be converted to ms');
    assert.equal(n.open,  100);
    assert.equal(n.high,  102);
    assert.equal(n.low,    99);
    assert.equal(n.close, 101);
    assert.equal(n.vol,  1000);
  });

  it('converts seconds to milliseconds when timestamp < 1e12', () => {
    const b = { time: 1_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
    const n = normalizeBar(b);
    assert.equal(n.ts, 1_000_000 * 1000);
  });

  it('leaves millisecond timestamps unchanged', () => {
    const b = { ts: 1_748_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10 };
    const n = normalizeBar(b);
    assert.equal(n.ts, 1_748_000_000_000);
  });

  it('handles shorthand field names { o, h, l, c, v }', () => {
    const b = { ts: 1_748_000_000, o: 100, h: 102, l: 99, c: 101, v: 500 };
    const n = normalizeBar(b);
    assert.equal(n.open,  100);
    assert.equal(n.high,  102);
    assert.equal(n.low,    99);
    assert.equal(n.close, 101);
    assert.equal(n.vol,   500);
  });

  it('defaults missing vol/volume/v to 0', () => {
    const b = { time: 1_748_000_000, open: 1, high: 2, low: 0.5, close: 1.5 };
    assert.equal(normalizeBar(b).vol, 0);
  });

  it('returns zero-value object for null/non-object input', () => {
    const n = normalizeBar(null);
    assert.equal(n.ts,    0);
    assert.equal(n.close, 0);
    assert.equal(n.vol,   0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cli/scan.js — offline smoke tests (spawnSync, no TradingView required)
// ─────────────────────────────────────────────────────────────────────────────

describe('scan.js CLI (offline)', () => {
  it('--help exits 0 and stdout includes "Usage:"', () => {
    const r = runScan(['--help']);
    assert.equal(r.status, 0, `unexpected exit code. stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage:'), 'stdout should include Usage:');
  });

  it('--symbol INVALID exits 1', () => {
    const r = runScan(['--symbol', 'INVALID_SYM']);
    assert.equal(r.status, 1, 'invalid symbol should exit 1');
  });

  it('no TradingView: exits 0 (does not crash)', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    // spawnSync sets status=null and error if it times out
    assert.ok(r.error == null, `process timed out or errored: ${r.error}`);
    assert.equal(r.status, 0, `expected exit 0. stderr: ${r.stderr}`);
  });

  it('no TradingView: stdout is valid JSON', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    assert.doesNotThrow(
      () => JSON.parse(r.stdout),
      'stdout must be valid JSON',
    );
  });

  it('no TradingView: stdout starts with { (no leading log lines)', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    assert.ok(
      r.stdout.trim().startsWith('{'),
      `stdout must start with JSON object, got: ${r.stdout.slice(0, 40)}`,
    );
  });

  it('no TradingView: decision === WAIT', () => {
    const r  = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.equal(sig.decision, 'WAIT', `decision should be WAIT, got: ${sig.decision}`);
  });

  it('no TradingView: all required signal schema fields are present', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    const required = [
      'id', 'timestamp', 'date', 'time', 'symbol', 'decision',
      'bias', 'setup', 'entry', 'stop', 'tp1', 'tp2', 'r',
      'confidence', 'reasons', 'invalidation', 'what_would_change',
      'status', 'outcome_r',
    ];
    for (const field of required) {
      assert.ok(field in sig, `missing required field: "${field}"`);
    }
  });

  it('no TradingView: bias object has all four timeframe keys', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.ok(typeof sig.bias === 'object' && sig.bias !== null, 'bias must be an object');
    for (const tf of ['4H', '1H', '15m', '5m']) {
      assert.ok(tf in sig.bias, `bias missing key: "${tf}"`);
    }
  });

  it('no TradingView: reasons is a non-empty array', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.ok(Array.isArray(sig.reasons),      'reasons must be an array');
    assert.ok(sig.reasons.length > 0,          'reasons must not be empty');
  });

  it('no TradingView: default symbol is MNQ1! when --symbol is omitted', () => {
    const r   = runScan([]);   // no --symbol flag
    const sig = JSON.parse(r.stdout);
    assert.equal(sig.symbol, 'MNQ1!', 'default symbol should be MNQ1!');
  });
});
