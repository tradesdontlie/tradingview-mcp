#!/usr/bin/env python3
"""Structural verification of what was actually written to public/.

Browser-independent on purpose: this tree lives in iCloud Drive, where the
session's preview launcher cannot read files at all, so a check written as
"open it and look" would pass vacuously. Everything here reads the built bytes.

    python3 lib/verify_build.py       exit 0 clean, 1 on any failure
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
API = os.path.join(PUBLIC, "api")

EXPECTED = ["regime-gauge", "scorecard", "credit-stress", "vol-stress-radar", "macro",
            "smart-money", "analyst-research", "market-pulse", "backtest", "alerts",
            "summary", "freshness"]

failures, notes = [], []


def fail(msg):
    failures.append(msg)


def note(msg):
    notes.append(msg)


def main():
    # 1. the shell the browser loads
    index = os.path.join(PUBLIC, "index.html")
    if not os.path.isfile(index):
        fail("public/index.html is missing")
        return report()
    html = open(index, encoding="utf-8").read()
    if '<div id="root">' not in html:
        fail("index.html has no #root mount point")
    scripts = re.findall(r'src="(\./assets/[^"]+\.js)"', html)
    if not scripts:
        fail("index.html references no bundle")

    # 2. the bundle, and the base-URL bug that ships broken from Perplexity
    for rel in scripts:
        path = os.path.join(PUBLIC, rel.lstrip("./"))
        if not os.path.isfile(path):
            fail(f"bundle referenced but missing: {rel}")
            continue
        js = open(path, encoding="utf-8").read()
        if '"port/5000"' in js:
            fail(f"{rel} still contains the broken API base URL 'port/5000' — "
                 "run lib/patch_frontend.py")
        found = set(re.findall(r'"(/api/[a-z-]+)"', js))
        missing = {f"/api/{e}" for e in EXPECTED} - found
        if missing:
            fail(f"{rel} does not reference {sorted(missing)} — the endpoint list "
                 "has drifted from the bundle")
        note(f"{rel}: {len(js):,} bytes, {len(found)} endpoints referenced")

    # 3. every endpoint present, parseable, non-empty
    for name in EXPECTED:
        path = os.path.join(API, name)
        if not os.path.isfile(path):
            fail(f"public/api/{name} is missing — run bake.py")
            continue
        raw = open(path, encoding="utf-8").read()
        if not raw.strip():
            fail(f"public/api/{name} is empty")
            continue
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            fail(f"public/api/{name} is not valid JSON: {exc}")
            continue
        if not isinstance(payload, dict):
            fail(f"public/api/{name} is not a JSON object")
            continue
        # An extension would break the fetch path the bundle builds.
        if "." in name:
            fail(f"public/api/{name} has a file extension; the frontend fetches "
                 f"/api/{name.split('.')[0]}")

    # 4. the payloads must satisfy the same contract the bake gates on
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from validate import validate_all
    try:
        payloads = {n: json.load(open(os.path.join(API, n), encoding="utf-8"))
                    for n in EXPECTED if os.path.isfile(os.path.join(API, n))}
    except ValueError:
        payloads = {}
    if len(payloads) == len(EXPECTED):
        for err in validate_all(payloads):
            fail(f"contract: {err}")

    # 5. no external hosts — the page must run entirely from this origin plus
    #    the font stylesheet it shipped with
    externals = set(re.findall(r'(?:src|href)="(https?://[^"]+)"', html))
    allowed = ("https://fonts.googleapis.com", "https://fonts.gstatic.com")
    for url in externals:
        if not url.startswith(allowed):
            fail(f"index.html loads an unexpected external resource: {url}")

    # 6. sanity on the numbers a reader will actually see
    if "scorecard" in payloads:
        assets = payloads["scorecard"]["assets"]
        priced = [a for a in assets if a["price"] is not None]
        if not priced:
            fail("scorecard has no priced assets — every card would be a gap chip")
        note(f"scorecard: {len(priced)}/{len(assets)} assets priced")
    if "backtest" in payloads:
        live = [r for r in payloads["backtest"]["results"] if r["gapReason"] is None]
        if not live:
            fail("backtest has no computable results")
        for r in live:
            if r["tradingDays"] < 500:
                fail(f"backtest[{r['symbol']}] has only {r['tradingDays']} trading days — "
                     "too short to be worth showing for a 200-day rule")
        note(f"backtest: {len(live)}/{len(payloads['backtest']['results'])} symbols, "
             f"{live[0]['tradingDays'] if live else 0} trading days")
    if "freshness" in payloads:
        srcs = payloads["freshness"]["sources"]
        if not srcs:
            fail("freshness lists no sources — the strip would not render")
        note(f"freshness: {', '.join(s['label'] for s in srcs)}")

    return report()


def report():
    for n in notes:
        print(f"  ok   {n}")
    if failures:
        for f in failures:
            print(f"  FAIL {f}")
        print(f"\nverify_build: {len(failures)} failure(s)")
        return 1
    print("\nverify_build: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
