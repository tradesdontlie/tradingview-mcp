#!/usr/bin/env python3
"""Live data clients. Everything here is keyless.

Yahoo  v8/finance/chart  — the only Yahoo endpoint that still answers without a
                           crumb+cookie. quoteSummary, v7/quote and the
                           predefined screeners all return "Too Many Requests"
                           unauthenticated, so nothing depends on them.
FRED   fredgraph.csv     — the CSV download behind the FRED graphs. The JSON API
                           needs a key; this does not.
"""
import csv, datetime, io, urllib.parse

from fetcher import FetchError, get, get_json

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={rng}&interval=1d"
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"


class Series:
    """A daily close series with the metadata the panels need."""

    def __init__(self, symbol, dates, closes, volumes, meta):
        self.symbol = symbol
        self.dates = dates
        self.closes = closes
        self.volumes = volumes
        self.meta = meta

    def __len__(self):
        return len(self.closes)

    @property
    def last(self):
        return self.closes[-1] if self.closes else None


def fetch_series(symbol, rng="1y", max_age=900):
    """Daily closes for one Yahoo symbol, with nulls (holidays) dropped."""
    url = YAHOO_CHART.format(sym=urllib.parse.quote(symbol, safe=""), rng=rng)
    payload, fetched_at, cached = get_json(url, max_age=max_age)
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise FetchError(f"{symbol}: {chart['error'].get('description') or chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise FetchError(f"{symbol}: empty chart result")
    r = results[0]
    stamps = r.get("timestamp") or []
    quote = (r.get("indicators", {}).get("quote") or [{}])[0]
    closes_raw = quote.get("close") or []
    vols_raw = quote.get("volume") or []

    dates, closes, volumes = [], [], []
    for i, ts in enumerate(stamps):
        c = closes_raw[i] if i < len(closes_raw) else None
        if c is None:
            continue
        dates.append(datetime.datetime.utcfromtimestamp(ts).date().isoformat())
        closes.append(float(c))
        v = vols_raw[i] if i < len(vols_raw) else None
        volumes.append(float(v) if v is not None else None)

    meta = dict(r.get("meta") or {})
    meta["fetched_at"] = fetched_at
    meta["from_cache"] = cached
    return Series(symbol, dates, closes, volumes, meta)


def fetch_fred(series_id, max_age=6 * 3600):
    """(date, value) pairs for a FRED series, missing observations dropped."""
    body, fetched_at, cached = get(FRED_CSV.format(sid=series_id), max_age=max_age)
    rows = list(csv.reader(io.StringIO(body)))
    if not rows:
        raise FetchError(f"{series_id}: empty CSV")
    out = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        date, raw = row[0].strip(), row[1].strip()
        if not raw or raw == ".":
            continue
        try:
            out.append((date, float(raw)))
        except ValueError:
            continue
    if not out:
        raise FetchError(f"{series_id}: no observations")
    return out, fetched_at, cached


# ------------------------------------------------------------------ Nasdaq
# Fallback for anything Yahoo refuses. Covers ETFs and single stocks with the
# same closes to the cent; carries no indices, futures, FX or crypto.

NASDAQ_HIST = ("https://api.nasdaq.com/api/quote/{sym}/historical"
               "?assetclass={cls}&fromdate={frm}&todate={to}&limit=9999")


def _num(raw):
    if raw is None:
        return None
    txt = str(raw).replace("$", "").replace(",", "").strip()
    if not txt or txt in ("--", "N/A"):
        return None
    try:
        return float(txt)
    except ValueError:
        return None


# Nasdaq writes class shares with a dot where Yahoo uses a hyphen.
NASDAQ_SYMBOL = {"BRK-B": "BRK.B", "BF-B": "BF.B", "BRK-A": "BRK.A"}


def fetch_nasdaq(symbol, asset_class="etf", years=2, max_age=900):
    today = datetime.date.today()
    wire = NASDAQ_SYMBOL.get(symbol, symbol)
    url = NASDAQ_HIST.format(sym=urllib.parse.quote(wire, safe=""), cls=asset_class,
                             frm=(today - datetime.timedelta(days=int(365.25 * years) + 10)).isoformat(),
                             to=today.isoformat())
    payload, fetched_at, cached = get_json(url, max_age=max_age,
                                           headers={"Accept": "application/json"})
    data = (payload or {}).get("data") or {}
    table = data.get("tradesTable") or {}
    rows = table.get("rows") or []
    if not rows:
        raise FetchError(f"{symbol}: nasdaq returned no rows")

    parsed = []
    for row in rows:  # newest first
        close = _num(row.get("close"))
        if close is None:
            continue
        try:
            month, day, year = row["date"].split("/")
        except (KeyError, ValueError):
            continue
        parsed.append((f"{year}-{month}-{day}", close, _num(row.get("volume"))))
    if not parsed:
        raise FetchError(f"{symbol}: nasdaq rows unparseable")

    parsed.reverse()  # oldest first, matching the Yahoo path
    meta = {"symbol": symbol, "shortName": symbol, "fetched_at": fetched_at,
            "from_cache": cached, "provider": "nasdaq"}
    return Series(symbol, [p[0] for p in parsed], [p[1] for p in parsed],
                  [p[2] for p in parsed], meta)


def fetch_fred_series(series_id, max_age=6 * 3600):
    """A FRED series shaped like a price Series, so panels can treat it alike."""
    obs, fetched_at, cached = fetch_fred(series_id, max_age=max_age)
    meta = {"symbol": series_id, "shortName": series_id, "fetched_at": fetched_at,
            "from_cache": cached, "provider": "fred"}
    return Series(series_id, [o[0] for o in obs], [o[1] for o in obs],
                  [None] * len(obs), meta)


# -------------------------------------------------------------------- CBOE
# The authoritative publisher of the VIX complex, on a keyless CDN, matching
# Yahoo to the cent. Primary for these series; Yahoo is the fallback.

CBOE_CSV = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{name}_History.csv"


def fetch_cboe(index_name, max_age=3600):
    """Daily closes for a CBOE index.

    Two layouts ship from this CDN: DATE,OPEN,HIGH,LOW,CLOSE for the VIX family
    and DATE,VALUE for VVIX and SKEW. The close is the last column in both.
    """
    body, fetched_at, cached = get(CBOE_CSV.format(name=index_name), max_age=max_age)
    rows = list(csv.reader(io.StringIO(body)))
    if len(rows) < 2:
        raise FetchError(f"{index_name}: empty CBOE CSV")

    dates, closes = [], []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        raw_date, raw_close = row[0].strip(), row[-1].strip()
        if not raw_date or not raw_close:
            continue
        try:
            month, day, year = raw_date.split("/")
            iso = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
        except ValueError:
            continue
        try:
            close = float(raw_close)
        except ValueError:
            continue
        if close <= 0:
            continue
        dates.append(iso)
        closes.append(close)

    if not closes:
        raise FetchError(f"{index_name}: no usable CBOE rows")
    meta = {"symbol": index_name, "shortName": index_name, "fetched_at": fetched_at,
            "from_cache": cached, "provider": "cboe"}
    return Series(index_name, dates, closes, [None] * len(closes), meta)


# --------------------------------------------------------------- CoinGecko
# Keyless daily crypto history. Yahoo covers BTC too, so this is the fallback.

COINGECKO = ("https://api.coingecko.com/api/v3/coins/{coin}/market_chart"
             "?vs_currency=usd&days=365&interval=daily")


def fetch_coingecko(coin, max_age=900):
    payload, fetched_at, cached = get_json(COINGECKO.format(coin=coin), max_age=max_age)
    points = (payload or {}).get("prices") or []
    if not points:
        raise FetchError(f"{coin}: coingecko returned no prices")
    dates, closes = [], []
    for stamp_ms, price in points:
        if price is None:
            continue
        dates.append(datetime.datetime.utcfromtimestamp(stamp_ms / 1000).date().isoformat())
        closes.append(float(price))
    if not closes:
        raise FetchError(f"{coin}: coingecko prices unusable")
    meta = {"symbol": coin, "shortName": coin.title(), "fetched_at": fetched_at,
            "from_cache": cached, "provider": "coingecko"}
    return Series(coin, dates, closes, [None] * len(closes), meta)


# Route table: each symbol in provider-preference order. Yahoo first because it
# alone covers every asset class; the rest are honest substitutes, not guesses.
ROUTES = {
    # ETFs — Nasdaq leads. Its closes matched Yahoo to the cent on every symbol
    # checked, and unlike Yahoo it does not ban a bake-sized burst: Yahoo
    # answered 429 for over twenty minutes after ~30 requests during
    # development, which would have taken the whole dashboard down with it.
    "SPY": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "QQQ": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "IWM": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "EFA": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "EEM": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "TLT": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "HYG": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "LQD": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    "GLD": [("nasdaq", {"asset_class": "etf"}), ("yahoo", {})],
    # Vol complex — CBOE publishes these itself, so it leads.
    "^VIX":   [("cboe", {"index_name": "VIX"}), ("fred", {"series_id": "VIXCLS"}), ("yahoo", {})],
    "^VIX9D": [("cboe", {"index_name": "VIX9D"}), ("yahoo", {})],
    "^VIX3M": [("cboe", {"index_name": "VIX3M"}), ("fred", {"series_id": "VXVCLS"}), ("yahoo", {})],
    "^VVIX":  [("cboe", {"index_name": "VVIX"}), ("yahoo", {})],
    "^SKEW":  [("cboe", {"index_name": "SKEW"}), ("yahoo", {})],
    # CBOE's TLT volatility index — a live, keyless stand-in for ICE's MOVE.
    "^VXTLT": [("cboe", {"index_name": "VXTLT"}), ("yahoo", {})],
    # ^MOVE is ICE's proprietary index with no keyless feed. Kept in the table
    # so it fills whenever Yahoo is reachable; ^VXTLT covers the tell when not.
    "^MOVE":  [("yahoo", {})],
    # Macro-priced assets — FRED has a true equivalent for each.
    "CL=F":     [("fred", {"series_id": "DCOILWTICO"}), ("yahoo", {})],
    "DX-Y.NYB": [("fred", {"series_id": "DTWEXBGS"}), ("yahoo", {})],
    "BTC-USD":  [("coingecko", {"coin": "bitcoin"}), ("yahoo", {})],
}

DEFAULT_ROUTE = [("nasdaq", {"asset_class": "stocks"}), ("yahoo", {})]


def fetch_routed(symbol, rng="1y", years=2, max_age=900):
    """Try each provider for `symbol` in order. Returns (Series, provider).

    Raises FetchError only when every route fails — a caller that sees that
    turns the panel into an explicit gap rather than inventing a number.
    """
    errors = []
    for provider, kw in ROUTES.get(symbol, DEFAULT_ROUTE):
        try:
            if provider == "yahoo":
                return fetch_series(symbol, rng=rng, max_age=max_age), "yahoo"
            if provider == "nasdaq":
                return fetch_nasdaq(symbol, years=years, max_age=max_age, **kw), "nasdaq"
            if provider == "fred":
                return fetch_fred_series(kw["series_id"], max_age=max_age), "fred"
            if provider == "cboe":
                return fetch_cboe(kw["index_name"], max_age=max_age), "cboe"
            if provider == "coingecko":
                return fetch_coingecko(kw["coin"], max_age=max_age), "coingecko"
        except Exception as exc:  # noqa: BLE001 - any provider failure falls through
            errors.append(f"{provider}: {exc}")
    raise FetchError(f"{symbol}: all routes failed ({'; '.join(errors)})")
