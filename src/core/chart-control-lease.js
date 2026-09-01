import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname as machineHostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Cross-process ownership fence for the single mutable TradingView chart.
 *
 * Ported for this scanner from the independently reviewed chart-control lease
 * reference (sha256
 * d662a9577d0ea713e7d97e959071dfcb08bd81dce9fb249ceee151dbae07f046).
 * Stale-owner recovery is serialized by a private, durable sibling mutex and
 * revalidates the current owner while holding that mutex. Live route-and-
 * viewport interference checks separately guard chart restoration.
 */
export const DEFAULT_CHART_CONTROL_LEASE_DIR = join(
  homedir(),
  '.local',
  'state',
  'tradingview-mcp',
  'chart-control',
  'lease',
);

const OWNER_FILE = 'owner.json';
const RECOVERY_MUTEX_SUFFIX = '.recovery-lock';
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const UPDATE_FIELDS = new Set(['phase', 'heartbeat_at_utc', 'last_owned_chart_route']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ChartControlLeaseBusyError extends Error {
  constructor(message, owner = null) {
    super(message);
    this.name = 'ChartControlLeaseBusyError';
    this.code = 'chart_control_lease_busy';
    this.exitCode = 75;
    this.owner = owner;
  }
}

export class ChartControlLeaseLostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChartControlLeaseLostError';
    this.code = 'chart_control_lease_lost';
  }
}

function canonicalUtc(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date.`);
  }
  return value.toISOString();
}

function requireLeasePath(leaseDir) {
  if (typeof leaseDir !== 'string' || !isAbsolute(leaseDir)) {
    throw new TypeError('leaseDir must be an absolute path.');
  }
  if (leaseDir === '/' || dirname(leaseDir) === leaseDir) {
    throw new TypeError('leaseDir must not be a filesystem root.');
  }
  return leaseDir;
}

function ownerPath(leaseDir) {
  return join(leaseDir, OWNER_FILE);
}

function assertSafeDirectory(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} is unsafe: ${path}`);
  }
  return metadata;
}

function ensurePrivateParent(leaseDir) {
  const parent = dirname(leaseDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafeDirectory(parent, 'chart-control lease parent');
  // This directory is dedicated to chart-control state. Keeping it private
  // prevents process metadata from becoming visible through permissive umasks.
  chmodSync(parent, 0o700);
  return parent;
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor, bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(descriptor, payload, offset, payload.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('chart-control lease write made no forward progress.');
    }
    offset += written;
  }
}

function writeOwnerDurably(leaseDir, owner) {
  const descriptor = openSync(ownerPath(leaseDir), 'wx', 0o600);
  try {
    writeAll(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(leaseDir);
}

function replaceOwnerDurably(leaseDir, owner) {
  const path = ownerPath(leaseDir);
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new ChartControlLeaseLostError('chart-control owner metadata became unsafe.');
  }
  const temporary = join(leaseDir, `.owner-${randomUUID()}.json`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(leaseDir);
}

function readOwner(leaseDir) {
  const path = ownerPath(leaseDir);
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('chart-control owner metadata filesystem surface is unsafe.');
  }
  let owner;
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`chart-control lease metadata is invalid: ${error.message}`);
  }
  return owner;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processStartedAtUtc(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ownerIsStale(owner, {
  nowMs,
  hostname,
  staleAfterMs,
  leaseMtimeMs,
  isProcessAlive,
  getProcessStartedAtUtc,
}) {
  if (!owner || typeof owner !== 'object') {
    return nowMs - leaseMtimeMs >= staleAfterMs;
  }
  if (owner.hostname && owner.hostname !== hostname) return false;
  const acquiredMs = Date.parse(owner.acquired_at_utc);
  const heartbeatMs = Date.parse(owner.heartbeat_at_utc);
  const referenceMs = Number.isFinite(heartbeatMs) ? heartbeatMs : acquiredMs;
  if (!Number.isFinite(referenceMs)) return nowMs - leaseMtimeMs >= staleAfterMs;
  if (isProcessAlive(owner.pid)) {
    const observedStart = getProcessStartedAtUtc(owner.pid);
    if (typeof owner.process_started_at_utc === 'string'
      && observedStart === owner.process_started_at_utc) return false;
  }
  return nowMs - referenceMs >= staleAfterMs;
}

function archiveStaleLease(leaseDir, now) {
  const stamp = canonicalUtc(now, 'now').replace(/[^0-9]/g, '').slice(0, 14);
  const archivedPath = `${leaseDir}.stale-${stamp}-${randomUUID()}`;
  renameSync(leaseDir, archivedPath);
  fsyncDirectory(dirname(leaseDir));
  return archivedPath;
}

function acquireStaleRecoveryMutex(leaseDir, {
  owner,
  pid,
  processInstanceId,
  hostname,
  now,
  busyOwner,
}) {
  const path = `${leaseDir}${RECOVERY_MUTEX_SUFFIX}`;
  const parent = dirname(path);
  const mutexId = randomUUID();
  const metadata = {
    schema_version: 1,
    mutex_id: mutexId,
    owner,
    pid,
    process_instance_id: processInstanceId,
    hostname,
    acquired_at_utc: canonicalUtc(now, 'now'),
  };
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const observed = lstatSync(path);
    if (observed.isSymbolicLink() || !observed.isFile()) {
      throw new Error(`chart-control stale-recovery mutex is unsafe: ${path}`);
    }
    throw new ChartControlLeaseBusyError(
      'Another process is already recovering the TradingView chart-control lease.',
      busyOwner,
    );
  }

  try {
    writeAll(descriptor, `${JSON.stringify(metadata, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(path);
    fsyncDirectory(parent);
    throw error;
  }
  closeSync(descriptor);
  fsyncDirectory(parent);

  let released = false;
  return {
    release() {
      if (released) return;
      if (!existsSync(path)) {
        throw new ChartControlLeaseLostError(
          'chart-control stale-recovery mutex disappeared before cleanup.',
        );
      }
      const observedMetadata = lstatSync(path);
      if (observedMetadata.isSymbolicLink() || !observedMetadata.isFile()) {
        throw new ChartControlLeaseLostError(
          'chart-control stale-recovery mutex became unsafe before cleanup.',
        );
      }
      let observedOwner;
      try {
        observedOwner = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        throw new ChartControlLeaseLostError(
          `chart-control stale-recovery mutex metadata became invalid: ${error.message}`,
        );
      }
      if (observedOwner?.mutex_id !== mutexId) {
        throw new ChartControlLeaseLostError(
          'refusing to remove a chart-control stale-recovery mutex owned by another process.',
        );
      }
      unlinkSync(path);
      fsyncDirectory(parent);
      released = true;
    },
  };
}

function validateAcquisitionOptions({
  owner,
  pid,
  processInstanceId,
  processStartedAt,
  staleAfterMs,
}) {
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(owner)) {
    throw new TypeError('owner must be a short machine-safe identifier.');
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError('pid must be a positive safe integer.');
  }
  if (!UUID_PATTERN.test(processInstanceId || '')) {
    throw new TypeError('processInstanceId must be a UUID.');
  }
  if (typeof processStartedAt !== 'string' || !Number.isFinite(Date.parse(processStartedAt))) {
    throw new TypeError('processStartedAt must be an ISO timestamp.');
  }
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
    throw new TypeError('staleAfterMs must be at least 60000.');
  }
}

export function inspectChartControlLease({
  leaseDir = DEFAULT_CHART_CONTROL_LEASE_DIR,
  now = new Date(),
  hostname = machineHostname(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  _processIsAlive = processIsAlive,
  _processStartedAtUtc = processStartedAtUtc,
} = {}) {
  requireLeasePath(leaseDir);
  if (!existsSync(leaseDir)) {
    return { held: false, stale: false, lease_dir: leaseDir, owner: null };
  }
  const metadata = assertSafeDirectory(leaseDir, 'chart-control lease path');
  const owner = readOwner(leaseDir);
  return {
    held: true,
    stale: ownerIsStale(owner, {
      nowMs: now.getTime(),
      hostname,
      staleAfterMs,
      leaseMtimeMs: metadata.mtimeMs,
      isProcessAlive: _processIsAlive,
      getProcessStartedAtUtc: _processStartedAtUtc,
    }),
    foreign_host: Boolean(owner?.hostname && owner.hostname !== hostname),
    lease_dir: leaseDir,
    owner,
  };
}

export function acquireChartControlLease({
  leaseDir = DEFAULT_CHART_CONTROL_LEASE_DIR,
  owner = 'sma-fib-watchlist-scan',
  now = new Date(),
  pid = process.pid,
  processInstanceId = randomUUID(),
  processStartedAt = processStartedAtUtc(pid),
  hostname = machineHostname(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  _processIsAlive = processIsAlive,
  _processStartedAtUtc = processStartedAtUtc,
} = {}) {
  requireLeasePath(leaseDir);
  canonicalUtc(now, 'now');
  validateAcquisitionOptions({ owner, pid, processInstanceId, processStartedAt, staleAfterMs });
  const parent = ensurePrivateParent(leaseDir);
  let archivedStaleLease = null;
  let recoveryMutex = null;

  try {
    mkdirSync(leaseDir, { mode: 0o700 });
    chmodSync(leaseDir, 0o700);
    fsyncDirectory(parent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const metadata = assertSafeDirectory(leaseDir, 'chart-control lease path');
    const observedOwner = readOwner(leaseDir);
    const foreignHost = Boolean(observedOwner?.hostname && observedOwner.hostname !== hostname);
    const stale = ownerIsStale(observedOwner, {
      nowMs: now.getTime(),
      hostname,
      staleAfterMs,
      leaseMtimeMs: metadata.mtimeMs,
      isProcessAlive: _processIsAlive,
      getProcessStartedAtUtc: _processStartedAtUtc,
    });
    if (foreignHost) {
      throw new ChartControlLeaseBusyError(
        'TradingView chart-control lease belongs to another host and requires manual review.',
        observedOwner,
      );
    }
    if (!stale) {
      throw new ChartControlLeaseBusyError(
        `TradingView chart-control lease is held by ${observedOwner?.owner ?? 'an unknown owner'} (pid ${observedOwner?.pid ?? 'unknown'}).`,
        observedOwner,
      );
    }
    recoveryMutex = acquireStaleRecoveryMutex(leaseDir, {
      owner,
      pid,
      processInstanceId,
      hostname,
      now,
      busyOwner: observedOwner,
    });
    try {
      if (existsSync(leaseDir)) {
        const currentMetadata = assertSafeDirectory(
          leaseDir,
          'chart-control lease path',
        );
        const currentOwner = readOwner(leaseDir);
        const currentForeignHost = Boolean(
          currentOwner?.hostname && currentOwner.hostname !== hostname,
        );
        const currentIsStale = ownerIsStale(currentOwner, {
          nowMs: now.getTime(),
          hostname,
          staleAfterMs,
          leaseMtimeMs: currentMetadata.mtimeMs,
          isProcessAlive: _processIsAlive,
          getProcessStartedAtUtc: _processStartedAtUtc,
        });
        if (currentForeignHost) {
          throw new ChartControlLeaseBusyError(
            'TradingView chart-control lease belongs to another host and requires manual review.',
            currentOwner,
          );
        }
        if (!currentIsStale) {
          throw new ChartControlLeaseBusyError(
            `TradingView chart-control lease is held by ${currentOwner?.owner ?? 'an unknown owner'} (pid ${currentOwner?.pid ?? 'unknown'}).`,
            currentOwner,
          );
        }
        archivedStaleLease = archiveStaleLease(leaseDir, now);
      }
      mkdirSync(leaseDir, { mode: 0o700 });
      chmodSync(leaseDir, 0o700);
      fsyncDirectory(parent);
    } catch (error) {
      recoveryMutex.release();
      recoveryMutex = null;
      throw error;
    }
  }

  const leaseId = randomUUID();
  const metadata = {
    schema_version: 1,
    lease_id: leaseId,
    owner,
    pid,
    process_instance_id: processInstanceId,
    process_started_at_utc: processStartedAt,
    hostname,
    acquired_at_utc: canonicalUtc(now, 'now'),
    heartbeat_at_utc: canonicalUtc(now, 'now'),
  };
  try {
    writeOwnerDurably(leaseDir, metadata);
  } catch (error) {
    if (existsSync(ownerPath(leaseDir))) unlinkSync(ownerPath(leaseDir));
    if (existsSync(leaseDir)) rmdirSync(leaseDir);
    throw error;
  } finally {
    recoveryMutex?.release();
  }

  let released = false;
  let heartbeatError = null;
  return {
    ...metadata,
    lease_dir: leaseDir,
    archived_stale_lease: archivedStaleLease,
    assertOwned() {
      if (released) throw new ChartControlLeaseLostError('chart-control lease is already released.');
      if (heartbeatError) throw heartbeatError;
      if (!existsSync(leaseDir)) {
        throw new ChartControlLeaseLostError('chart-control lease directory disappeared.');
      }
      assertSafeDirectory(leaseDir, 'chart-control lease path');
      const observed = readOwner(leaseDir);
      if (observed?.lease_id !== leaseId) {
        throw new ChartControlLeaseLostError('chart-control lease ownership changed.');
      }
      return observed;
    },
    update(fields = {}) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new TypeError('lease update must be an object.');
      }
      for (const key of Object.keys(fields)) {
        if (!UPDATE_FIELDS.has(key)) {
          throw new Error(`unsupported chart-control lease metadata field: ${key}`);
        }
      }
      const observed = this.assertOwned();
      const next = {
        ...observed,
        ...JSON.parse(JSON.stringify(fields)),
        heartbeat_at_utc: fields.heartbeat_at_utc ?? new Date().toISOString(),
      };
      if (JSON.stringify(next).length > 32_768) {
        throw new Error('chart-control lease metadata is too large.');
      }
      replaceOwnerDurably(leaseDir, next);
      return next;
    },
    _setHeartbeatError(error) {
      heartbeatError = error instanceof Error
        ? error
        : new ChartControlLeaseLostError(String(error));
    },
    release() {
      if (released) return { released: false, already_released: true };
      if (!existsSync(leaseDir)) {
        throw new ChartControlLeaseLostError('chart-control lease directory disappeared.');
      }
      assertSafeDirectory(leaseDir, 'chart-control lease path');
      const observed = readOwner(leaseDir);
      if (observed?.lease_id !== leaseId) {
        throw new ChartControlLeaseLostError(
          'refusing to release a chart-control lease owned by another process.',
        );
      }
      unlinkSync(ownerPath(leaseDir));
      rmdirSync(leaseDir);
      fsyncDirectory(parent);
      released = true;
      return { released: true, already_released: false };
    },
  };
}

export async function withChartControlLease(callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000) {
    throw new TypeError('heartbeatIntervalMs must be at least 1000.');
  }
  const lease = acquireChartControlLease(options);
  const timer = setInterval(() => {
    try {
      lease.update({ heartbeat_at_utc: new Date().toISOString() });
    } catch (error) {
      lease._setHeartbeatError(error);
    }
  }, heartbeatIntervalMs);
  timer.unref?.();
  try {
    return await callback(lease);
  } finally {
    clearInterval(timer);
    lease.release();
  }
}
