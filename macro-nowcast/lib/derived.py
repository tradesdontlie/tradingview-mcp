#!/usr/bin/env python3
"""Series computed from two or more published series.

Some of the most informative readings on this page are not published by anyone:
the SOFR–IORB spread is the money-market stress tell, and net liquidity — Fed
assets less the two accounts that sterilise reserves — is what actually reaches
the market. Building them here, with their own history, means they can be
percentile-scored exactly like a published series rather than shown as a lone
number with no context.

Alignment is explicit. Two daily series are joined on the dates they share; a
daily series joined to a weekly one is sampled as-of, taking the last daily
value on or before each weekly date, which is how the weekly statement is
actually assembled.
"""
from sources import Obs


def _asof_index(periods):
    """Sorted (period, position) pairs for as-of lookup."""
    return sorted((p, i) for i, p in enumerate(periods))


def _asof(index, values, period):
    """The last value at or before `period`, or None if the history starts later."""
    lo, hi, found = 0, len(index) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if index[mid][0] <= period:
            found = index[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return None if found is None else values[found]


def combine(ident, parts, fn, source="derived", base=0):
    """A new Obs over the periods of `parts[base]`, valued by `fn`.

    `parts` are Obs. Every other part is sampled as-of each period of the base
    series, so mixing frequencies is safe and the result carries the base
    series' own release calendar.
    """
    if any(p is None for p in parts):
        return None
    others = [(_asof_index(p.periods), p.values) for i, p in enumerate(parts) if i != base]
    periods, values = [], []
    for i, period in enumerate(parts[base].periods):
        row = [parts[base].values[i]]
        ok = True
        for index, vals in others:
            v = _asof(index, vals, period)
            if v is None:
                ok = False
                break
            row.append(v)
        if not ok:
            continue
        try:
            value = fn(*row)
        except (TypeError, ZeroDivisionError):
            continue
        if value is None:
            continue
        periods.append(period)
        values.append(value)
    if not values:
        return None
    newest = max(parts, key=lambda p: p.fetched_at)
    return Obs(ident, periods, values, source, newest.fetched_at,
               all(p.from_cache for p in parts))


# Each entry: pillar, spec, and the parts it is built from (by member key).
# The spec fields mean exactly what they mean in universe.py.
DERIVED = {
    "GL-FND": [{
        "key": "sofr_iorb",
        "label": "SOFR − IORB spread",
        "parts": ["sofr", "iorb"],
        "fn": lambda sofr, iorb: (sofr - iorb) * 100.0,   # basis points
        "spec": dict(cadence="d", unit="bp_raw", scale=1.0, transform="level",
                     score_on="level", polarity=-1, weight=2.0, scored=True,
                     provider="derived", ident="SOFR-IORB",
                     source="FRED SOFR and IORB, differenced",
                     url="https://fred.stlouisfed.org/series/SOFR"),
    }],
    "US-LIQ": [{
        "key": "net_liq",
        "label": "Net liquidity (assets − TGA − RRP)",
        "parts": ["walcl", "tga", "rrp"],
        # WALCL and WTREGEN are USD millions; RRPONTSYD is USD billions.
        "fn": lambda walcl, tga, rrp: walcl - tga - rrp * 1000.0,
        "spec": dict(cadence="w", unit="usd_mn", scale=1.0, transform="wow",
                     score_on="wow", polarity=1, weight=2.0, scored=True,
                     provider="derived", ident="WALCL-WTREGEN-RRP",
                     source="FRED WALCL, WTREGEN and RRPONTSYD, combined",
                     url="https://fred.stlouisfed.org/series/WALCL"),
    }],
    "GL-MKT": [{
        "key": "vix_term",
        "label": "VIX3M / VIX term structure",
        "parts": ["vix3m", "vix"],
        "fn": lambda three, one: three / one if one else None,
        # Below 1.0 the curve is inverted, which is the stress state.
        "spec": dict(cadence="d", unit="ratio", scale=1.0, transform="level",
                     score_on="level", polarity=1, weight=2.0, scored=True,
                     provider="derived", ident="VIX3M/VIX",
                     source="CBOE VIX3M and VIX, ratio",
                     url="https://www.cboe.com/tradable_products/vix/"),
    }],
}


def build(pid, member_obs):
    """Every derived Obs for one pillar, as {key: (spec, Obs)}."""
    out = {}
    for entry in DERIVED.get(pid, []):
        parts = [member_obs.get(k) for k in entry["parts"]]
        obs = combine(entry["key"], parts, entry["fn"], source="derived")
        if obs is None:
            continue
        spec = dict(entry["spec"])
        spec["key"] = entry["key"]
        spec["label"] = entry["label"]
        out[entry["key"]] = (spec, obs)
    return out
