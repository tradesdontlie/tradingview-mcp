import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routerUrl = pathToFileURL(join(__dirname, '..', 'src', 'cli', 'router.js')).href;
const tempRoot = mkdtempSync(join(tmpdir(), 'tv-cli-exit-'));

function runFixture(errorMessage) {
  const scriptPath = join(tempRoot, 'fixture.mjs');
  const script = `
    import { register, run } from ${JSON.stringify(routerUrl)};

    register('fixture', {
      description: 'fixture',
      handler: () => {
        throw new Error(${JSON.stringify(errorMessage)});
      },
    });

    process.exitCode = await run(['node', 'fixture.mjs', 'fixture']);
  `;

  writeFileSync(scriptPath, script);

  return spawnSync('node', [scriptPath], {
    encoding: 'utf8',
  });
}

test('router returns exit code 2 for connection-style errors', () => {
  const result = runFixture('CDP connection failed after 5 attempts: ECONNREFUSED');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /success": false/);
  assert.match(result.stderr, /CDP connection failed/);
});

test('router returns exit code 1 for generic errors', () => {
  const result = runFixture('plain failure');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plain failure/);
});

process.on('exit', () => {
  rmSync(tempRoot, { recursive: true, force: true });
});
