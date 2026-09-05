#!/usr/bin/env python3
"""Copy the Perplexity bundle into public/ with its API base URL repaired.

The shipped build contains a broken Vite substitution:

    const qD = "port/5000".startsWith("__") ? "" : "port/5000";
    const r  = await fetch(`${qD}${queryKey.join("/")}`);

The guard exists to blank an unsubstituted placeholder, but the value that
landed is the literal "port/5000", so every request goes to the relative path
"port/5000/api/scorecard" and can never resolve. Rewriting the constant to ""
makes it fetch "/api/scorecard" from the serving origin, which is where bake.py
writes the payloads.

Idempotent: re-running against an already-patched file is a no-op.
"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor-dist")
PUBLIC = os.path.join(ROOT, "public")

# Matches the emitted constant regardless of the minifier's variable name.
BROKEN = re.compile(r'(const\s+\w+\s*=\s*)"port/5000"(\.startsWith\("__"\)\?"":)"port/5000"')


def patch_bundle(text):
    """Return (patched_text, n_replacements)."""
    return BROKEN.subn(r'\1""\2""', text)


def main():
    if not os.path.isdir(VENDOR):
        sys.exit(f"vendor-dist/ not found at {VENDOR}")

    os.makedirs(PUBLIC, exist_ok=True)
    patched_files, copied = [], 0

    for dirpath, _dirnames, filenames in os.walk(VENDOR):
        rel_dir = os.path.relpath(dirpath, VENDOR)
        out_dir = PUBLIC if rel_dir == "." else os.path.join(PUBLIC, rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        for name in filenames:
            src, dst = os.path.join(dirpath, name), os.path.join(out_dir, name)
            if name.endswith(".js"):
                with open(src, encoding="utf-8") as fh:
                    text = fh.read()
                text, n = patch_bundle(text)
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(text)
                if n:
                    patched_files.append((name, n))
            else:
                shutil.copy2(src, dst)
            copied += 1

    print(f"  copied {copied} file(s) into public/")
    if patched_files:
        for name, n in patched_files:
            print(f"  patched API base URL in {name} ({n} site{'s' if n != 1 else ''})")
    else:
        # Either already patched upstream or the bundle changed shape.
        leftover = []
        for dirpath, _d, filenames in os.walk(PUBLIC):
            for name in filenames:
                if not name.endswith(".js"):
                    continue
                with open(os.path.join(dirpath, name), encoding="utf-8") as fh:
                    if '"port/5000"' in fh.read():
                        leftover.append(name)
        if leftover:
            sys.exit(f"  FAIL still contains the broken base URL: {leftover}")
        print("  no patch needed (base URL already empty)")


if __name__ == "__main__":
    main()
