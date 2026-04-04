import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, '..', 'scripts', 'tv-agent.js');
const TMP_PREFIX = join(tmpdir(), 'tv-agent-wrapper-');

function runWrapper(args, options = {}) {
  return spawnSync('node', [WRAPPER, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('wrapper shows tv help from a different cwd', () => {
  const cwd = mkdtempSync(TMP_PREFIX);
  const result = spawnSync('node', [WRAPPER, '--help'], {
    cwd,
    encoding: 'utf8',
  });

  try {
    assert.notEqual(cwd, process.cwd());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: tv/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('wrapper preserves CLI exit code for unknown commands', () => {
  const cwd = mkdtempSync(TMP_PREFIX);
  const result = runWrapper(['nonexistent'], {
    cwd,
  });

  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('wrapper forwards stdin to the CLI', () => {
  const cwd = mkdtempSync(TMP_PREFIX);
  const source = '//@version=6\nindicator("test")\nplot(close)';
  const result = runWrapper(['pine', 'analyze'], {
    cwd,
    input: source,
  });

  try {
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.issue_count, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
