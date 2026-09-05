#!/usr/bin/env python3
"""APEX manual push routine.

    python3 bake.py            refresh everything older than its TTL
    python3 bake.py --force    ignore the cache and refetch
    python3 bake.py --offline  build only from what is already cached

Fetches live market and macro data, computes the twelve payloads the compiled
frontend reads, validates them against the contract extracted from that bundle,
and writes them atomically into public/api/. A panel whose source failed is
written as an explicit gap, never as an invented number.
"""
import argparse, datetime, json, os, subprocess, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import congress
import fundamentals
import macro_sources
import mirror
import panels
import report
import universe as U
from fetcher import FetchError
from sources import fetch_fred
from store import Store
from validate import validate_all

ROOT = os.path.dirname(os.path.abspath(__file__))
API_DIR = os.path.join(ROOT, "public", "api")
STATE = os.path.join(ROOT, "state.json")

# Endpoint name -> payload key. Files are written without an extension because
# the frontend fetches "/api/scorecard"; Response.json() ignores Content-Type,
# so any static server serves these correctly.
ENDPOINTS = ["regime-gauge", "scorecard", "credit-stress", "vol-stress-radar", "macro",
             "smart-money", "analyst-research", "market-pulse", "backtest", "alerts",
             "summary", "freshness"]


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def load_state():
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="ignore cache TTLs and refetch")
    ap.add_argument("--offline", action="store_true", help="build only from cached responses")
    args = ap.parse_args()

    if args.force and args.offline:
        sys.exit("--force and --offline are mutually exclusive")

    # --force refetches everything; --offline accepts a cache entry of any age.
    max_age = 0 if args.force else (10 ** 9 if args.offline else 900)
    # 13F filings and analyst consensus change on a quarterly / weekly rhythm,
    # so they get a much longer TTL than prices.
    holdings_age = 0 if args.force else (10 ** 9 if args.offline else 12 * 3600)
    started = time.time()
    state = load_state()

    print(f"APEX bake  {datetime.datetime.now().astimezone().isoformat(timespec='seconds')}")
    print(f"  mode: {'force' if args.force else 'offline' if args.offline else 'normal'} "
          f"(cache TTL {max_age}s)")

    store = Store()
    print("\n[1/5] market data")
    # Backtest symbols load first and deepest: a 200-day rule burns 200 bars of
    # warm-up, so a two-year pull leaves barely a year of signal to judge. Ten
    # years spans 2018, COVID and 2022. The store keeps one series per symbol,
    # so the shorter panels below reuse these rather than refetching.
    for sym, _ in U.BACKTEST:
        store.load(sym, rng="10y", years=10, max_age=max_age)
    for sym in [s for s, _, _ in U.SCORECARD] + U.VOL_COMPLEX + U.CREDIT:
        store.load(sym, rng="1y", years=2, max_age=max_age)

    print("\n[2/5] market pulse universe")
    # Pulse only ranks a one-day move, so a quarter of history is plenty —
    # asking Nasdaq for a full year here tripled the bake time.
    for sym in U.PULSE:
        store.load(sym, rng="3mo", years=0.25, max_age=max_age)

    print("\n[3/5] macro")
    obs_cache, macro_ages = {}, {}
    macro_age = 0 if args.force else 6 * 3600

    def observe(provider, ident):
        """One cached observation series, whichever agency publishes it."""
        key = (provider, ident if isinstance(ident, str) else ident[0])
        if key not in obs_cache:
            if provider == "fred":
                obs, fetched_at, cached = fetch_fred(ident, max_age=macro_age)
            elif provider == "oecd":
                obs, fetched_at, cached = macro_sources.fetch_oecd(ident, max_age=macro_age)
            elif provider == "eurostat":
                dataset, filters = ident
                obs, fetched_at, cached = macro_sources.fetch_eurostat(
                    dataset, filters, max_age=macro_age)
            else:
                raise ValueError(f"unknown macro provider {provider!r}")
            obs_cache[key] = obs
            macro_ages[provider] = max(macro_ages.get(provider, 0), fetched_at)
            print(f"  ok   {provider:<8} {key[1][:26]:<26} {len(obs):>5} obs  "
                  f"last={obs[-1][0]} ({'cache' if cached else 'live'})")
        return obs_cache[key]

    for country, indicators in U.MACRO.items():
        for _name, provider, ident, _unit in indicators:
            try:
                observe(provider, ident)
            except Exception as exc:  # noqa: BLE001
                label = ident if isinstance(ident, str) else ident[0]
                print(f"  gap  {provider:<8} {str(label)[:26]:<26} {str(exc)[:70]}")

    print("\n[4/5] smart money")
    holders, crowd, ratings = {}, {}, []
    for ticker in U.MEGA_CAP:
        try:
            rows = fundamentals.institutional_holders(ticker, max_age=holdings_age)
            holders[ticker] = rows
            crowd[ticker] = fundamentals.crowding(rows)
            print(f"  ok   {ticker:<6} {len(rows):>2} institutional holders")
        except Exception as exc:  # noqa: BLE001
            holders[ticker], crowd[ticker] = [], {"label": None, "topHolderSharePct": None}
            print(f"  gap  {ticker:<6} holdings: {exc}")
        try:
            target = fundamentals.analyst_targets(ticker, max_age=holdings_age)
            if target:
                ratings.append(target)
                print(f"  ok   {ticker:<6} consensus {target['avgPriceTarget']} "
                      f"({target['numAnalysts']} analysts)")
        except Exception as exc:  # noqa: BLE001
            print(f"  gap  {ticker:<6} targets: {exc}")

    trades = [] if args.offline else congress.recent_trades()
    extra_ages = {"house": time.time()} if trades else {}

    print("\n[5/5] computing payloads")
    regime = panels.build_regime(store, prev_score=state.get("last_regime_score"))
    scorecard = panels.build_scorecard(store)
    credit = panels.build_credit_stress(store)
    radar = panels.build_vol_radar(store, lambda sid: (observe("fred", sid), None, None))

    payloads = {
        "regime-gauge": regime,
        "scorecard": scorecard,
        "credit-stress": credit,
        "vol-stress-radar": radar,
        "macro": panels.build_macro(observe),
        "smart-money": panels.build_smart_money(holders, crowd, trades),
        "analyst-research": panels.build_analyst_research(ratings),
        "market-pulse": panels.build_market_pulse(store),
        "backtest": panels.build_backtest(store),
        "alerts": panels.build_alerts(regime, credit, radar, scorecard),
        "summary": panels.build_summary(regime, credit, radar, scorecard),
        "freshness": panels.build_freshness(store, macro_ages, time.time(), extra_ages),
    }

    missing = [e for e in ENDPOINTS if e not in payloads]
    if missing:
        sys.exit(f"bake aborted: no payload built for {missing}")

    print("\n[gate] validating payloads against the frontend contract")
    errors = validate_all(payloads)
    if errors:
        for err in errors:
            print(f"  FAIL {err}")
        sys.exit(f"bake aborted: {len(errors)} contract violation(s) — nothing written")
    print(f"  ok   {len(payloads)} payloads conform")

    for name, payload in payloads.items():
        write_atomic(os.path.join(API_DIR, name), json.dumps(payload, separators=(",", ":")))

    elapsed = time.time() - started
    gaps = store.gaps
    providers = {}
    for sym in store.loaded:
        providers[store.provider(sym)] = providers.get(store.provider(sym), 0) + 1

    manifest = {
        "baked_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "elapsed_seconds": round(elapsed, 1),
        "symbols_loaded": len(store.loaded),
        "symbols_gapped": len(gaps),
        "gaps": gaps,
        "providers": providers,
        "macro_series": len(obs_cache),
        "regime_score": regime["score"],
        "regime_label": regime["label"],
        "radar_tier": radar["tier"],
        "alerts": len(payloads["alerts"]["alerts"]),
        "institutional_holders": sum(len(v) for v in holders.values()),
        "analyst_ratings": len(ratings),
        "congress_trades": len(trades),
        "mirror": None,
        "endpoints": ENDPOINTS,
    }
    # Structural verification of the OUTPUT, not the inputs — this is the gate
    # that catches an unpatched bundle or an endpoint the frontend stopped
    # asking for. Browser-independent, because the preview cannot read iCloud.
    print("\n[verify] checking what was written")
    verify = subprocess.run([sys.executable, os.path.join(ROOT, "lib", "verify_build.py")],
                            capture_output=True, text=True)
    sys.stdout.write(verify.stdout)
    if verify.returncode != 0:
        sys.stderr.write(verify.stderr)
        sys.exit("bake wrote output that failed verification — inspect public/api/")

    # Mirror to local disk. The browser check has to load the page from
    # somewhere the preview launcher can actually read — see lib/mirror.py.
    print("\n[mirror] copying public/ to local disk for browser verification")
    try:
        manifest["mirror"] = mirror.mirror()
    except SystemExit as exc:
        manifest["mirror"] = None
        print(f"  warn mirror skipped: {exc}")

    # Snapshot report. Self-contained HTML with every number inlined, so it can
    # be published as an Artifact (whose CSP blocks /api/* entirely) and stays a
    # record of THIS bake rather than a view that drifts under its own timestamp.
    print("\n[report] rendering the snapshot")
    manifest["report"] = report.main_path()

    write_atomic(os.path.join(ROOT, "build-manifest.json"),
                 json.dumps(manifest, indent=1) + "\n")
    write_atomic(STATE, json.dumps({
        # Carried forward so every republish updates the same Artifact URL
        # instead of spawning a new one each run.
        "artifact_url": state.get("artifact_url"),
        "last_bake": manifest["baked_at"],
        "last_regime_score": regime["score"],
    }, indent=1) + "\n")

    print(f"\nwrote {len(payloads)} endpoints to public/api/  in {elapsed:.1f}s")
    print(f"  regime  {regime['label']} {regime['score']}  radar {radar['tier']}  "
          f"alerts {manifest['alerts']}")
    print(f"  sources {providers}  gaps {len(gaps)}")
    if gaps:
        print(f"  gapped: {', '.join(f'{k} ({v})' for k, v in gaps.items())}")


if __name__ == "__main__":
    main()
