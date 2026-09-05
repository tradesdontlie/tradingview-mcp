#!/usr/bin/env python3
"""Build each API payload from live series.

Every function returns the exact shape the compiled frontend reads. Where a
number cannot be computed the field is None and, on panels that support it, a
`gapReason` is set so the UI renders its amber chip instead of a fabricated
value. Nothing here invents data.
"""
import datetime

import series as S
import universe as U
from fetcher import FetchError
from sources import fetch_fred, fetch_series


def _round(x, n=4):
    return None if x is None else round(x, n)


# ---------------------------------------------------------------- scorecard

def build_scorecard(store):
    assets = []
    for symbol, label, klass in U.SCORECARD:
        s = store.get(symbol)
        if s is None or not s.closes:
            assets.append({
                "symbol": symbol, "label": label, "assetClass": klass,
                "price": None, "changePct1D": None, "changePct1W": None,
                "changePct1M": None, "changePct3M": None, "sparkline": [],
                "above50d": None, "above200d": None,
                # A symbol that loaded but carries no closes has no recorded gap
                # reason; without this default the card would render blank
                # instead of a chip.
                "gapReason": store.gap_reason(symbol) or "no-data",
            })
            continue
        assets.append({
            "symbol": symbol, "label": label, "assetClass": klass,
            "price": _round(s.last, 4),
            "changePct1D": _round(S.pct_change(s.closes, S.WINDOW["1D"])),
            "changePct1W": _round(S.pct_change(s.closes, S.WINDOW["1W"])),
            "changePct1M": _round(S.pct_change(s.closes, S.WINDOW["1M"])),
            "changePct3M": _round(S.pct_change(s.closes, S.WINDOW["3M"])),
            "sparkline": S.sparkline(s.closes),
            "above50d": S.above_sma(s.closes, 50),
            "above200d": S.above_sma(s.closes, 200),
            "gapReason": None,
        })
    return {"assets": assets}


# ------------------------------------------------------------ credit stress

def _ratio_change_1m(store, a, b):
    sa, sb = store.get(a), store.get(b)
    if sa is None or sb is None:
        return None
    ratio = S.ratio_series(sa.closes, sb.closes)
    return _round(S.pct_change(ratio, S.WINDOW["1M"]))


def build_credit_stress(store):
    vix = store.get("^VIX")
    hyg_lqd = _ratio_change_1m(store, "HYG", "LQD")

    if hyg_lqd is None:
        stress_label = None
    elif hyg_lqd < -0.5:
        stress_label = "Widening"
    elif hyg_lqd > 0.5:
        stress_label = "Tightening"
    else:
        stress_label = "Stable"

    return {
        "vix": {
            "price": _round(vix.last, 4) if vix else None,
            "changePct": _round(S.pct_change(vix.closes, 1)) if vix else None,
        },
        "stressLabel": stress_label,
        "hygLqdRatioChangePct1M": hyg_lqd,
        "hygTltRatioChangePct1M": _ratio_change_1m(store, "HYG", "TLT"),
        "lqdTltRatioChangePct1M": _ratio_change_1m(store, "LQD", "TLT"),
    }


# ------------------------------------------------------------- regime gauge

def build_regime(store, prev_score=None):
    """A 0-100 composite of trend breadth, VIX percentile and credit trend.

    Explicitly a heuristic — the UI labels it "not a market fact". The weights
    are stated here rather than tuned: breadth 50, vol 30, credit 20.
    """
    flags = [store.get(sym) for sym, _, _ in U.SCORECARD]
    breadth_votes = [S.above_sma(s.closes, 50) for s in flags if s is not None]
    breadth_votes = [v for v in breadth_votes if v is not None]
    breadth_pct = (sum(breadth_votes) / len(breadth_votes) * 100.0) if breadth_votes else None

    vix = store.get("^VIX")
    vix_level = _round(vix.last, 4) if vix else None
    # Lower VIX percentile => calmer => higher score.
    vix_score = None
    if vix and len(vix.closes) > 30:
        rank = S.percentile_rank(vix.closes[-252:], vix.closes[-1])
        vix_score = 100.0 - rank if rank is not None else None

    hyg_lqd = _ratio_change_1m(store, "HYG", "LQD")
    if hyg_lqd is None:
        credit_trend, credit_score = None, None
    elif hyg_lqd < -0.5:
        credit_trend, credit_score = "Widening", 20.0
    elif hyg_lqd > 0.5:
        credit_trend, credit_score = "Tightening", 85.0
    else:
        credit_trend, credit_score = "Stable", 55.0

    parts = [(breadth_pct, 0.50), (vix_score, 0.30), (credit_score, 0.20)]
    live = [(v, w) for v, w in parts if v is not None]
    if live:
        weight = sum(w for _, w in live)
        score = sum(v * w for v, w in live) / weight
    else:
        score = None

    if score is None:
        label = None
    elif score >= 70:
        label = "Risk-On"
    elif score >= 55:
        label = "Constructive"
    elif score >= 40:
        label = "Neutral"
    elif score >= 25:
        label = "Cautious"
    else:
        label = "Risk-Off"

    delta = None if (score is None or prev_score is None) else round(score - prev_score, 2)
    if delta is None:
        trend = "Steady"
    elif delta > 1.0:
        trend = "Improving"
    elif delta < -1.0:
        trend = "Deteriorating"
    else:
        trend = "Steady"

    driver = None
    if score is not None:
        weakest = min(
            [p for p in [("trend breadth", breadth_pct), ("volatility", vix_score),
                         ("credit", credit_score)] if p[1] is not None],
            key=lambda p: p[1], default=None)
        if weakest:
            driver = f"Largest drag: {weakest[0]} at {weakest[1]:.0f}/100."

    return {
        "score": None if score is None else round(score, 2),
        "label": label,
        "trend": trend,
        "scoreDelta": delta,
        "componentsNote": ("Derived heuristic — 50% cross-asset trend breadth, 30% inverted "
                           "1Y VIX percentile, 20% HYG/LQD credit trend. Decision support only, "
                           "not a market fact."),
        "driverNote": driver,
        "breadthPct": _round(breadth_pct, 2),
        "vixLevel": vix_level,
        "creditTrend": credit_trend,
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# -------------------------------------------------------- vol stress radar

def _tell(tid, name, explanation, weight, value, display, alert_if, watch_if):
    """One radar row. `alert_if`/`watch_if` are predicates over `value`."""
    if value is None:
        return {"id": tid, "name": name, "explanation": explanation, "weight": weight,
                "status": None, "displayValue": None, "gapReason": "no-data"}
    if alert_if(value):
        status = "ALERT"
    elif watch_if(value):
        status = "WATCH"
    else:
        status = "CALM"
    return {"id": tid, "name": name, "explanation": explanation, "weight": weight,
            "status": status, "displayValue": display, "gapReason": None}


def build_vol_radar(store, fred_get=None):
    vix = store.get("^VIX")
    vix9d = store.get("^VIX9D")
    vix3m = store.get("^VIX3M")
    vvix = store.get("^VVIX")
    move = store.get("^MOVE")
    skew = store.get("^SKEW")

    vix_last = vix.last if vix else None
    vix9d_last = vix9d.last if vix9d else None
    vix3m_last = vix3m.last if vix3m else None
    # Term structure. Above 1.00 is backwardation — near-term fear bid over the
    # far month, the classic stress tell. Prefer 9-day over 30-day; fall back to
    # 30-day over 3-month, which carries the same signal at a longer horizon.
    if vix_last and vix9d_last:
        term, term_label = vix9d_last / vix_last, "VIX Term Structure (9D/30D)"
    elif vix_last and vix3m_last:
        term, term_label = vix_last / vix3m_last, "VIX Term Structure (30D/3M)"
    else:
        term, term_label = None, "VIX Term Structure"

    vix_pctile = None
    if vix and len(vix.closes) > 60:
        vix_pctile = S.percentile_rank(vix.closes[-252:], vix.closes[-1])

    vvix_last = vvix.last if vvix else None
    skew_last = skew.last if skew else None

    # Rates volatility. ICE's MOVE has no keyless feed, so when it is missing we
    # fall back to CBOE's TLT volatility index — same idea, different scale, so
    # the thresholds move with it.
    vxtlt = store.get("^VXTLT")
    move_last = move.last if move else None
    if move_last is not None:
        rates_value, rates_label = move_last, "MOVE (Rates Vol)"
        rates_display = f"{move_last:.1f}"
        rates_alert, rates_watch = 140.0, 110.0
    elif vxtlt is not None and vxtlt.last:
        rates_value, rates_label = vxtlt.last, "VXTLT (Rates Vol)"
        rates_display = f"{vxtlt.last:.2f}"
        rates_alert, rates_watch = 16.0, 13.0
    else:
        rates_value, rates_label, rates_display = None, "Rates Vol", None
        rates_alert, rates_watch = 140.0, 110.0

    hyg_lqd = _ratio_change_1m(store, "HYG", "LQD")

    breadth = [S.above_sma(s.closes, 50) for s in
               (store.get(sym) for sym, _, _ in U.SCORECARD) if s is not None]
    breadth = [b for b in breadth if b is not None]
    breadth_pct = (sum(breadth) / len(breadth) * 100.0) if breadth else None

    # Real credit spreads, not an ETF ratio. Ranked within a trailing year so a
    # structurally tight regime does not read as permanently calm.
    oas_pctile, oas_display = None, None
    if fred_get is not None:
        try:
            obs, _, _ = fred_get("BAMLH0A0HYM2")
            values = [v for _, v in obs[-260:]]
            if values:
                oas_pctile = S.percentile_rank(values, values[-1])
                oas_display = f"{values[-1]:.2f}%"
        except Exception:  # noqa: BLE001 - a missing series is just a gap
            oas_pctile, oas_display = None, None

    tells = [
        _tell("vix-level", "VIX Level",
              "Spot 30-day implied volatility. Above 20 marks a stressed tape.",
              0.20, vix_last, f"{vix_last:.2f}" if vix_last else None,
              lambda v: v >= 25, lambda v: v >= 18),
        _tell("vix-term", term_label,
              "Backwardation above 1.00 means near-term fear is bid over the month.",
              0.20, term, f"{term:.3f}" if term else None,
              lambda v: v >= 1.00, lambda v: v >= 0.95),
        _tell("vix-percentile", "VIX 1Y Percentile",
              "Where spot VIX sits in its own trailing year.",
              0.15, vix_pctile, f"{vix_pctile:.0f}%" if vix_pctile is not None else None,
              lambda v: v >= 85, lambda v: v >= 65),
        _tell("vvix", "VVIX (Vol-of-Vol)",
              "The volatility of VIX itself. Elevated VVIX front-runs vol spikes.",
              0.15, vvix_last, f"{vvix_last:.1f}" if vvix_last else None,
              lambda v: v >= 110, lambda v: v >= 95),
        _tell("move", rates_label,
              "Implied volatility in Treasuries. Rate stress leads credit stress.",
              0.05, rates_value, rates_display,
              lambda v: v >= rates_alert, lambda v: v >= rates_watch),
        _tell("skew", "CBOE SKEW",
              "The price of tail hedges relative to at-the-money.",
              0.05, skew_last, f"{skew_last:.1f}" if skew_last else None,
              lambda v: v >= 155, lambda v: v >= 145),
        _tell("hy-oas", "High Yield OAS",
              "ICE BofA US high-yield option-adjusted spread, and where it sits in its own year.",
              0.10, oas_pctile, oas_display,
              lambda v: v >= 85, lambda v: v >= 65),
        _tell("credit", "Credit Internals (HYG/LQD 1M)",
              "High yield versus investment grade. Falling means spreads widening.",
              0.05, hyg_lqd, f"{hyg_lqd:+.2f}%" if hyg_lqd is not None else None,
              lambda v: v <= -1.5, lambda v: v <= -0.5),
        _tell("breadth", "Cross-Asset Breadth",
              "Share of tracked assets holding their 50-day average.",
              0.05, breadth_pct, f"{breadth_pct:.0f}%" if breadth_pct is not None else None,
              lambda v: v <= 25, lambda v: v <= 45),
    ]

    scored = [t for t in tells if t["status"] is not None]
    if scored:
        pts = {"ALERT": 100.0, "WATCH": 55.0, "CALM": 10.0}
        wsum = sum(t["weight"] for t in scored)
        composite = sum(pts[t["status"]] * t["weight"] for t in scored) / wsum
    else:
        composite = None

    if composite is None:
        tier = None
    elif composite >= 60:
        tier = "WARNING"
    elif composite >= 35:
        tier = "WATCH"
    else:
        tier = "CLEAR"

    n_alert = sum(1 for t in scored if t["status"] == "ALERT")
    n_watch = sum(1 for t in scored if t["status"] == "WATCH")
    if composite is None:
        synthesis = "Radar snapshot unavailable right now — check back shortly."
    elif tier == "WARNING":
        synthesis = (f"{n_alert} of {len(scored)} stress tells are in alert and {n_watch} on watch — "
                     "the options complex is pricing meaningful near-term risk.")
    elif tier == "WATCH":
        synthesis = (f"{n_watch} of {len(scored)} tells are elevated with {n_alert} in alert — "
                     "stress is building at the edges but not broad-based.")
    else:
        synthesis = (f"{len(scored) - n_alert - n_watch} of {len(scored)} tells are calm — "
                     "the vol complex is not signalling stress.")

    return {
        "methodologyNote": ("Heuristic early-warning signals derived from live options-market "
                            "internals — not predictive, not investment advice."),
        "synthesis": synthesis,
        "compositeScore": None if composite is None else round(composite, 2),
        "tier": tier,
        "tells": tells,
    }


# -------------------------------------------------------------------- macro

# How far past its last observation a macro series may be before we stop
# showing it. The frontend renders the value with no date beside it, so a
# discontinued series would otherwise read as a current print.
MACRO_MAX_AGE_DAYS = 420


def _observation_age_days(period):
    """Age of an observation. FRED gives YYYY-MM-DD, OECD/Eurostat give YYYY-MM."""
    if not isinstance(period, str):
        return None
    text = period if len(period) > 7 else f"{period}-01"
    try:
        observed = datetime.date.fromisoformat(text)
    except ValueError:
        return None
    return (datetime.date.today() - observed).days


def build_macro(observe):
    """One row per indicator. `observe(provider, ident)` returns [(period, value)].

    Index series are converted to a year-over-year rate; OECD and Eurostat
    already publish rates, so they pass through.
    """
    countries = {}
    for country, indicators in U.MACRO.items():
        rows = []
        for name, provider, ident, unit in indicators:
            try:
                obs = observe(provider, ident)
            except Exception as exc:  # noqa: BLE001 - any failure is a gap
                rows.append({"indicator": name, "latestValue": None, "unit": "percent",
                             "observedAt": None, "observationAgeDays": None,
                             "stale": False, "source": provider, "error": str(exc)[:120]})
                continue

            if unit in U.YOY_UNITS:
                value, out_unit = _yoy(obs), "percent"
            else:
                value = obs[-1][1]
                out_unit = "percent" if unit == "percent" else unit

            observed_at = obs[-1][0]
            age = _observation_age_days(observed_at)
            stale = age is not None and age > MACRO_MAX_AGE_DAYS
            if stale:
                value = None

            rows.append({"indicator": name,
                         "latestValue": _round(value, 3),
                         "unit": out_unit,
                         "observedAt": observed_at,
                         "observationAgeDays": age,
                         "stale": bool(stale),
                         "source": provider})
        countries[country] = rows
    return {"countries": countries}


def _yoy(obs):
    """Year-over-year percent change from a monthly or quarterly index."""
    if len(obs) < 2:
        return None
    last_date, last_val = obs[-1]
    target = f"{int(last_date[:4]) - 1}{last_date[4:]}"
    prior = None
    for date, val in reversed(obs[:-1]):
        if date <= target:
            prior = val
            break
    if prior is None or not prior:
        return None
    return (last_val / prior - 1.0) * 100.0


# ------------------------------------------------------------- market pulse

def build_market_pulse(store):
    rows = []
    for sym in U.PULSE:
        s = store.get(sym)
        if s is None or len(s.closes) < 2:
            continue
        chg = S.pct_change(s.closes, 1)
        if chg is None:
            continue
        dollar_vol = None
        if s.volumes and s.volumes[-1] is not None:
            dollar_vol = s.volumes[-1] * s.closes[-1]
        rows.append({"symbol": sym,
                     "name": U.PULSE_NAMES.get(sym) or s.meta.get("shortName") or sym,
                     "price": _round(s.last, 4),
                     "changePct": _round(chg),
                     "_dollarVolume": dollar_vol})

    by_change = sorted(rows, key=lambda r: r["changePct"], reverse=True)
    with_vol = [r for r in rows if r["_dollarVolume"] is not None]
    by_volume = sorted(with_vol, key=lambda r: r["_dollarVolume"], reverse=True)
    strip = lambda rs: [{k: v for k, v in r.items() if not k.startswith("_")} for r in rs]

    return {
        "gainers": strip(by_change[:8]),
        "losers": strip(list(reversed(by_change))[:8]),
        "mostActive": strip(by_volume[:8]),
        "universeNote": f"Ranked within a stated {len(U.PULSE)}-name large-cap universe.",
    }


# ----------------------------------------------------------------- backtest

def _run_trend_strategy(closes, window=200, lag=1, cost_bps=0.0):
    """Long when the close is above its `window`-day average, else flat.

    The signal is read `lag` days before the return it earns, so no bar uses
    information it could not have had. Costs are charged on position changes.
    """
    if len(closes) < window + lag + 2:
        return None
    strat, bench = [1.0], [1.0]
    prev_pos = 0.0
    for i in range(window + lag, len(closes)):
        ma = sum(closes[i - lag - window + 1: i - lag + 1]) / window
        pos = 1.0 if closes[i - lag] > ma else 0.0
        ret = closes[i] / closes[i - 1] - 1.0
        cost = abs(pos - prev_pos) * (cost_bps / 10000.0)
        strat.append(strat[-1] * (1.0 + pos * ret - cost))
        bench.append(bench[-1] * (1.0 + ret))
        prev_pos = pos
    return strat, bench


def _stats(equity):
    rets = S.daily_returns(equity)
    return {
        "cumulativeReturnPct": _round((equity[-1] / equity[0] - 1.0) * 100.0, 3),
        "cagrPct": _round(S.cagr_pct(equity, len(equity) - 1), 3),
        "maxDrawdownPct": _round(S.max_drawdown_pct(equity), 3),
        "sharpeRatio": _round(S.sharpe(rets), 3),
    }


def build_backtest(store):
    results = []
    for symbol, label in U.BACKTEST:
        s = store.get(symbol, long=True)
        rule = "Hold the ETF while it closes above its 200-day average, otherwise hold cash. Signal read with a one-day lag."
        base = {"symbol": symbol, "label": label, "ruleDescription": rule}
        run = _run_trend_strategy(s.closes) if s else None
        if run is None:
            results.append({**base, "gapReason": store.gap_reason(symbol) or "no-data",
                            "startDate": None, "endDate": None, "tradingDays": 0,
                            "curve": [], "strategy": {}, "benchmark": {},
                            "strategyBenchmarkCorrelation": None, "stressTest": None})
            continue

        strat, bench = run
        offset = len(s.closes) - len(strat)
        dates = s.dates[offset:]
        curve = [{"date": dates[i], "strategy": round(strat[i], 6),
                  "benchmark": round(bench[i], 6)} for i in range(len(strat))]

        variants = []
        for vid, vlabel, desc, kw in [
            ("baseline", "Baseline", "As charted — no costs, one-day signal lag.", {}),
            ("costs", "Higher Costs", "10bps charged on every position change.", {"cost_bps": 10.0}),
            ("delayed", "Delayed Fill", "One extra day between signal and fill.", {"lag": 2}),
        ]:
            v = _run_trend_strategy(s.closes, **kw)
            if v is None:
                continue
            variants.append({"id": vid, "label": vlabel, "description": desc,
                             "stats": _stats(v[0])})

        results.append({
            **base,
            "gapReason": None,
            "startDate": dates[0],
            "endDate": dates[-1],
            "tradingDays": len(strat),
            "curve": curve,
            "strategy": _stats(strat),
            "benchmark": _stats(bench),
            "strategyBenchmarkCorrelation": _round(
                S.correlation(S.daily_returns(strat), S.daily_returns(bench)), 4),
            "stressTest": {"costBps": 10, "variants": variants} if variants else None,
        })

    return {
        "disclaimer": ("Illustrative backtest only — past performance does not predict future "
                       "results. Not investment advice."),
        "results": results,
    }


# ------------------------------------------------------------- smart money
# All three tables are live and keyless: 13F holdings and analyst consensus come
# from Nasdaq's public company endpoints, congressional trades from the House
# Clerk's own PTR filings. Yahoo's quoteSummary would serve the first two but
# needs an authenticated crumb, and every commercial congress mirror is gone.

def build_smart_money(holders, crowd, trades):
    holders = holders or {t: [] for t in U.MEGA_CAP}
    crowd = crowd or {t: {"label": None, "topHolderSharePct": None} for t in U.MEGA_CAP}
    trades = trades or []

    tilt = None
    if trades:
        buys = sum(1 for t in trades if t.get("type") == "Buy")
        tilt = {"label": (f"{buys} of the last {len(trades)} filed congressional "
                          f"transactions are purchases")}
    else:
        tilt = {"label": ("No congressional transactions parsed from the current House "
                          "filing index")}

    # The table renders only these keys; drop the provenance fields.
    slim = [{k: t.get(k, "") for k in ("date", "politician", "ticker", "type", "amount")}
            for t in trades]

    return {"tradeTilt": tilt, "holders": holders, "crowding": crowd, "trades": slim,
            "gapReason": None,
            "sourceNote": "13F via Nasdaq; congressional trades via House Clerk PTR filings."}


def build_analyst_research(ratings):
    ratings = ratings or []
    return {"ratings": ratings,
            "gapReason": None if ratings else "no-data",
            "sourceNote": "Analyst consensus via Nasdaq."}


# ------------------------------------------------------------------- alerts

def build_alerts(regime, credit, radar, scorecard):
    """Threshold breaches derived from the payloads already computed.

    Every alert restates a number shown elsewhere on the page, so nothing here
    can contradict the panel it came from.
    """
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    out = []

    def add(aid, severity, message):
        out.append({"id": aid, "severity": severity, "message": message, "detectedAt": now})

    vix = credit["vix"]["price"]
    if vix is not None:
        if vix >= 25:
            add("vix-high", "warning", f"VIX at {vix:.2f} — above the 25 stress threshold.")
        elif vix >= 20:
            add("vix-elevated", "info", f"VIX at {vix:.2f} — elevated but below stress levels.")

    if credit["stressLabel"] == "Widening":
        chg = credit["hygLqdRatioChangePct1M"]
        add("credit-widening", "warning",
            f"High-yield credit underperforming investment grade by {abs(chg):.2f}% over 1M — "
            "spreads widening.")

    if radar["tier"] == "WARNING":
        add("radar-warning", "warning",
            f"Volatility & Stress Radar at {radar['compositeScore']:.0f}/100 — WARNING tier.")
    elif radar["tier"] == "WATCH":
        add("radar-watch", "info",
            f"Volatility & Stress Radar at {radar['compositeScore']:.0f}/100 — WATCH tier.")

    breadth = regime.get("breadthPct")
    if breadth is not None and breadth <= 35:
        add("breadth-narrow", "warning",
            f"Only {breadth:.0f}% of tracked assets hold their 50-day average.")

    for asset in scorecard["assets"]:
        chg = asset.get("changePct1D")
        if chg is not None and abs(chg) >= 3.0:
            add(f"move-{asset['symbol']}", "info",
                f"{asset['label']} moved {chg:+.2f}% on the day.")

    gaps = [a["symbol"] for a in scorecard["assets"] if a.get("gapReason")]
    if gaps:
        add("data-gaps", "info",
            f"No live quote for {', '.join(gaps)} — those cards show a data-gap chip.")

    return {"alerts": out}


# ------------------------------------------------------------------ summary

def build_summary(regime, credit, radar, scorecard):
    bits = []
    if regime.get("label"):
        bits.append(f"Regime reads {regime['label']} at {regime['score']:.0f}/100")
    if regime.get("breadthPct") is not None:
        bits.append(f"with {regime['breadthPct']:.0f}% of tracked assets above their 50-day average")

    vix = credit["vix"]["price"]
    if vix is not None:
        bits.append(f"VIX at {vix:.2f}")
    if credit.get("stressLabel"):
        bits.append(f"credit {credit['stressLabel'].lower()}")
    if radar.get("tier"):
        bits.append(f"and the stress radar {radar['tier']}")

    if not bits:
        return {"sentence": "Live snapshot unavailable right now — check back shortly."}

    lead = ", ".join(bits[:2])
    rest = ", ".join(bits[2:])
    sentence = f"{lead}. {rest}." if rest else f"{lead}."
    return {"sentence": sentence[0].upper() + sentence[1:]}


# --------------------------------------------------------------- freshness

_LEVEL_BOUNDS = [("live", 120), ("ok", 900), ("stale", 6 * 3600)]


def _level(age_seconds):
    if age_seconds is None:
        return "error"
    for name, bound in _LEVEL_BOUNDS:
        if age_seconds <= bound:
            return name
    return "stale"


PROVIDER_LABELS = {
    "cboe":      ("CBOE", "VIX complex and VXTLT, published daily by the exchange."),
    "nasdaq":    ("Nasdaq", "Daily closes, 13F holdings and analyst consensus."),
    "fred":      ("FRED", "US macro and credit spreads, on each agency's release calendar."),
    "oecd":      ("OECD", "Consumer price series, monthly."),
    "eurostat":  ("Eurostat", "Euro-area aggregates, monthly."),
    "coingecko": ("CoinGecko", "Daily crypto closes."),
    "house":     ("House Clerk", "Periodic Transaction Reports, filed within 45 days."),
    "yahoo":     ("Yahoo Chart", "Fallback daily closes. Rate-limits aggressively by IP."),
}


def build_freshness(store, macro_ages, now, extra=None):
    """One row per provider that actually served data this bake.

    A provider nothing routed to is left out rather than shown as an error —
    the strip should describe what the page is built from, not what it isn't.
    """
    sources = []
    macro_ages = macro_ages or {}
    extra = extra or {}

    for provider, (label, cadence) in PROVIDER_LABELS.items():
        stamps = [t for t in (store.newest_at(provider),
                              macro_ages.get(provider),
                              extra.get(provider)) if t]
        if not stamps:
            continue
        age = max(0, int(now - max(stamps)))
        sources.append({"id": provider, "label": label, "ageSeconds": age,
                        "level": _level(age), "cadenceNote": cadence})

    return {"sources": sources}
