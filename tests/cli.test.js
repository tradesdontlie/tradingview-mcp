/**
 * CLI unit tests — no TradingView connection needed.
 * Tests: help output, pine analyze, pine check, error handling, exit codes.
 *
 * Run: node --test tests/cli.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync } from 'fs';

function require_fs() { return { writeFileSync, unlinkSync }; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('CLI — help and routing', () => {
  it('--help shows command list', () => {
    const { stdout, exitCode } = run(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
    assert.ok(stdout.includes('status'));
    assert.ok(stdout.includes('pine'));
    assert.ok(stdout.includes('quote'));
  });

  it('-h is same as --help', () => {
    const { stdout, exitCode } = run(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('no args shows help', () => {
    const { stdout, exitCode } = run([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('unknown command exits 1', () => {
    const { exitCode, stderr } = run(['nonexistent']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });

  it('pine --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pine', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('set'));
    assert.ok(stdout.includes('compile'));
    assert.ok(stdout.includes('analyze'));
    assert.ok(stdout.includes('check'));
  });

  it('ohlcv --help shows options', () => {
    const { stdout, exitCode } = run(['ohlcv', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--count'));
    assert.ok(stdout.includes('--summary'));
  });
});

describe('CLI — pine analyze (offline)', () => {
  it('analyzes clean v6 script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.issue_count, 0);
  });

  it('detects array out of bounds', () => {
    const source = '//@version=6\nindicator("test")\narr = array.from(1, 2, 3)\nval = array.get(arr, 5)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.issue_count, 1);
    assert.ok(result.diagnostics[0].message.includes('out of bounds'));
  });

  it('detects strategy.entry without strategy()', () => {
    const source = '//@version=6\nindicator("test")\nstrategy.entry("long", strategy.long)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.diagnostics.some(d => d.message.includes('strategy()')));
  });

  it('errors without input', () => {
    // When stdin is a TTY (no pipe), analyze should error
    const { exitCode, stderr } = run(['pine', 'analyze']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('No source provided'));
  });

  it('reads --file flag', () => {
    const { writeFileSync, unlinkSync } = require_fs();
    const tmpFile = join(__dirname, '_test_script.pine');
    writeFileSync(tmpFile, '//@version=6\nindicator("test")\nplot(close)');
    try {
      const { stdout, exitCode } = run(['pine', 'analyze', '--file', tmpFile]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.success, true);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe('CLI — pine check (server compile)', () => {
  it('compiles valid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns errors for invalid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(nonexistent_var)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });
});

describe('CLI — backtest-from-signals (no TV connection needed)', () => {
  it('computes P&L from a JSONL series + rules file', () => {
    const { writeFileSync, unlinkSync } = require_fs();
    const seriesFile = join(__dirname, '_test_series.jsonl');
    const rulesFile = join(__dirname, '_test_rules.json');
    writeFileSync(seriesFile, [
      JSON.stringify({ t: 1, values: { close: 100, e: 1, x: 0 } }),
      JSON.stringify({ t: 2, values: { close: 110, e: 0, x: 1 } }),
    ].join('\n'));
    writeFileSync(rulesFile, JSON.stringify({
      entry: { field: 'e', op: 'truthy' }, exit: { field: 'x', op: 'truthy' }, price_field: 'close',
    }));
    try {
      const { stdout, exitCode } = run(['backtest-from-signals', '--series', seriesFile, '--rules', rulesFile]);
      assert.equal(exitCode, 0);
      const r = JSON.parse(stdout);
      assert.equal(r.total_trades, 1);
      assert.equal(r.net_profit, 10);
      assert.equal(r.trades[0].exit_price, 110);
    } finally {
      unlinkSync(seriesFile);
      unlinkSync(rulesFile);
    }
  });
});
