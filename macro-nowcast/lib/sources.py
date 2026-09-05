#!/usr/bin/env python3
"""Live clients for the five publishers this dashboard reads. All keyless.

FRED      fredgraph.csv     The CSV behind the FRED graphs. The JSON API needs a
                            key; this does not. Primary for every US series.
ECB       data-api          The ECB Data Portal SDMX endpoint, csvdata format.
                            Primary for the euro area, because FRED carries only
                            total assets and none of the balance-sheet detail.
OECD      SDMX-JSON KEI     Key Economic Indicators. Needs the sdmx-data Accept
                            header or it answers with something that is not JSON.
Eurostat  JSON-stat         Euro-area aggregates. The geo code moves as the bloc
                            expands (EA19 -> EA20 -> EA21) so it is discovered.
CBOE      daily_prices CSV  The publisher of the VIX complex itself.

FRED mirrors OECD series and quietly stops when a mirror is retired: Japan M2
(MYAGM2JPM189S) died there in 2017 and China CPI (CHNCPIALLMINMEI) in 2025, while
both are still published upstream. That is why Japan and China come from OECD
directly rather than from FRED.
"""
import csv, io, json

from fetcher import FetchError, get, get_json

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
ECB_CSV = ("https://data-api.ecb.europa.eu/service/data/{key}"
           "?format=csvdata&lastNObservations={n}")
OECD_KEI = ("https://sdmx.oecd.org/public/rest/data/"
            "OECD.SDD.STES,DSD_KEI@DF_KEI,4.0/{key}?lastNObservations={n}")
OECD_HEADERS = {"Accept": "application/vnd.sdmx.data+json;version=1.0"}
EUROSTAT = ("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
            "{dataset}?{filters}&lastTimePeriod={n}&format=JSON")
CBOE_CSV = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{name}_History.csv"


class Obs:
    """One observation series: periods and values, oldest first."""

    def __init__(self, ident, periods, values, source, fetched_at, from_cache):
        self.ident = ident
        self.periods = periods
        self.values = values
        self.source = source
        self.fetched_at = fetched_at
        self.from_cache = from_cache

    def __len__(self):
        return len(self.values)

    @property
    def last(self):
        return self.values[-1] if self.values else None

    @property
    def last_period(self):
        return self.periods[-1] if self.periods else None


def _obs(ident, pairs, source, fetched_at, cached):
    pairs = [p for p in pairs if p[1] is not None]
    if not pairs:
        raise FetchError(f"{ident}: no usable observations")
    pairs.sort(key=lambda p: p[0])
    return Obs(ident, [p[0] for p in pairs], [float(p[1]) for p in pairs],
               source, fetched_at, cached)


# ---------------------------------------------------------------------- FRED

def fetch_fred(series_id, max_age=6 * 3600):
    body, fetched_at, cached = get(FRED_CSV.format(sid=series_id), max_age=max_age)
    rows = list(csv.reader(io.StringIO(body)))
    if not rows:
        raise FetchError(f"{series_id}: empty CSV")
    pairs = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        date, raw = row[0].strip(), row[1].strip()
        if not raw or raw == ".":
            continue
        try:
            pairs.append((date, float(raw)))
        except ValueError:
            continue
    return _obs(series_id, pairs, "fred", fetched_at, cached)


# ----------------------------------------------------------------------- ECB

def fetch_ecb(key, n=160, max_age=6 * 3600):
    """One ECB Data Portal series. `key` is 'DATASET/SERIES.KEY.DOTTED'."""
    body, fetched_at, cached = get(ECB_CSV.format(key=key, n=n), max_age=max_age)
    rows = list(csv.DictReader(io.StringIO(body)))
    if not rows:
        raise FetchError(f"ECB {key}: empty response")
    pairs = []
    for row in rows:
        period, raw = (row.get("TIME_PERIOD") or "").strip(), (row.get("OBS_VALUE") or "").strip()
        if not period or not raw:
            continue
        try:
            pairs.append((period, float(raw)))
        except ValueError:
            continue
    return _obs(key, pairs, "ecb", fetched_at, cached)


# ---------------------------------------------------------------------- OECD

def fetch_oecd_kei(key, n=160, max_age=12 * 3600):
    """One OECD Key Economic Indicators series, by full dotted SDMX key."""
    payload, fetched_at, cached = get_json(OECD_KEI.format(key=key, n=n),
                                           max_age=max_age, headers=OECD_HEADERS)
    data = (payload or {}).get("data") or {}
    datasets = data.get("dataSets") or []
    if not datasets:
        raise FetchError(f"OECD {key}: no dataSets")
    periods = (((data.get("structure") or {}).get("dimensions") or {})
               .get("observation") or [{}])[0].get("values") or []
    pairs = []
    for entry in (datasets[0].get("series") or {}).values():
        for index, obs in (entry.get("observations") or {}).items():
            try:
                period = periods[int(index)]["id"]
            except (ValueError, IndexError, KeyError):
                continue
            if obs and obs[0] is not None:
                pairs.append((period, float(obs[0])))
    return _obs(key, pairs, "oecd", fetched_at, cached)


# ------------------------------------------------------------------ Eurostat

def _euro_area_code(geo_index):
    """The widest current euro-area aggregate present in a dataset."""
    wide = sorted((c for c in geo_index if c.startswith("EA") and c[2:].isdigit()),
                  key=lambda c: int(c[2:]), reverse=True)
    if wide:
        return wide[0]
    return "EA" if "EA" in geo_index else None


def fetch_eurostat(dataset, filters, n=36, max_age=12 * 3600):
    """A euro-area aggregate from Eurostat, geo code discovered rather than assumed."""
    query = "&".join(f"{k}={v}" for k, v in filters.items())
    payload, fetched_at, cached = get_json(
        EUROSTAT.format(dataset=dataset, filters=query, n=n), max_age=max_age)

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
    base = geo_index[code] * len(periods)
    pairs = [(p, values.get(str(base + i))) for i, p in enumerate(periods)]
    return _obs(f"{dataset}[{code}]", pairs, "eurostat", fetched_at, cached)


# ---------------------------------------------------------------------- CBOE

def fetch_cboe(index_name, max_age=3600):
    """Daily closes for a CBOE index.

    Two layouts ship from this CDN: DATE,OPEN,HIGH,LOW,CLOSE for the VIX family
    and DATE,VALUE for VVIX and SKEW. The close is the last column in both.
    """
    body, fetched_at, cached = get(CBOE_CSV.format(name=index_name), max_age=max_age)
    rows = list(csv.reader(io.StringIO(body)))
    if len(rows) < 2:
        raise FetchError(f"{index_name}: empty CBOE CSV")
    pairs = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        raw_date, raw_close = row[0].strip(), row[-1].strip()
        if not raw_date or not raw_close:
            continue
        try:
            month, day, year = raw_date.split("/")
            close = float(raw_close)
        except ValueError:
            continue
        if close <= 0:
            continue
        pairs.append((f"{int(year):04d}-{int(month):02d}-{int(day):02d}", close))
    return _obs(index_name, pairs, "cboe", fetched_at, cached)


FETCHERS = {
    "fred": lambda ident, **kw: fetch_fred(ident, **kw),
    "ecb": lambda ident, **kw: fetch_ecb(ident, **kw),
    "oecd": lambda ident, **kw: fetch_oecd_kei(ident, **kw),
    "cboe": lambda ident, **kw: fetch_cboe(ident, **kw),
    "eurostat": lambda ident, **kw: fetch_eurostat(ident[0], ident[1], **kw),
}


def fetch(provider, ident, max_age=None):
    fn = FETCHERS.get(provider)
    if fn is None:
        raise ValueError(f"unknown provider {provider!r}")
    return fn(ident) if max_age is None else fn(ident, max_age=max_age)
