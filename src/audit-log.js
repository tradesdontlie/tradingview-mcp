import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const WARNING = 'TradingView MCP audit logging failed and has been disabled for this logger; tool execution is unaffected.\n';
const STATUSES = new Set(['success', 'error', 'denied', 'threw', 'cancelled']);
const integer = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;

/**
 * Opt-in, metadata-only audit records. Arguments, result bodies and error text
 * are never retained, even when supplied by the caller. Target IDs are hashed
 * with a random per-logger salt. Only the hash is persisted: it correlates calls
 * within this logger but cannot be reused to link IDs across logger instances.
 * maxFiles counts the active file plus numbered backups.
 */
export function createAuditLogger(options = {}) {
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new TypeError('Audit enabled must be a boolean');
  const enabled = options.enabled ?? /^(1|true)$/i.test(process.env.MCP_AUDIT_LOG || '');
  const filePath = enabled ? resolve(options.filePath || process.env.MCP_AUDIT_LOG_PATH || '.local/audit/tool-calls.jsonl') : null;
  const maxBytes = integer(options.maxBytes, 1024 * 1024, 1024, 10 * 1024 * 1024);
  const maxFiles = integer(options.maxFiles, 3, 1, 5);
  const now = options.now || Date.now;
  const onWarning = options.onWarning || (message => process.stderr.write(message));
  const toolNames = options.toolNames ? new Set(options.toolNames) : null;
  const tokens = new WeakSet();
  const finished = new WeakSet();
  const salt = enabled ? randomBytes(32) : null;
  let healthy = true;
  let warned = false;

  function failure() {
    healthy = false;
    if (!warned) {
      warned = true;
      try { onWarning(WARNING); } catch { /* logging cannot replace a tool outcome */ }
    }
    return false;
  }

  function toolName(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)
      || /^(?:ghp_|github_pat_|sk_)/.test(value) || (toolNames && !toolNames.has(value))) return '[unclassified]';
    return value;
  }

  function targetHash(value) {
    if (typeof value !== 'string' || value.length > 512) return undefined;
    return createHash('sha256').update(salt).update(value).digest('hex').slice(0, 20);
  }

  function safeTime() {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  }

  function safeFile(path) {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsupported audit destination');
    if (stat.size > maxBytes) throw new Error('Existing audit file exceeds configured bound');
    return stat;
  }

  function append(entry) {
    if (!enabled || !healthy) return false;
    let lock;
    const lockPath = `${filePath}.lock`;
    try {
      if (!filePath.endsWith('.jsonl')) throw new Error('Audit path must use jsonl extension');
      const line = JSON.stringify(entry) + '\n';
      const size = Buffer.byteLength(line);
      if (size > 1024) throw new Error('Audit record exceeds metadata bound');
      mkdirSync(dirname(filePath), { recursive: true });
      // A second process must not race rotation or append into another writer's
      // files. A stale lock fails visibly rather than being removed blindly.
      lock = openSync(lockPath, 'wx', 0o600);
      const stat = safeFile(filePath);
      if (stat && stat.size + size > maxBytes) {
        for (let i = 1; i < maxFiles; i++) safeFile(`${filePath}.${i}`);
        if (maxFiles === 1) unlinkSync(filePath);
        else {
          const oldest = `${filePath}.${maxFiles - 1}`;
          if (existsSync(oldest)) unlinkSync(oldest);
          for (let i = maxFiles - 2; i >= 1; i--) {
            const from = `${filePath}.${i}`;
            if (existsSync(from)) renameSync(from, `${filePath}.${i + 1}`);
          }
          renameSync(filePath, `${filePath}.1`);
        }
      }
      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch { return failure(); }
    finally {
      if (lock !== undefined) {
        try { closeSync(lock); } catch { failure(); }
        try { unlinkSync(lockPath); } catch { failure(); }
      }
    }
  }

  function metadata(tool, context = {}) {
    return Object.freeze({ call_id: randomUUID(), tool: toolName(tool), start: safeTime(), target: targetHash(context.targetId) });
  }

  function entry(token, status, duration) {
    const time = safeTime();
    return {
      timestamp: new Date(time).toISOString(), call_id: token.call_id, tool: token.tool,
      status: STATUSES.has(status) ? status : 'error',
      duration_ms: typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, Math.min(duration, 86400000)) : 0,
      ...(token.target && { target_hash: token.target }),
    };
  }

  return Object.freeze({
    enabled: Boolean(enabled),
    filePath,
    get healthy() { return healthy; },
    callStarted(tool, context = {}) {
      if (!enabled || !healthy) return null;
      try {
        const token = metadata(tool, context);
        tokens.add(token);
        return token;
      } catch { failure(); return null; }
    },
    callFinished(token, outcome = {}) {
      if (!enabled || !healthy || !token || !tokens.has(token) || finished.has(token)) return false;
      try {
        finished.add(token);
        const status = outcome.status || (outcome.error ? 'threw' : outcome.result?.isError || outcome.result?.success === false ? 'error' : 'success');
        return append(entry(token, status, safeTime() - token.start));
      } catch { return failure(); }
    },
    record(event = {}) {
      if (!enabled || !healthy) return false;
      try { return append(entry(metadata(event.tool, { targetId: event.targetId }), event.status, event.duration_ms)); }
      catch { return failure(); }
    },
  });
}
