#!/usr/bin/env python3
"""Shared safety primitives for the ingestion pipeline.

Two writers on one data directory is the failure mode this exists to stop:
a stale-read/clobber race between a scheduled task, an interactive session,
and anything else pointed at the same repo.
"""
import os, json, time, errno, hashlib, contextlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(ROOT, ".pipeline.lock")
STALE_SECONDS = 900          # a lock older than this is treated as abandoned


@contextlib.contextmanager
def pipeline_lock(owner, timeout=120):
    """Exclusive lock around any read-modify-write of ingest/data/.

    O_EXCL creation is the atomic primitive. A lock whose holder died is
    reclaimed after STALE_SECONDS rather than deadlocking the weekly run.
    """
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, json.dumps({"owner": owner, "pid": os.getpid(),
                                     "at": time.time()}).encode())
            os.close(fd)
            break
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise
            try:
                held = json.load(open(LOCK))
                age = time.time() - held.get("at", 0)
            except Exception:
                held, age = {}, STALE_SECONDS + 1
            if age > STALE_SECONDS:
                print("  lock: reclaiming stale lock held by %r (%.0fs old)"
                      % (held.get("owner"), age))
                os.unlink(LOCK)
                continue
            if time.time() > deadline:
                raise SystemExit(
                    "ABORT: pipeline locked by %r (pid %s, %.0fs old).\n"
                    "Another session is mid-write. Wait for it, or remove %s if you "
                    "are certain it died." % (held.get("owner"), held.get("pid"), age, LOCK))
            time.sleep(2)
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(LOCK)


def write_atomic(path, text):
    """Write via temp + rename so a concurrent reader never sees a partial file."""
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def payload_hash(blob):
    """Identity of the data payload, ignoring template/runtime differences."""
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
