#!/usr/bin/env python3
"""Macro Nowcast manual push routine.

    python3 bake.py            refresh anything older than its TTL
    python3 bake.py --force    ignore the cache and refetch everything
    python3 bake.py --offline  build only from what is already cached

Fetches every series in the registry from its publisher, computes the nine
signal cards and the weighted liquidity composite, diffs the result against the
previous stored vintage, and renders one self-contained HTML page. A series that
fails becomes an explicit gap on its card; it is never replaced by a carried
number pretending to be current. Nothing is written unless the built vintage and
the rendered page both pass the gate in lib/verify.py.
"""
import argparse, datetime, json, os, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import build
import history
import render
import sources
import universe as U
import verify
from fetcher import FetchError

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
PAGE = os.path.join(DIST, "macro-nowcast.html")
MANIFEST = os.path.join(ROOT, "build-manifest.json")

# Publication cadence drives the cache TTL: a weekly balance sheet does not
# reward a fifteen-minute refetch, and the publishers are all being asked
# politely by one person on one machine.
TTL = {"d": 900, "w": 6 * 3600, "m": 12 * 3600}


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def run():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="ignore cache TTLs and refetch")
    ap.add_argument("--offline", action="store_true", help="build only from cached responses")
    args = ap.parse_args()
    if args.force and args.offline:
        sys.exit("--force and --offline are mutually exclusive")

    started = time.time()
    now = datetime.datetime.now().astimezone()
    print(f"Macro Nowcast bake  {now.isoformat(timespec='seconds')}")
    print(f"  mode: {'force' if args.force else 'offline' if args.offline else 'normal'}")

    previous = history.load_latest()
    if previous:
        print(f"  previous vintage: {previous['stamp']} "
              f"(composite {previous['composite'].get('raw')})")
    else:
        print("  previous vintage: none — this is the baseline")

    # -------------------------------------------------------------- fetching
    print(f"\n[1/4] fetching {sum(len(v) for v in U.INDICATORS.values())} series")
    fetched, gaps, providers = {}, {}, {}
    # One fetch per (provider, ident): a series used by two pillars is pulled once.
    seen = {}
    for pid, specs in U.INDICATORS.items():
        for spec in specs:
            key = (spec["provider"], str(spec["ident"]))
            if key in seen:
                if seen[key] is not None:
                    fetched[(pid, spec["key"])] = seen[key]
                else:
                    gaps[f"{pid}/{spec['key']}"] = "duplicate of a failed fetch"
                continue
            max_age = (0 if args.force else 10 ** 9 if args.offline else TTL[spec["cadence"]])
            try:
                obs = sources.fetch(spec["provider"], spec["ident"], max_age=max_age)
            except (FetchError, Exception) as exc:  # noqa: BLE001 - publishers vary
                seen[key] = None
                gaps[f"{pid}/{spec['key']}"] = str(exc)[:90]
                print(f"  gap  {spec['provider']:<9} {spec['key']:<12} {str(exc)[:64]}")
                continue
            seen[key] = obs
            fetched[(pid, spec["key"])] = obs
            providers[spec["provider"]] = providers.get(spec["provider"], 0) + 1
            flag = "cache" if obs.from_cache else "live"
            print(f"  ok   {spec['provider']:<9} {spec['key']:<12} {len(obs):>5} obs  "
                  f"last={obs.last_period} ({flag})")

    if not fetched:
        sys.exit("bake aborted: no series resolved at all — nothing to build")

    # -------------------------------------------------------------- building
    print("\n[2/4] computing cards and composite")
    cards = build.build_cards(fetched, previous)
    composite = build.build_composite(cards, previous)
    title, copy = build.regime_label(cards, composite)
    moved = [c["id"] for c in cards if c["freshness"] == "verified"]
    eyebrow = (f"{len(moved)} of {len(cards)} pillars advanced this bake"
               if moved else "No pillar advanced since the previous vintage")

    vintage = {
        "stamp": now.strftime("%Y%m%dT%H%M%S"),
        "label": now.strftime("%-d %b %Y %H:%M"),
        "built_at": now.isoformat(timespec="seconds"),
        "cards": cards,
        "composite": composite,
        "geometry": build.build_geometry(cards),
        "regime": {"title": title, "copy": copy, "eyebrow": eyebrow},
        "alerts": build.build_alerts(cards, composite),
        "scenarios": build.build_scenarios(cards, composite),
        "ledger": build.build_ledger(cards, previous),
        "timeline": build.build_timeline(cards),
    }
    for c in cards:
        arrow = "→" if c["delta"] is None else f"{c['delta']:+.2f}"
        print(f"  {c['id']:<7} score {str(c['score']):>6}  {arrow:>7}  "
              f"{c['freshness']:<8} {c['confidence']:<6} {c['status'][:38]}")
    print(f"  composite {composite['raw']} ({composite['score']}/100), "
          f"confidence {composite['confidence']}%")

    # ---------------------------------------------------------------- gating
    print("\n[3/4] verifying")
    errors = verify.check_vintage(vintage)
    if errors:
        for err in errors:
            print(f"  FAIL {err}")
        sys.exit(f"bake aborted: {len(errors)} structural violation(s) — nothing written")
    print(f"  ok   vintage passes {len(cards)} card checks")

    vintages = [vintage] + history.load_recent(history.KEEP - 1)
    manifest = {
        "built_at": vintage["built_at"],
        "elapsed_seconds": round(time.time() - started, 1),
        "series_ok": len(fetched),
        "series_gap": len(gaps),
        "gaps": gaps,
        "providers": providers,
        "composite_raw": composite["raw"],
        "composite_score": composite["score"],
        "confidence": composite["confidence"],
        "weight_covered": composite["weight_covered"],
        "regime": title,
        "alerts": len(vintage["alerts"]),
        "vintages_stored": len(vintages),
        "page": PAGE,
    }

    page = render.render(vintage, vintages, manifest)
    page_errors = verify.check_page(page)
    if page_errors:
        for err in page_errors:
            print(f"  FAIL {err}")
        sys.exit(f"bake aborted: {len(page_errors)} page violation(s) — nothing written")
    print(f"  ok   page passes self-containment checks ({len(page):,} bytes)")

    # --------------------------------------------------------------- writing
    print("\n[4/4] writing")
    history.save(vintage)
    history.prune()
    write_atomic(PAGE, page)
    write_atomic(MANIFEST, json.dumps(manifest, indent=1) + "\n")
    print(f"  vintage  vintages/{vintage['stamp']}.json")
    print(f"  page     {PAGE}")

    print(f"\n{title}")
    print(f"  composite {composite['score']}/100 (raw {composite['raw']}), "
          f"confidence {composite['confidence']}%, {composite['weight_covered']}% weight covered")
    print(f"  {len(fetched)} series from {len(providers)} publishers in "
          f"{manifest['elapsed_seconds']}s; {len(gaps)} unresolved")
    if gaps:
        print(f"  unresolved: {', '.join(sorted(gaps))}")


def main():
    # One bake at a time: concurrent runs interleave their vintage writes.
    try:
        with history.lock():
            run()
    except history.Locked as exc:
        sys.exit(f"bake aborted: {exc}")


if __name__ == "__main__":
    main()
