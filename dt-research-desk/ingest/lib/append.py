#!/usr/bin/env python3
"""Idempotent, locked merge into ingest/data/*.json.

usage: append.py <records.json> [--owner NAME] [--dry-run]

Step 2 of the runbook used to be a hand-edited read-modify-write, which is how
two concurrent runs duplicated the same nine trades on 2026-10-21: the second
writer loaded the files before the first had saved them. This tool closes that
hole two ways.

  * It holds the SAME pipeline lock build.py uses, and re-reads each data file
    INSIDE the lock, so a writer that waited sees the other's records.
  * The merge is keyed. A record whose identity key is already present is
    skipped, so sweeping the same Slack window twice is a no-op rather than a
    collision. That matters because both scheduled runs share one watermark and
    deliberately re-process whatever is new.

Input is one JSON object keyed by data file stem, e.g.

  {"trades": [ ... ], "calls": [ ... ], "persistence": [ ... ]}

`persistence` upserts (re-marking a prior call's outcome is the point of it);
every other list is append-if-absent. Lists that are date-ordered are stably
re-sorted by date, so an out-of-order insert lands in the right place and
validate.py's ordering check stays satisfied.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import pipeline_lock, write_atomic

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# identity key per file, and whether the file is kept in date order.
# A key must be the things that make a record THE SAME record, so that
# re-ingesting a Slack window matches rather than duplicates.
SPEC = {
    "trades":      {"key": ("date", "ticker", "action"), "sort": True,  "mode": "skip"},
    "calls":       {"key": ("date", "subject"),          "sort": True,  "mode": "skip"},
    "regime":      {"key": ("date", "title"),            "sort": True,  "mode": "skip"},
    "perf":        {"key": ("date",),                    "sort": True,  "mode": "skip"},
    "cash":        {"key": ("date",),                    "sort": True,  "mode": "skip"},
    "framework":   {"key": ("date", "topic"),            "sort": True,  "mode": "skip"},
    "persistence": {"key": ("date", "call"),             "sort": True,  "mode": "upsert"},
}


def kf(spec, rec):
    return tuple(rec.get(k) for k in spec["key"])


def merge(stem, incoming, dry):
    spec = SPEC.get(stem)
    if spec is None:
        raise SystemExit("append.py: unknown data file %r (known: %s)"
                         % (stem, ", ".join(sorted(SPEC))))
    path = os.path.join(DATA, stem + ".json")
    cur = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    index = {kf(spec, r): i for i, r in enumerate(cur)}

    added = skipped = updated = 0
    for rec in incoming:
        k = kf(spec, rec)
        if k in index:
            if spec["mode"] == "upsert":
                if cur[index[k]] != rec:
                    cur[index[k]] = rec
                    updated += 1
                else:
                    skipped += 1
            else:
                skipped += 1
            continue
        index[k] = len(cur)
        cur.append(rec)
        added += 1

    if spec["sort"]:
        cur.sort(key=lambda r: r.get("date") or "")

    if not dry:
        write_atomic(path, json.dumps(cur, indent=1, ensure_ascii=False) + "\n")
    print("  %-12s +%d  ~%d  =%d  -> %d rows%s"
          % (stem, added, updated, skipped, len(cur), "  (dry run)" if dry else ""))
    return added + updated


def main():
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    owner = "append.py"
    if "--owner" in args:
        i = args.index("--owner")
        owner = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        raise SystemExit(__doc__)

    payload = json.load(open(args[0], encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("append.py: input must be a JSON object keyed by data file stem")

    print("append (%s)%s" % (owner, "  DRY RUN" if dry else ""))
    changed = 0
    # one lock for the whole merge: either every file sees the new records or none does
    with pipeline_lock(owner):
        for stem, recs in payload.items():
            if not isinstance(recs, list):
                raise SystemExit("append.py: %r must be a list" % stem)
            changed += merge(stem, recs, dry)
    print("  %d record(s) added or updated" % changed)
    if changed == 0:
        print("  nothing new — this window was already ingested (no-op, not an error)")


if __name__ == "__main__":
    main()
