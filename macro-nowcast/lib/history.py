#!/usr/bin/env python3
"""The vintage store — append-only, one JSON file per bake.

The original dashboard's vintage selector was a hand-written list of past
conversation states. Here it is the real thing: every bake is written to
vintages/ and the selector reads that directory, so the Δ on each card is a
measured difference between two stored states rather than an assertion.
"""
import errno, glob, json, os, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "vintages")
LOCK = os.path.join(ROOT, ".bake.lock")

# How many past vintages the page carries. Enough to see a week of bakes
# without making the page heavy.
KEEP = 12


def _paths():
    return sorted(glob.glob(os.path.join(DIR, "*.json")))


def load_latest():
    """The most recent stored vintage, or None on a first run."""
    paths = _paths()
    while paths:
        try:
            with open(paths[-1], encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            # A truncated file from an interrupted write must not stop a bake.
            paths.pop()
    return None


def load_recent(limit=KEEP):
    out = []
    for path in reversed(_paths()):
        if len(out) >= limit:
            break
        try:
            with open(path, encoding="utf-8") as fh:
                out.append(json.load(fh))
        except (OSError, ValueError):
            continue
    return out


def save(vintage):
    os.makedirs(DIR, exist_ok=True)
    path = os.path.join(DIR, f"{vintage['stamp']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(vintage, fh, separators=(",", ":"))
    os.replace(tmp, path)
    return path


def prune(keep=60):
    """Keep the store bounded. Vintages are small, so this is generous."""
    paths = _paths()
    for path in paths[:-keep] if len(paths) > keep else []:
        try:
            os.remove(path)
        except OSError:
            pass


class Locked(Exception):
    """Another bake is already in flight."""


class lock:
    """Exclusive lock for the duration of one bake.

    Two bakes running at once interleave their reads and writes of vintages/,
    so the second one diffs against a vintage the first has not written yet and
    the selector ends up missing a state. A manual push makes this unlikely, but
    it costs one file to make it impossible.

    A lock left behind by a killed process is reclaimed after STALE seconds
    rather than blocking the next run forever.
    """

    STALE = 900

    def __enter__(self):
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
            try:
                age = time.time() - os.path.getmtime(LOCK)
            except OSError:
                age = None
            if age is None or age < self.STALE:
                raise Locked(
                    f"another bake holds {LOCK}"
                    + (f" (started {age:.0f}s ago)" if age is not None else "")
                    + " — wait for it, or remove the file if no bake is running")
            os.unlink(LOCK)
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w") as fh:
            fh.write(f"{os.getpid()}\n")
        return self

    def __exit__(self, *exc):
        try:
            os.unlink(LOCK)
        except OSError:
            pass
        return False
