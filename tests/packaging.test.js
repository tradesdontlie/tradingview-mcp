/**
 * Release smoke test for the published package.
 *
 * Packs the tarball, installs it into a throwaway prefix, and launches the package's declared
 * `tradingview-mcp` bin with EOF on stdin. Asserts the server prints its startup banner and
 * exits cleanly. This catches two ways a tarball can be born broken:
 *   - an unresolvable / wrong bin entrypoint, and
 *   - an imported module excluded by the `files` whitelist (server.js fails to import its deps).
 *
 * Heavyweight (runs `npm pack` + `npm install`, needs network for runtime deps), so it is NOT
 * part of `test:unit`. It is wired into `prepublishOnly` and run via `npm run test:smoke`.
 *
 * Run: node --test tests/packaging.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Node >=20.12 refuses to spawn a Windows .cmd (npm.cmd) without a shell (CVE-2024-27980), so run
// npm through the shell and quote any path arg that might contain spaces.
const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
// Pass one command string (not command+args) so shell:true does not trip DEP0190.
const npmRun = (args, opts) =>
  spawnSync(['npm', ...args.map(q)].join(' '), { encoding: 'utf8', shell: true, ...opts });

test('packed tarball installs and its bin launches the server', { timeout: 180_000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'tvmcp-smoke-'));
  try {
    // 1. Pack the tarball into the work dir.
    const packed = npmRun(['pack', '--json', '--pack-destination', work], { cwd: repoRoot });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
    const tarball = path.join(work, JSON.parse(packed.stdout)[0].filename);
    assert.ok(existsSync(tarball), `tarball not produced at ${tarball}`);

    // 2. Install the tarball into a clean prefix (runtime deps only).
    const prefix = path.join(work, 'install');
    const installed = npmRun([
      'install', tarball, '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', '--omit=dev',
    ]);
    assert.equal(installed.status, 0, `npm install of tarball failed:\n${installed.stderr}`);

    // 3. Resolve the package's declared bin (not a hard-coded path).
    const pkgDir = path.join(prefix, 'node_modules', '@specialagentk', 'tradingview-mcp');
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(pkg.bin ?? {}),
      ['tradingview-mcp'],
      'published package must declare exactly one bin: tradingview-mcp',
    );
    const binPath = path.join(pkgDir, pkg.bin['tradingview-mcp']);
    assert.ok(existsSync(binPath), `declared bin missing from tarball: ${binPath}`);

    // 4. Launch the bin; EOF stdin makes the stdio server exit cleanly.
    const { code, stderr } = await launch(binPath);
    assert.match(stderr, /tradingview-mcp/, `startup banner missing from stderr:\n${stderr}`);
    assert.equal(code, 0, `server did not exit cleanly (code ${code}):\n${stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

function launch(binPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    // No input -> immediate EOF; the MCP stdio transport ends and the process exits.
    child.stdin.end();
    // Safety net: never hang the suite if the server fails to exit on EOF.
    setTimeout(() => child.kill(), 15_000).unref();
  });
}
