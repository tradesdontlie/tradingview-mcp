// Test AC1 (SPEC-scan-hang-fix.md TASK A): CDP evaluate timeout + client reset.
//
// mock.module (node:test) does NOT support CommonJS modules in Node 24.15 — its
// mocked namespace comes back empty for CJS (verified with probe). Spec-sanctioned
// fallback: create a transient ESM stub package at src/node_modules/chrome-remote-interface/
// so `import CDP from 'chrome-remote-interface'` inside src/connection.js resolves to
// the fake (node_modules override wins over the real CJS package; real package in the
// repo root is never touched). The stub is created in before() and removed in after().
// Contract kept: AC1 (a)-(d).
//
// Run: node test_connection_timeout.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stubDir = join(here, 'src', 'node_modules', 'chrome-remote-interface');
const state = { factoryCalls: 0, hang: false, lastParams: null };

before(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'package.json'), JSON.stringify({
    name: 'chrome-remote-interface', version: '0.0.0-stub', type: 'module', main: 'index.mjs',
  }));
  writeFileSync(join(stubDir, 'index.mjs'), `
const state = globalThis.__CDP_FAKE_STATE__;
export default async () => {
  state.factoryCalls++;
  return {
    Runtime: {
      enable: async () => {},
      evaluate: async (params) => {
        state.lastParams = params;
        if (params.expression === '1') return { result: { value: 1 } }; // liveness always OK
        if (state.hang) return new Promise(() => {}); // never resolves (wedged page)
        return { result: { value: 42 } };
      },
    },
    Page: { enable: async () => {} },
    DOM: { enable: async () => {} },
    close: async () => {},
  };
};
`);
  globalThis.__CDP_FAKE_STATE__ = state;
});

after(() => {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(join(here, 'src', 'node_modules'), { recursive: true, force: true }); // created by us; src/node_modules did not exist before
  delete globalThis.__CDP_FAKE_STATE__;
});

async function reset(connection) {
  await connection.disconnect(); // drop cached fake client so next call re-connects
  state.factoryCalls = 0;
  state.hang = false;
  state.lastParams = null;
}

test('AC1(d): evaluate resolves normally with a single CDP call', async () => {
  const { evaluate } = await import('./src/connection.js');
  await reset({ disconnect: async () => {} }); // no client yet on first import

  const value = await evaluate('40+2', { timeout: 300 });
  assert.equal(value, 42);
  assert.equal(state.factoryCalls, 1, 'CDP factory must be called exactly once on the happy path');
  assert.equal(state.lastParams.timeout, undefined, 'timeout must NOT be forwarded to CDP params');
});

test('AC1(a/b/c): non-resolving evaluate times out, resets client, retries once, and never forwards timeout to CDP', async () => {
  const { evaluate, disconnect } = await import('./src/connection.js');
  await reset({ disconnect });

  state.hang = true;
  const t0 = Date.now();
  await assert.rejects(
    evaluate('window.blockedMainThread()', { timeout: 300 }),
    /CDP evaluate.*timed out after 300ms/
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `expected reject within 2s for timeout:300, took ${elapsed}ms`);
  assert.ok(state.factoryCalls >= 2, `expected >=2 CDP factory calls (reset+retry), got ${state.factoryCalls}`);
  assert.equal(state.lastParams.timeout, undefined, 'timeout must NOT be forwarded to CDP params');
});

test('evaluateAsync delegates to evaluate with awaitPromise:true and still resolves', async () => {
  const { evaluateAsync, disconnect } = await import('./src/connection.js');
  await reset({ disconnect });

  const value = await evaluateAsync('40+2');
  assert.equal(value, 42);
  assert.equal(state.lastParams.awaitPromise, true);
  assert.equal(state.lastParams.timeout, undefined);
  assert.equal(state.factoryCalls, 1);
});
