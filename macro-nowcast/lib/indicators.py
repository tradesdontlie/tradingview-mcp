#!/usr/bin/env python3
"""Derived readings for one observation series.

The dashboard's grammar is level / velocity / acceleration:

    level         where the stock or rate now stands
    velocity      the latest sequential change
    acceleration  the change in that velocity

Every card on the page is that triad plus a freshness verdict, and both come
from here. Nothing is rounded until it is formatted, and a quantity that the
history cannot support returns None rather than a plausible-looking zero.
"""
import datetime

CADENCE_DAYS = {"d": 6, "w": 13, "m": 48}

# Periods per year, used to annualise a sequential change and to find the
# observation one year back in an index series.
PER_YEAR = {"d": 252, "w": 52, "m": 12}


def month_end(day):
    nxt = datetime.date(day.year + (day.month == 12), (day.month % 12) + 1, 1)
    return nxt - datetime.timedelta(days=1)


def parse_period(period, cadence=None):
    """A period label from any of the five publishers, as a date.

    FRED and CBOE give ISO days, OECD and Eurostat give 2026-07, and the ECB's
    weekly balance sheet gives 2026-W35.

    A monthly series is dated to the END of the month it describes, whatever the
    publisher's label looks like. FRED writes July CPI as 2026-07-01, which is a
    label for the month, not a claim that the reading is a month older than it
    is — taking it literally ages every monthly US series by 30 days and would
    mark half the page stale the moment it is built.
    """
    period = str(period).strip()
    try:
        if "W" in period:
            year, week = period.split("-W")
            return datetime.date.fromisocalendar(int(year), int(week), 7)
        parts = period.split("-")
        if len(parts) == 1:
            return datetime.date(int(parts[0]), 12, 31)
        if len(parts) == 2:
            return month_end(datetime.date(int(parts[0]), int(parts[1]), 1))
        day = datetime.date(int(parts[0]), int(parts[1]), int(parts[2]))
        return month_end(day) if cadence == "m" else day
    except (ValueError, TypeError):
        return None


def _at(values, back):
    return values[-1 - back] if len(values) > back else None


def pct(new, old):
    if new is None or old in (None, 0):
        return None
    return (new / old - 1.0) * 100.0


def compute(obs, spec):
    """Every derived quantity for one indicator, keyed by name."""
    v = obs.values
    cadence = spec["cadence"]
    per_year = PER_YEAR[cadence]
    scale = spec.get("scale", 1.0) or 1.0

    last, prev, prev2 = _at(v, 0), _at(v, 1), _at(v, 2)
    year_ago = _at(v, per_year) if cadence != "d" else _at(v, 252)

    out = {
        "level": last / scale if last is not None else None,
        "raw": last,
        "prev": prev,
        # Absolute change, in the series' own units — the right velocity for a
        # rate or a spread, where a percent change of a percent is meaningless.
        "chg": (last - prev) / scale if None not in (last, prev) else None,
        "chg2": (prev - prev2) / scale if None not in (prev, prev2) else None,
        # Change in the native unit for balance-sheet stocks reported in
        # millions: the dashboard talks in billions.
        "wow": (last - prev) / 1000.0 if None not in (last, prev) else None,
        "wow_prev": (prev - prev2) / 1000.0 if None not in (prev, prev2) else None,
        "mom": pct(last, prev),
        "mom_prev": pct(prev, prev2),
        "yoy": pct(last, year_ago),
    }
    # Annualising the sequential rate is what makes a monthly money number
    # comparable with a policy rate; it is the dashboard's "m/m annualised".
    out["mom_ann"] = ((1 + out["mom"] / 100.0) ** per_year - 1) * 100.0 if out["mom"] is not None else None
    out["yoy_prev"] = pct(prev, _at(v, per_year + 1) if cadence != "d" else _at(v, 253))

    # Acceleration: is the velocity itself rising or falling?
    for vel, acc in (("chg", "chg2"), ("wow", "wow_prev"), ("mom", "mom_prev"), ("yoy", "yoy_prev")):
        a, b = out[vel], out[acc]
        out["accel_" + vel] = a - b if None not in (a, b) else None

    out["headline"] = out.get(spec["transform"])
    out["score_value"] = out.get(spec["score_on"])
    return out


def percentile(values, value):
    """Where `value` sits within `values`, 0-100. None when it cannot be placed."""
    clean = [x for x in values if x is not None]
    if not clean or value is None:
        return None
    return sum(1 for x in clean if x <= value) / len(clean) * 100.0


def score_history(obs, spec, window=None):
    """The score_on quantity computed at every point in the series' history.

    Percentile-ranking today's reading against this is what turns a raw number
    into a 0-100 score without hand-set thresholds. Ranked against its own past,
    not against a judgement about what 'tight' means.
    """
    v, cadence = obs.values, spec["cadence"]
    per_year = PER_YEAR[cadence]
    scale = spec.get("scale", 1.0) or 1.0
    name = spec["score_on"]
    window = window or per_year * 5
    out = []
    for i in range(len(v)):
        cur = v[i]
        prev = v[i - 1] if i >= 1 else None
        if name == "level":
            out.append(cur / scale)
        elif name == "chg":
            out.append((cur - prev) / scale if prev is not None else None)
        elif name == "wow":
            out.append((cur - prev) / 1000.0 if prev is not None else None)
        elif name == "mom":
            out.append(pct(cur, prev))
        elif name == "yoy":
            back = v[i - per_year] if i >= per_year else None
            out.append(pct(cur, back))
        else:
            out.append(None)
    return [x for x in out[-window:] if x is not None]


def freshness(obs, spec, today=None, previous_period=None):
    """verified | carry | stale, and the age in days, computed not asserted.

    verified  the newest observation is new since the previous vintage
    carry     current for its publication cadence, but unchanged since then
    stale     older than one publication interval plus a grace period
    """
    today = today or datetime.date.today()
    when = parse_period(obs.last_period, spec["cadence"])
    if when is None:
        return "stale", None, None
    # A publisher may forward-date an observation to the day a change takes
    # effect — FRED does this with IORB. That is not negative age, it is current.
    age = max(0, (today - when).days)
    limit = CADENCE_DAYS[spec["cadence"]]
    if age > limit:
        return "stale", age, when
    if previous_period is not None and str(obs.last_period) == str(previous_period):
        return "carry", age, when
    return "verified", age, when
