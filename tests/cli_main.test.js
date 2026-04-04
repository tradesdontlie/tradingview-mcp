import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/index.js';

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
