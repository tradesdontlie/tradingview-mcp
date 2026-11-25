"""Strict JSON for browsers. Python happily writes Infinity/NaN, which browsers refuse to parse
(for example a profit factor with no losing trades yet). Those values become null."""
import json
import math


def clean(o):
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def safe_json(o) -> str:
    return json.dumps(clean(o), default=str, allow_nan=False)
