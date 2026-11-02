import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLogger } from '../src/audit-log.js';

// Tests only write bounded files to unique OS temp directories. They intentionally
// do not recursively delete a computed Windows path; the OS owns temp cleanup.
const dirs = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'tv-audit-test-')); dirs.push(dir); return { dir, filePath: join(dir, 'calls.jsonl') }; };
const records = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const oldEnabled = process.env.MCP_AUDIT_LOG;
afterEach(() => {
  if (oldEnabled === undefined) delete process.env.MCP_AUDIT_LOG;
  else process.env.MCP_AUDIT_LOG = oldEnabled;
});

describe('opt-in metadata audit logging', () => {
  it('writes nothing and creates no path when disabled', () => {
    const { filePath } = fixture();
    const logger = createAuditLogger({ enabled: false, filePath });
    assert.equal(logger.callStarted('quote_get', { args: { password: 'secret' } }), null);
    assert.equal(logger.record({ tool: 'quote_get', status: 'success' }), false);
    assert.equal(logger.callFinished(null), false);
    assert.equal(existsSync(filePath), false);
  });

  it('is disabled by default, not enabled merely by a log path', () => {
    delete process.env.MCP_AUDIT_LOG;
    const { filePath } = fixture();
    assert.equal(createAuditLogger({ filePath }).enabled, false);
    process.env.MCP_AUDIT_LOG = 'false';
    assert.equal(createAuditLogger({ filePath }).enabled, false);
    process.env.MCP_AUDIT_LOG = '1';
    assert.equal(createAuditLogger({ filePath }).enabled, true);
    for (const enabled of ['false', 'true', 0, 1, null]) {
      assert.throws(() => createAuditLogger({ filePath, enabled }), /must be a boolean/);
    }
  });

  it('records completion metadata only and never retains nested arguments, results or errors', () => {
    const { filePath } = fixture();
    let time = 10000;
    const logger = createAuditLogger({ enabled: true, filePath, now: () => time, toolNames: ['pine_edit'] });
    const secret = 'NEVER_PERSIST_THIS_SENTINEL';
    const hostile = { source: secret, authorization: secret, nested: { password: secret, api_key: secret, cookies: [secret], trade: { account: secret, pnl: secret } } };
    const token = logger.callStarted('pine_edit', { targetId: secret, args: hostile });
    assert.equal(existsSync(filePath), false, 'unfinished calls do not create arbitrary payload logs');
    time += 50;
    assert.equal(logger.callFinished(token, { result: { isError: true, content: hostile }, error: new Error(secret), args: hostile }), true);
    const raw = readFileSync(filePath, 'utf8');
    assert.ok(!raw.includes(secret));
    const [record] = records(filePath);
    assert.equal(record.tool, 'pine_edit');
    assert.equal(record.status, 'threw');
    assert.equal(record.duration_ms, 50);
    assert.equal(typeof record.target_hash, 'string');
    assert.deepEqual(Object.keys(record).sort(), ['call_id', 'duration_ms', 'status', 'target_hash', 'timestamp', 'tool']);
    assert.equal(logger.callFinished(token), false, 'completion retries do not duplicate a record');
  });

  it('ignores hostile extra fields, masks unknown tool names, and never serializes supplied objects', () => {
    const { filePath } = fixture();
    const logger = createAuditLogger({ enabled: true, filePath, toolNames: ['quote_get'] });
    const secret = 'NEVER_PERSIST_THIS_SENTINEL';
    const body = { toJSON() { throw new Error(secret); }, password: secret };
    const cycle = {}; cycle.self = cycle;
    assert.equal(logger.record({ tool: secret, status: secret, duration_ms: Infinity, result: body, args: cycle, error: secret, targetId: body }), true);
    const raw = readFileSync(filePath, 'utf8');
    assert.ok(!raw.includes(secret));
    assert.equal(records(filePath)[0].tool, '[unclassified]');
    assert.equal(records(filePath)[0].duration_ms, 0);
  });

  it('uses stable hashes within one logger and different salted hashes across loggers', () => {
    const { filePath } = fixture();
    const logger = createAuditLogger({ enabled: true, filePath });
    logger.record({ tool: 'quote_get', status: 'success', targetId: 'opaque-target' });
    logger.record({ tool: 'quote_get', status: 'success', targetId: 'opaque-target' });
    createAuditLogger({ enabled: true, filePath }).record({ tool: 'quote_get', status: 'success', targetId: 'opaque-target' });
    const lines = records(filePath);
    assert.equal(lines[0].target_hash, lines[1].target_hash);
    assert.notEqual(lines[0].target_hash, lines[2].target_hash);
  });

  it('rotates within configured file-count and byte bounds with valid JSON lines', () => {
    const { dir, filePath } = fixture();
    const logger = createAuditLogger({ enabled: true, filePath, maxBytes: 1024, maxFiles: 3 });
    for (let i = 0; i < 100; i++) assert.equal(logger.record({ tool: 'quote_get', status: 'success', duration_ms: i }), true);
    const files = readdirSync(dir);
    assert.deepEqual(files.sort(), ['calls.jsonl', 'calls.jsonl.1', 'calls.jsonl.2']);
    for (const file of files) {
      assert.ok(statSync(join(dir, file)).size <= 1024);
      assert.ok(records(join(dir, file)).length > 0);
    }
    assert.equal(logger.healthy, true);
  });

  it('warns once without leaking filesystem/error contents and never throws on write failure', () => {
    const { dir } = fixture();
    const blocked = join(dir, 'SECRET_BLOCKED_PATH');
    writeFileSync(blocked, 'not a directory');
    const warnings = [];
    const logger = createAuditLogger({ enabled: true, filePath: join(blocked, 'calls.jsonl'), onWarning: message => warnings.push(message) });
    const token = logger.callStarted('quote_get');
    assert.doesNotThrow(() => assert.equal(logger.callFinished(token, { result: { success: true } }), false));
    assert.equal(logger.record({ tool: 'quote_get', status: 'success' }), false);
    assert.equal(logger.healthy, false);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('SECRET_BLOCKED_PATH'));
    assert.equal(logger.callStarted('quote_get'), null);
  });

  it('does not remove a lock owned by another writer', () => {
    const { filePath } = fixture();
    writeFileSync(`${filePath}.lock`, 'another process');
    const logger = createAuditLogger({ enabled: true, filePath, onWarning() {} });
    assert.equal(logger.record({ tool: 'quote_get', status: 'success' }), false);
    assert.equal(readFileSync(`${filePath}.lock`, 'utf8'), 'another process');
    assert.equal(existsSync(filePath), false);
  });

  it('does not truncate or rotate a pre-existing oversized destination', () => {
    const { filePath } = fixture();
    const original = 'x'.repeat(2048);
    writeFileSync(filePath, original);
    const logger = createAuditLogger({ enabled: true, filePath, maxBytes: 1024, onWarning() {} });
    assert.equal(logger.record({ tool: 'quote_get', status: 'success' }), false);
    assert.equal(readFileSync(filePath, 'utf8'), original);
    assert.equal(existsSync(`${filePath}.1`), false);
  });
});
