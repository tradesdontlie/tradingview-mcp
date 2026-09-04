#!/usr/bin/env python3
"""Pre-publish safety check.

usage: preflight.py <live-artifact.html>

Give it the file WebFetch saved when it read the live artifact — a FRESH read.
Compares the live page against the freshly built local one and decides whether
publishing is safe.

  PUBLISH   something changed and live is what we last published -> go ahead
  SKIP      page and payload both identical -> nothing to publish
  CONFLICT  live payload is not what we last published -> somebody else
            published in between. Do NOT publish; reconcile first.

Two traps this guards against:
  * a STALE input file. WebFetch caches per URL for ~15 minutes AND rewrites
    the file even when serving cache, so the file's mtime proves nothing.
    The artifact VERSION is in the saved filename, so that is compared against
    the version recorded at our last publish instead. Fetch in the same turn
    you preflight.
  * a TEMPLATE-ONLY change. Comparing payloads alone reports "nothing to
    publish" when the data is identical but the markup or script changed, so
    the page is compared as well.
"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import payload_hash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(os.path.dirname(ROOT), "index.html")
VER = re.compile(r"artifact-[0-9a-f]+-(\d+-[0-9a-z]+)\.html$")

def parts(path):
    s = open(path, encoding="utf-8", errors="replace").read()
    i = s.find("window.__DATA__=")
    if i < 0:
        raise SystemExit("no window.__DATA__ found in " + path)
    j = s.index(";</script>", i)
    payload = s[i + len("window.__DATA__="):j]
    # strip the host's injected runtime so the page comparison is like-for-like
    k = s.find("<title>")
    page = s[k:] if k >= 0 else s
    return payload, page

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
live_file = sys.argv[1]

m = VER.search(os.path.basename(live_file))
capture_version = m.group(1) if m else None

lp, lg = parts(OUT)
rp, rg = parts(live_file)
local_h, live_h = payload_hash(lp), payload_hash(rp)
page_l, page_r  = payload_hash(lg), payload_hash(rg)
state = json.load(open(os.path.join(ROOT, "state.json"), encoding="utf-8"))
lastrec = state.get("last_published") or {}
last = lastrec.get("payload_sha256_16")
seen = lastrec.get("seen_version")
if capture_version and seen and capture_version == seen:
    print(f"capture version {capture_version} is the one recorded BEFORE our last publish")
    raise SystemExit(
        "ABORT: the capture predates our own last publish — WebFetch served a cached copy.\n"
        "Re-read the artifact and pass the new file. Publishing on this evidence could clobber.")

print(f"capture version        {capture_version or '(unknown)'}")
print(f"payload  local {local_h}   live {live_h}")
print(f"page     local {page_l}   live {page_r}")
print(f"last published by us   {last or '(never recorded)'}")

if local_h == live_h and page_l == page_r:
    print("\nSKIP — live already matches local, payload and page. Nothing to publish.")
    sys.exit(3)

if last is not None and live_h != last:
    print("\nCONFLICT — the live payload is not the version we last published.")
    print("Another session published in between. Do NOT publish over it.")
    print("Reconcile: read the live version, fold in anything missing, rebuild, retry.")
    sys.exit(2)

what = "payload" if local_h != live_h else "page only (template or script)"
print(f"\nPUBLISH — {what} differs and live is our own last publish.")
sys.exit(0)
