#!/usr/bin/env python3
"""Assemble the vintage: cards, composite, regime, alerts, ledger, timeline.

A vintage is the complete state of the dashboard at one bake, and it is the unit
the history stores. Everything the page shows is in here, so the renderer is a
pure function of a vintage and the change ledger is a real diff between two of
them rather than written prose.
"""
import datetime
import inspect

import fmt
import indicators as I
import pillars as P
import universe as U

TITLE = {pid: title for pid, _g, _geo, _p, title, _w in U.PILLARS}
META = {pid: (glyph, geo, pillar) for pid, glyph, geo, pillar, _t, _w in U.PILLARS}


def build_cards(fetched, previous):
    """One card per pillar. `previous` is the prior vintage, or None."""
    prev_cards = {c["id"]: c for c in (previous or {}).get("cards", [])}
    cards = []
    for pid, glyph, geo, pillar, title, _w in U.PILLARS:
        prev = prev_cards.get(pid, {})
        prev_periods = prev.get("periods", {})
        readings, gaps = P.build_readings(pid, fetched, prev_periods)
        score, coverage, agreement = P.score_pillar(readings)
        delta = None
        if score is not None and prev.get("score") is not None:
            delta = score - prev["score"]
        direction = P._dir_word(delta)
        conf_word, conf_value = P.confidence_word(coverage, agreement, gaps)
        builder = P.BUILDERS[pid]
        # A presenter may take the pillar score so its headline cannot contradict
        # the arithmetic underneath it.
        if "score" in inspect.signature(builder).parameters:
            status, copy, triad, facts, headline_keys = builder(readings, score=score)
        else:
            status, copy, triad, facts, headline_keys = builder(readings)
        fresh = P.worst_freshness(readings, headline_keys) if readings else "stale"

        # The observation and release stamps come from the members that carry
        # the headline, so the card dates what it actually shows.
        head = [readings[k] for k in headline_keys if k in readings]
        obs_label = " · ".join(sorted({fmt.period(r["period"]) for r in head})) or "no observation"
        newest = max((r["when"] for r in head if r["when"]), default=None)
        ages = [r["age"] for r in head if r["age"] is not None]

        sources = []
        for k in headline_keys:
            if k in readings:
                spec = readings[k]["spec"]
                sources.append({"name": spec["source"], "url": spec["url"]})

        cards.append({
            "id": pid, "glyph": glyph, "geo": geo, "pillar": pillar, "title": title,
            "status": status, "copy": copy, "triad": triad, "facts": facts,
            "direction": direction, "confidence": conf_word,
            "confidence_value": round(conf_value * 100, 1),
            "freshness": fresh, "tone": P._tone(score, direction),
            "score": None if score is None else round(score, 2),
            "delta": None if delta is None else round(delta, 2),
            "coverage": round(coverage * 100, 1),
            "agreement": None if agreement is None else round(agreement * 100, 1),
            "weight": U.WEIGHTS.get(pid, 0),
            "obs": obs_label,
            "obs_date": newest.isoformat() if newest else None,
            "age_days": min(ages) if ages else None,
            "gaps": gaps,
            "members": len(readings),
            "sources": sources,
            "periods": {k: str(r["period"]) for k, r in readings.items()},
            "readings": {k: {"level": r["calc"]["level"], "raw": r["calc"]["raw"],
                             "score": r["score"], "fresh": r["fresh"],
                             "period": str(r["period"]), "label": r["spec"]["label"],
                             "unit": r["spec"]["unit"], "cadence": r["spec"]["cadence"],
                             "weight": r["weight"], "scored": r["scored"],
                             "pctile": r["pctile"]}
                         for k, r in readings.items()},
        })
    return cards


def build_composite(cards, previous):
    """The weighted liquidity composite, and the confidence attached to it.

    Only the weighted pillars enter. A pillar that failed to score is dropped and
    the remaining weights are renormalised, so a gap lowers confidence instead of
    silently scoring zero.
    """
    contrib, total_w = [], 0.0
    for c in cards:
        w = c["weight"]
        if not w or c["score"] is None:
            continue
        contrib.append((c["id"], w, c["score"]))
        total_w += w
    if not total_w:
        return {"score": None, "raw": None, "delta": None, "confidence": None,
                "contributions": [], "weight_covered": 0.0}

    raw = sum(w * s for _i, w, s in contrib) / total_w
    prev = (previous or {}).get("composite", {})
    delta = raw - prev["raw"] if prev.get("raw") is not None else None

    # Confidence is how much of the intended weight actually resolved, blended
    # with the mean per-pillar confidence of the pillars that did.
    covered = total_w / sum(U.WEIGHTS.values())
    mean_card_conf = sum(c["confidence_value"] for c in cards if c["weight"] and c["score"] is not None)
    mean_card_conf /= max(len(contrib), 1)
    confidence = covered * 100 * 0.5 + mean_card_conf * 0.5

    return {
        "score": int(round(raw)),
        "raw": round(raw, 2),
        "delta": None if delta is None else round(delta, 2),
        "confidence": round(confidence, 1),
        "confidence_delta": (None if prev.get("confidence") is None
                             else round(confidence - prev["confidence"], 1)),
        "weight_covered": round(covered * 100, 1),
        "contributions": [{"id": i, "weight": w, "score": round(s, 2),
                           "points": round(w * s / total_w, 2)} for i, w, s in contrib],
    }


# Quadrant geometry. Two planes, each read off computed pillar scores:
#   growth / inflation   where the cycle sits
#   liquidity / funding  whether the plumbing confirms it
def build_geometry(cards):
    by = {c["id"]: c for c in cards}

    def sc(pid):
        return by.get(pid, {}).get("score")

    growth, inflation = sc("US-GRO"), sc("US-INF")
    liq = sc("US-LIQ")
    fund = sc("GL-FND")
    return {
        "cycle": {"x": growth, "y": inflation,
                  "x_label": "Growth", "y_label": "Inflation (higher = cooler)"},
        "plumbing": {"x": liq, "y": fund,
                     "x_label": "US liquidity", "y_label": "Funding conditions"},
    }


def regime_label(cards, composite):
    """The headline sentence, chosen by where the computed scores actually sit.

    The composite is a percentile-of-history measure, so the bands are stated in
    those terms: 50 is the five-year median of the liquidity pillars, not a
    judgement that any particular level is comfortable.
    """
    by = {c["id"]: c for c in cards}

    def sc(pid):
        return by.get(pid, {}).get("score")

    score = composite.get("raw")
    if score is None:
        return ("Insufficient coverage", "Too few pillars resolved to classify a regime.")

    g, i = sc("US-GRO"), sc("US-INF")
    f, m = sc("GL-FND"), sc("GL-MKT")

    if score < 35:
        band, band_word = "tight", "tightening"
    elif score < 50:
        band, band_word = "restrictive", "below its own median"
    elif score < 65:
        band, band_word = "neutral", "near its own median"
    else:
        band, band_word = "permissive", "above its own median"

    growth_ok = g is not None and g >= 50
    prices_ok = i is not None and i >= 50
    funding_ok = f is not None and f >= 50

    if band in ("tight", "restrictive"):
        if growth_ok and not prices_ok:
            title = "Inflation-constrained resilience — liquidity restrictive"
        elif growth_ok:
            title = "Resilient growth against a restrictive liquidity backdrop"
        elif not funding_ok:
            title = "Liquidity restrictive and funding conditions deteriorating"
        else:
            title = "Liquidity restrictive into softening demand"
    elif band == "neutral":
        if growth_ok and prices_ok:
            title = "Balanced expansion — liquidity near neutral"
        elif growth_ok:
            title = "Growth holding with prices firm — liquidity near neutral"
        else:
            title = "Liquidity near neutral, demand not yet responding"
    else:
        if growth_ok:
            title = "Broadening expansion — liquidity permissive"
        else:
            title = "Liquidity permissive, demand not yet responding"

    parts = [f"The liquidity composite stands at {composite['score']}/100, {band_word}"]
    if composite.get("delta") is not None:
        parts[0] += f" and {fmt._sign(composite['delta'], 2)} against the previous vintage"
    if g is not None:
        parts.append(f"US growth scores {g:.0f}")
    if i is not None:
        parts.append(f"inflation {i:.0f} (higher means cooler prices)")
    if f is not None:
        parts.append(f"funding {'remains orderly at' if funding_ok else 'has deteriorated to'} {f:.0f}")
    if m is not None:
        parts.append(f"and market pricing sits at {m:.0f}")
    copy = ", ".join(parts) + ". Every score is a percentile of that pillar's own five-year history."
    return title, copy


# ------------------------------------------------------------------- alerts
# Threshold rules over computed values. Each one names the number that fired it.

def build_alerts(cards, composite):
    by = {c["id"]: c for c in cards}
    alerts = []

    liq = by.get("US-LIQ", {})
    if liq.get("score") is not None and liq["score"] < 35:
        alerts.append(("high", "US liquidity in the bottom third of its own history",
                       f"The Treasury/Fed liquidity pillar scores {liq['score']:.1f}, a "
                       f"{liq['coverage']:.0f}%-covered reading against five years of weekly H.4.1 data."))
    if composite.get("raw") is not None and composite["raw"] < 40:
        alerts.append(("high", "Global liquidity composite below the 40 inflection",
                       f"The weighted composite is {composite['raw']:.2f}; the methodology treats "
                       "a sub-40 reading as a release-level inflection."))
    fnd = by.get("GL-FND", {})
    if fnd.get("score") is not None and fnd["score"] >= 55:
        alerts.append(("med", "Funding transmission still absent",
                       f"Funding conditions score {fnd['score']:.1f} while liquidity is draining — "
                       "the drain has not yet reached money or credit markets."))
    elif fnd.get("score") is not None:
        alerts.append(("high", "Funding conditions deteriorating",
                       f"The funding pillar scores {fnd['score']:.1f}, so the liquidity drain is "
                       "beginning to show in spreads or facility use."))
    mkt = by.get("GL-MKT", {})
    if mkt.get("score") is not None and mkt["score"] >= 60 and composite.get("raw", 100) < 45:
        alerts.append(("med", "Market pricing diverges from the liquidity signal",
                       f"Market conditions score {mkt['score']:.1f} against a liquidity composite of "
                       f"{composite['raw']:.2f}: risk pricing is not corroborating the constraint."))
    for c in cards:
        if c["gaps"]:
            alerts.append(("low", f"{c['title']} has an unresolved source",
                           f"{len(c['gaps'])} of {c['members'] + len(c['gaps'])} member series did not "
                           f"resolve ({', '.join(c['gaps'])}); the pillar is scored on the rest."))
        if c["freshness"] == "stale":
            alerts.append(("low", f"{c['title']} is past its publication cadence",
                           f"The headline observation is {c['age_days']} days old, beyond the "
                           f"{U.CADENCE_NAME.get('m', 'expected')} release interval, and is labelled stale."))
    order = {"high": 0, "med": 1, "low": 2}
    alerts.sort(key=lambda a: order[a[0]])
    return [{"level": lvl, "title": t, "body": b} for lvl, t, b in alerts]


# ------------------------------------------------------------------- ledger
# The change ledger is a genuine diff of two vintages, not a written summary.

def build_ledger(cards, previous):
    if not previous:
        return [{"input": "Baseline", "change": "First stored vintage — no prior state to diff.",
                 "pillar": "All", "consequence": "Subsequent bakes will show real changes here."}]
    prev_cards = {c["id"]: c for c in previous.get("cards", [])}
    rows = []
    for c in cards:
        prev = prev_cards.get(c["id"])
        if not prev:
            rows.append({"input": c["title"], "change": "New pillar in this build.",
                         "pillar": c["title"], "consequence": "Enters the composite from this vintage."})
            continue
        # Which member observations actually advanced to a new period.
        advanced = [k for k, p in c["periods"].items()
                    if prev.get("periods", {}).get(k) not in (None, p)]
        for key in sorted(advanced):
            r = c["readings"][key]
            was = prev.get("periods", {}).get(key)
            rows.append({
                "input": r["label"],
                "change": (f"New observation for {fmt.period(r['period'])} "
                           f"(previously {fmt.period(was)}): {fmt.value(r['level'], r['unit'])}."),
                "pillar": c["title"],
                "consequence": f"{c['title']} score {prev['score']} → {c['score']}."
                               if None not in (prev.get("score"), c.get("score")) else "Pillar rescored.",
            })
        if not advanced and c["score"] is not None and prev.get("score") is not None:
            drift = c["score"] - prev["score"]
            if abs(drift) >= 0.01:
                rows.append({
                    "input": c["title"],
                    "change": f"No new observation; score moved {fmt._sign(drift, 2)} on revision.",
                    "pillar": c["title"],
                    "consequence": "Carried forward and labelled as carry, not verified.",
                })
    return rows or [{"input": "No change", "change": "No member series advanced since the previous vintage.",
                     "pillar": "All", "consequence": "Composite unchanged; every card is a carry."}]


def build_timeline(cards):
    """The real release timeline: every member observation, newest first."""
    events = []
    for c in cards:
        for key, r in c["readings"].items():
            when = I.parse_period(r["period"], r["cadence"])
            if when is None:
                continue
            events.append({
                "date": when.isoformat(),
                "period": fmt.period(r["period"]),
                "title": r["label"],
                "pillar": c["title"],
                "value": fmt.value(r["level"], r["unit"]),
                "fresh": r["fresh"],
            })
    events.sort(key=lambda e: e["date"], reverse=True)
    return events[:18]


# ----------------------------------------------------------------- scenarios
# The original page listed confirmers and invalidators as prose. Here each one
# is a predicate over computed scores, evaluated now, so the state of a path is
# a count of conditions actually met rather than a judgement.

def build_scenarios(cards, composite):
    by = {c["id"]: c for c in cards}

    def sc(pid):
        return by.get(pid, {}).get("score")

    comp = composite.get("raw")

    def cond(text, value):
        return {"text": text, "met": value}

    paths = [
        ("Bullish disinflation", [
            cond("US inflation pillar at or above 50 (prices cooling)", None if sc("US-INF") is None else sc("US-INF") >= 50),
            cond("Liquidity composite at or above 45", None if comp is None else comp >= 45),
            cond("Funding conditions at or above 55", None if sc("GL-FND") is None else sc("GL-FND") >= 55),
            cond("US liquidity pillar improving", by.get("US-LIQ", {}).get("direction") == "improving"),
        ]),
        ("Reflation", [
            cond("US growth pillar at or above 55", None if sc("US-GRO") is None else sc("US-GRO") >= 55),
            cond("China activity pillar at or above 50", None if sc("CN-CRD") is None else sc("CN-CRD") >= 50),
            cond("Market conditions at or above 55", None if sc("GL-MKT") is None else sc("GL-MKT") >= 55),
            cond("Inflation pillar below 50 (prices firming)", None if sc("US-INF") is None else sc("US-INF") < 50),
        ]),
        ("Stagflation", [
            cond("US inflation pillar below 45", None if sc("US-INF") is None else sc("US-INF") < 45),
            cond("US growth pillar below 45", None if sc("US-GRO") is None else sc("US-GRO") < 45),
            cond("Liquidity composite below 45", None if comp is None else comp < 45),
            cond("Japan money pillar below 50", None if sc("JP-LIQ") is None else sc("JP-LIQ") < 50),
        ]),
        ("Liquidity accident", [
            cond("Liquidity composite below 40", None if comp is None else comp < 40),
            cond("Funding conditions below 45", None if sc("GL-FND") is None else sc("GL-FND") < 45),
            cond("Market conditions below 40", None if sc("GL-MKT") is None else sc("GL-MKT") < 40),
            cond("US liquidity pillar below 30", None if sc("US-LIQ") is None else sc("US-LIQ") < 30),
        ]),
    ]

    out = []
    for name, conds in paths:
        met = sum(1 for c in conds if c["met"] is True)
        total = sum(1 for c in conds if c["met"] is not None)
        if total == 0:
            state, tone = "Not evaluable", "warn"
        elif met == total:
            state, tone = f"Active — {met}/{total} conditions met", "bad" if name in ("Stagflation", "Liquidity accident") else "good"
        elif met >= total / 2:
            state, tone = f"Partial — {met}/{total} conditions met", "warn"
        elif met == 0:
            state, tone = f"Invalidated — 0/{total} conditions met", "muted"
        else:
            state, tone = f"Weak — {met}/{total} conditions met", "muted"
        out.append({"name": name, "state": state, "tone": tone, "met": met,
                    "total": total, "conditions": conds})
    return out
