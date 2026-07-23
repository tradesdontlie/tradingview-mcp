/**
 * Tests for the zero-dependency .env.local loader (src/load-env.js) — T132.
 * Verifies KEY=VALUE parsing, comment/blank skipping, base64 `=` in values,
 * and no-override semantics (real env wins). Token-free: uses a temp fixture,
 * never the real .env.local.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnvFile } from '../src/load-env.js';

describe('parseEnv', () => {
  it('parses KEY=VALUE lines', () => {
    assert.deepEqual(parseEnv('A=1\nB=two'), { A: '1', B: 'two' });
  });
  it('skips blanks and # comments', () => {
    assert.deepEqual(parseEnv('\n# comment\nA=1\n   \n'), { A: '1' });
  });
  it('keeps `=` inside the value (base64 padding)', () => {
    assert.deepEqual(parseEnv('SIG=abc=='), { SIG: 'abc==' });
  });
  it('ignores lines with no `=`', () => {
    assert.deepEqual(parseEnv('NOEQ\nA=1'), { A: '1' });
  });
});

describe('loadEnvFile', () => {
  it('loads new keys but never overrides existing env (real env wins)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envtest-'));
    const f = join(dir, '.env.local');
    writeFileSync(f, 'NEW=fresh\nEXISTING=fromfile\n');
    const env = { EXISTING: 'preset' };
    loadEnvFile(f, env);
    assert.equal(env.NEW, 'fresh');       // new key loaded
    assert.equal(env.EXISTING, 'preset'); // pre-set value preserved
    rmSync(dir, { recursive: true, force: true });
  });
  it('is a no-op when the file is missing', () => {
    const env = { A: '1' };
    assert.deepEqual(loadEnvFile('/nonexistent/path/.env.local', env), {});
    assert.deepEqual(env, { A: '1' });
  });
});
