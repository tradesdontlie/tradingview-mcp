#!/usr/bin/env python3
"""Pre-publish safety check.

usage: preflight.py <live-artifact.html>

Give it the file WebFetch saved when it read the live artifact. Compares the
live data payload against the freshly built local one and decides whether
publishing is safe.

  PUBLISH   local differs from live, and live is what we last published
            -> our edits are on top of the current state; go ahead
  SKIP      local and live are identical -> nothing to publish
  CONFLICT  live is not what we last published -> somebody else published in
            between. Do NOT publish; reconcile first.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import payload_hash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(os.path.dirname(ROOT), "index.html")

def payload_of(path):
    s = open(path, encoding="utf-8", errors="replace").read()
    i = s.find("window.__DATA__=")
    if i < 0:
        raise SystemExit("no window.__DATA__ found in " + path)
    j = s.index(";</script>", i)
    return s[i + len("window.__DATA__="):j]

if len(sys.argv) != 2:
    raise SystemExit(__doc__)

local_h = payload_hash(payload_of(OUT))
live_h  = payload_hash(payload_of(sys.argv[1]))
state   = json.load(open(os.path.join(ROOT, "state.json"), encoding="utf-8"))
last    = (state.get("last_published") or {}).get("payload_sha256_16")

print("local  %s" % local_h)
print("live   %s" % live_h)
print("last published by us  %s" % (last or "(never recorded)"))

if live_h == local_h:
    print("\nSKIP — live already matches local. Nothing to publish.")
    sys.exit(3)

if last is not None and live_h != last:
    print("\nCONFLICT — the live artifact is not the version we last published.")
    print("Another session published in between. Do NOT publish over it.")
    print("Reconcile: read the live version, fold in anything missing, rebuild, retry.")
    sys.exit(2)

print("\nPUBLISH — local differs from live and live is our own last publish.")
sys.exit(0)
