import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, '..', 'scripts', 'tv-agent.js');

test('wrapper shows tv help from any cwd', () => {
  const result = spawnSync('node', [WRAPPER, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tv/);
});

test('wrapper preserves CLI exit code for unknown commands', () => {
  const result = spawnSync('node', [WRAPPER, 'nonexistent'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});
