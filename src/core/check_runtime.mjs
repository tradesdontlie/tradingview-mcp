import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const safe = value => String(value).replace(/[^A-Za-z0-9]+/g, '_');
const LIVE_DATA_ROOT = 'C:/Users/ADMIN/claude_os/data';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function runtimeDataRoot({ dataRoot = process.env.CHECK_DATA_ROOT, sourceRoot = process.cwd() } = {}) {
  if (dataRoot) return path.resolve(dataRoot);
  if (sourceRoot.replace(/\\/g, '/').includes('/.worktrees/')) {
    throw new Error('CHECK_DATA_ROOT is required from a linked worktree');
  }
  return LIVE_DATA_ROOT;
}

export function cachePaths(dataRoot, ticker, timeframe) {
  const symbol = safe(ticker);
  const tf = String(timeframe);
  const stem = `check_${symbol}_${tf}`;
  return {
    dated: path.join(dataRoot, `${stem}.json`),
    latest: path.join(dataRoot, `${stem}_latest.json`),
    legacyLatest: tf === '360' ? path.join(dataRoot, `check_${symbol}_latest.json`) : null,
  };
}

export function evidenceHash(evidence) {
  return crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex');
}

export function atomicWriteCache(paths, payload) {
  fs.mkdirSync(path.dirname(paths.latest), { recursive: true });
  const body = JSON.stringify(payload);
  for (const target of [paths.dated, paths.latest, paths.legacyLatest].filter(Boolean)) {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, target);
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function readLockMetadata(lockPath) {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw new Error('LOCK_INVALID_METADATA:TRADINGVIEW_CHART');
  }
  if (
    !metadata || !Number.isInteger(metadata.pid) || metadata.pid <= 0
    || !Number.isFinite(metadata.created_at) || metadata.created_at < 0
    || typeof metadata.ticker !== 'string' || !metadata.ticker
    || typeof metadata.timeframe !== 'string' || !metadata.timeframe
  ) {
    throw new Error('LOCK_INVALID_METADATA:TRADINGVIEW_CHART');
  }
  return metadata;
}

export function acquireLock(dataRoot, ticker, timeframe, staleMs, {
  now = () => Date.now(), pid = process.pid, isPidAlive: pidAlive = isPidAlive,
} = {}) {
  const lockPath = path.join(dataRoot, 'locks', 'tradingview-chart.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid, created_at: now(), ticker, timeframe }));
    return { fd, lockPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const metadata = readLockMetadata(lockPath);
    const age = now() - metadata.created_at;
    if (age > staleMs) {
      let alive;
      try {
        alive = pidAlive(metadata.pid);
      } catch {
        throw new Error('LOCK_PID_CHECK_FAILED:TRADINGVIEW_CHART');
      }
      if (alive === true) throw new Error('LOCK_CONTENDED:TRADINGVIEW_CHART');
      if (alive !== false) throw new Error('LOCK_PID_CHECK_FAILED:TRADINGVIEW_CHART');
      fs.unlinkSync(lockPath);
      return acquireLock(dataRoot, ticker, timeframe, staleMs, { now, pid, isPidAlive: pidAlive });
    }
    throw new Error('LOCK_CONTENDED:TRADINGVIEW_CHART');
  }
}

export async function withChartLock(dataRoot, ticker, timeframe, staleMs, operation) {
  const lock = acquireLock(dataRoot, ticker, timeframe, staleMs);
  try { return await operation(); } finally { releaseLock(lock); }
}

export function releaseLock(lock) {
  fs.closeSync(lock.fd);
  fs.unlinkSync(lock.lockPath);
}
