import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { main } from '../src/cli/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexUrl = pathToFileURL(join(__dirname, '..', 'src', 'cli', 'index.js')).href;

test('importing src/cli/index.js does not execute the CLI', () => {
  const result = spawnSync('node', [
    '--input-type=module',
    '-e',
    `import ${JSON.stringify(indexUrl)}; console.log('imported');`,
  ], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'imported');
  assert.equal(result.stderr.trim(), '');
});

test('main disconnects after a successful run', async () => {
  let disconnected = false;

  const exitCode = await main(['node', 'tv', '--help'], {
    run: async () => 0,
    disconnect: async () => {
      disconnected = true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(disconnected, true);
});

test('main disconnects after a failing run and preserves the exit code', async () => {
  let disconnected = false;

  const exitCode = await main(['node', 'tv', 'status'], {
    run: async () => 2,
    disconnect: async () => {
      disconnected = true;
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(disconnected, true);
});
