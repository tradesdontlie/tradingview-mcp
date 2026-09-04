/**
 * Unit tests for the optional JSONL tool-call log.
 * Spawns child processes because TV_MCP_LOG_FILE is read at module load.
 *
 * Run: node --test tests/tool_log.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tv-mcp-log-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// Exercise the logger in a child process with a given TV_MCP_LOG_FILE, then
// return whatever landed in the log.
function run(script, logFile) {
  const env = { ...process.env };
  if (logFile) env.TV_MCP_LOG_FILE = logFile;
  else delete env.TV_MCP_LOG_FILE;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  const lines = logFile && existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { stdout, lines };
}

const CALL_ONE = `
  import { instrument } from './src/core/tool_log.js';
  const server = { tool: (n, d, s, h) => { server._h = h; } };
  instrument(server);
  server.tool('pine_check', 'd', {}, async (a) => ({ content: [{ type: 'text', text: 'ok:' + a.source }] }));
  await server._h({ source: 'plot(close)' });
  console.log('done');
`;

describe('tool_log', () => {
  it('writes one JSON line per call with tool, args, result and duration', () => {
    const logFile = join(dir, 'calls.jsonl');
    const { lines } = run(CALL_ONE, logFile);

    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.tool, 'pine_check');
    assert.deepEqual(entry.args, { source: 'plot(close)' });
    assert.equal(entry.result.is_error, false);
    assert.equal(entry.result.text, 'ok:plot(close)');
    assert.equal(typeof entry.duration_ms, 'number');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  });

  it('writes nothing when TV_MCP_LOG_FILE is unset', () => {
    const logFile = join(dir, 'unset.jsonl');
    const { stdout } = run(CALL_ONE, null);

    assert.match(stdout, /done/);
    assert.equal(existsSync(logFile), false);
  });

  it('records a thrown handler and rethrows it', () => {
    const logFile = join(dir, 'threw.jsonl');
    const { stdout, lines } = run(`
      import { instrument } from './src/core/tool_log.js';
      const server = { tool: (n, d, s, h) => { server._h = h; } };
      instrument(server);
      server.tool('boom', 'd', {}, async () => { throw new Error('kaboom'); });
      await server._h({}).catch((e) => console.log('rethrown:' + e.message));
    `, logFile);

    assert.match(stdout, /rethrown:kaboom/);
    assert.equal(lines[0].threw, 'kaboom');
    assert.equal(lines[0].result, undefined);
  });

  it('truncates huge results so screenshots do not bloat the log', () => {
    const logFile = join(dir, 'big.jsonl');
    const { lines } = run(`
      import { instrument } from './src/core/tool_log.js';
      const server = { tool: (n, d, s, h) => { server._h = h; } };
      instrument(server);
      server.tool('capture_screenshot', 'd', {}, async () => ({ content: [{ type: 'text', text: 'x'.repeat(50000) }] }));
      await server._h({});
    `, logFile);

    assert.equal(lines[0].result.chars, 50000);
    assert.ok(lines[0].result.text.length < 2100);
    assert.ok(lines[0].result.text.endsWith('…[truncated]'));
  });

  it('truncates long argument strings so a pasted script cannot bloat the log', () => {
    const logFile = join(dir, 'bigargs.jsonl');
    const { lines } = run(`
      import { instrument } from './src/core/tool_log.js';
      const server = { tool: (n, d, s, h) => { server._h = h; } };
      instrument(server);
      server.tool('pine_set_source', 'd', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      await server._h({ source: 'x'.repeat(200000), verbose: true, nested: { deep: 'y'.repeat(9000) } });
    `, logFile);

    assert.ok(lines[0].args.source.endsWith('…[truncated 200000 chars]'));
    assert.ok(lines[0].args.source.length < 2100);
    assert.equal(lines[0].args.verbose, true, 'non-string args pass through');
    assert.ok(lines[0].args.nested.deep.endsWith('…[truncated 9000 chars]'), 'nested strings too');
  });

  it('creates the log directory if it does not exist', () => {
    const logFile = join(dir, 'nested', 'deeper', 'calls.jsonl');
    const { lines } = run(CALL_ONE, logFile);
    assert.equal(lines.length, 1);
  });

  it('leaves tools registered normally when logging is off', () => {
    const { stdout } = run(`
      import { instrument, enabled } from './src/core/tool_log.js';
      const registered = [];
      const server = { tool: (n) => registered.push(n) };
      instrument(server);
      server.tool('pine_check', 'd', {}, async () => ({}));
      console.log(JSON.stringify({ enabled, registered }));
    `, null);

    assert.deepEqual(JSON.parse(stdout.trim()), { enabled: false, registered: ['pine_check'] });
  });
});
