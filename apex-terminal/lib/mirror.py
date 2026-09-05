#!/usr/bin/env python3
"""Copy public/ to local disk so a browser tool can actually load it.

This tree lives in iCloud Drive, where the session's preview launcher gets
`Operation not permitted` on every file. A verification step written as "open it
and look" would therefore pass vacuously — the browser never loads anything and
nothing fails. Mirroring to local disk makes the browser check real.

    python3 lib/mirror.py [--dest DIR]     prints the mirrored path

The mirror is byte-identical to public/; it is a copy, not a rebuild, so what
the browser loads is exactly what was published.
"""
import argparse, filecmp, hashlib, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")

DEFAULT_DEST = os.environ.get(
    "APEX_MIRROR",
    os.path.join(os.environ.get("TMPDIR", "/tmp").rstrip("/"), "apex-mirror"))


def _tree_digest(root):
    h = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            h.update(os.path.relpath(path, root).encode())
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
    return h.hexdigest()[:16]


def mirror(dest=DEFAULT_DEST, quiet=False):
    if not os.path.isdir(PUBLIC):
        raise SystemExit("public/ does not exist — run bake.py first")

    dest_public = os.path.join(dest, "public")
    os.makedirs(dest, exist_ok=True)
    if os.path.isdir(dest_public):
        shutil.rmtree(dest_public)
    shutil.copytree(PUBLIC, dest_public)
    shutil.copy2(os.path.join(ROOT, "serve.py"), os.path.join(dest, "serve.py"))

    src_digest, dst_digest = _tree_digest(PUBLIC), _tree_digest(dest_public)
    if src_digest != dst_digest:
        raise SystemExit(f"mirror digest mismatch: {src_digest} != {dst_digest}")

    diff = filecmp.dircmp(PUBLIC, dest_public)
    if diff.left_only or diff.right_only or diff.diff_files:
        raise SystemExit(f"mirror differs: {diff.left_only} {diff.right_only} {diff.diff_files}")

    if not quiet:
        print(f"  ok   mirrored public/ -> {dest_public}  (sha256:{src_digest})")
        print(f"       serve it with:  python3 {os.path.join(dest, 'serve.py')} --port 8791")
    return dest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=DEFAULT_DEST)
    ap.add_argument("--quiet", action="store_true")
    print(mirror(ap.parse_args().dest, ap.parse_args().quiet))
