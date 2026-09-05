#!/usr/bin/env python3
"""Macro series from the statistical agencies themselves.

FRED mirrors OECD series and quietly stops when the mirror is retired — UK CPI
died there in March 2025 and Euro-area unemployment in January 2023, while both
are still published upstream. These clients go to the publisher instead.

    OECD      SDMX-JSON, keyless. Needs the sdmx-data Accept header or it
              answers with something that is not JSON.
    Eurostat  JSON-stat, keyless. The euro-area geo code changes as the bloc
              expands (EA19 -> EA20 -> EA21), so it is discovered, not assumed.
"""
from fetcher import FetchError, get_json

OECD = ("https://sdmx.oecd.org/public/rest/data/"
        "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/{key}?lastNObservations={n}")
OECD_HEADERS = {"Accept": "application/vnd.sdmx.data+json;version=1.0"}

EUROSTAT = ("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
            "{dataset}?{filters}&lastTimePeriod={n}&format=JSON")


def fetch_oecd(key, n=14, max_age=12 * 3600):
    """[(period, value)] oldest first, for one OECD SDMX series key."""
    payload, fetched_at, cached = get_json(OECD.format(key=key, n=n), max_age=max_age,
                                           headers=OECD_HEADERS, attempts=2)
    data = (payload or {}).get("data") or {}
    datasets = data.get("dataSets") or []
    if not datasets:
        raise FetchError(f"OECD {key}: no dataSets")
    series = datasets[0].get("series") or {}
    periods = (((data.get("structure") or {}).get("dimensions") or {})
               .get("observation") or [{}])[0].get("values") or []

    out = []
    for entry in series.values():
        for index, obs in (entry.get("observations") or {}).items():
            try:
                period = periods[int(index)]["id"]
            except (ValueError, IndexError, KeyError):
                continue
            if obs and obs[0] is not None:
                out.append((period, float(obs[0])))
    if not out:
        raise FetchError(f"OECD {key}: no observations")
    out.sort()
    return out, fetched_at, cached


def _euro_area_code(geo_index):
    """Pick the widest current euro-area aggregate present in a dataset."""
    candidates = sorted((c for c in geo_index if c.startswith("EA") and c[2:].isdigit()),
                        key=lambda c: int(c[2:]), reverse=True)
    if candidates:
        return candidates[0]
    return "EA" if "EA" in geo_index else None


def fetch_eurostat(dataset, filters, n=14, max_age=12 * 3600):
    """[(period, value)] for a euro-area aggregate, geo code discovered live."""
    query = "&".join(f"{k}={v}" for k, v in filters.items())
    url = EUROSTAT.format(dataset=dataset, filters=query, n=n)
    payload, fetched_at, cached = get_json(url, max_age=max_age, attempts=2)

    dimension = (payload or {}).get("dimension") or {}
    geo_index = ((dimension.get("geo") or {}).get("category") or {}).get("index") or {}
    time_index = ((dimension.get("time") or {}).get("category") or {}).get("index") or {}
    values = (payload or {}).get("value") or {}
    if not geo_index or not time_index:
        raise FetchError(f"Eurostat {dataset}: no geo/time dimensions")

    code = _euro_area_code(geo_index)
    if code is None:
        raise FetchError(f"Eurostat {dataset}: no euro-area aggregate in {list(geo_index)[:6]}")

    periods = sorted(time_index, key=lambda p: time_index[p])
    stride = len(periods)
    base = geo_index[code] * stride

    out = []
    for i, period in enumerate(periods):
        raw = values.get(str(base + i))
        if raw is not None:
            out.append((period, float(raw)))
    if not out:
        raise FetchError(f"Eurostat {dataset}: no values for {code}")
    return out, fetched_at, cached
