#!/usr/bin/env python3
"""Record what we just published, so the next preflight can detect interference."""
import json, os, sys, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
man = json.load(open(os.path.join(ROOT, "build-manifest.json"), encoding="utf-8"))
p = os.path.join(ROOT, "state.json")
st = json.load(open(p, encoding="utf-8"))
st["last_published"] = {
    "payload_sha256_16": man["payload_sha256_16"],
    "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "owner": man["owner"], "asof": man["asof"]}
json.dump(st, open(p, "w", encoding="utf-8"), indent=1)
print("recorded publish: payload=%s asof=%s owner=%s"
      % (man["payload_sha256_16"], man["asof"], man["owner"]))
