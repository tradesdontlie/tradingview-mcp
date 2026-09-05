#!/usr/bin/env python3
"""Polite HTTP with an on-disk cache.

Same design as the APEX fetcher, with its own cache root so the two pipelines
never share entries. Every request is throttled per host, backs off on 429/5xx
and lands in a cache keyed by URL, which is what makes a manual push safe to run
as often as you like: a re-run inside the TTL costs no outbound requests at all.
"""
import hashlib, json, os, random, threading, time
import urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")

# Identify the client honestly. FRED refuses anything whose UA starts with
# "Mozilla/5.0" — the request hangs until it times out — and the ECB, OECD and
# Eurostat portals are all content with a named agent.
UA = "macro-nowcast/1.0 (dashboard bake; python-urllib)"

_HOST_GAP = {"fred.stlouisfed.org": 1.0, "sdmx.oecd.org": 1.0,
             "data-api.ecb.europa.eu": 0.6, "ec.europa.eu": 0.6}
_DEFAULT_GAP = 0.3

_lock = threading.Lock()
_last_hit = {}

# Circuit breaker: once a host has failed this many times in a row, stop asking
# for the rest of the run so one dead publisher cannot charge every series it
# backs the full retry backoff.
_TRIP_AFTER = 3
_COOLDOWN = 300.0
_consecutive_fail = {}
_tripped_until = {}


class FetchError(Exception):
    """The URL could not be retrieved and no cached copy exists."""


def _breaker_open(host):
    until = _tripped_until.get(host)
    if until is None:
        return False
    if time.time() >= until:
        _tripped_until.pop(host, None)
        _consecutive_fail[host] = 0
        return False
    return True


def _record(host, ok):
    with _lock:
        if ok:
            _consecutive_fail[host] = 0
            _tripped_until.pop(host, None)
            return
        n = _consecutive_fail.get(host, 0) + 1
        _consecutive_fail[host] = n
        if n >= _TRIP_AFTER and host not in _tripped_until:
            _tripped_until[host] = time.time() + _COOLDOWN


def _cache_path(url):
    return os.path.join(CACHE, hashlib.sha256(url.encode()).hexdigest()[:32] + ".json")


def _read_cache(url, max_age):
    try:
        with open(_cache_path(url), encoding="utf-8") as fh:
            rec = json.load(fh)
    except (OSError, ValueError):
        return None
    if max_age is not None and time.time() - rec["fetched_at"] > max_age:
        return None
    return rec


def _write_cache(url, body):
    os.makedirs(CACHE, exist_ok=True)
    p = _cache_path(url)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"url": url, "fetched_at": time.time(), "body": body}, fh)
    os.replace(tmp, p)


def _throttle(host):
    gap = _HOST_GAP.get(host, _DEFAULT_GAP)
    with _lock:
        wait = _last_hit.get(host, 0.0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_hit[host] = time.time()


def get(url, *, max_age=6 * 3600, headers=None, attempts=3, stale_ok=True):
    """Return (body, fetched_at, from_cache) for `url`.

    Serves from cache while the entry is younger than `max_age`. On a live
    failure falls back to any cached copy regardless of age when `stale_ok` —
    a stale number that the page labels stale beats a blank panel, and the
    freshness logic downstream reads the observation date, not this one.
    """
    fresh = _read_cache(url, max_age)
    if fresh is not None:
        return fresh["body"], fresh["fetched_at"], True

    host = urllib.parse.urlsplit(url).netloc
    req_headers = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        req_headers.update(headers)

    if _breaker_open(host):
        stale = _read_cache(url, None) if stale_ok else None
        if stale is not None:
            return stale["body"], stale["fetched_at"], True
        raise FetchError(f"{url}: {host} breaker open (recent repeated failures)")

    last_err = None
    for attempt in range(attempts):
        _throttle(host)
        try:
            req = urllib.request.Request(url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = resp.read().decode("utf-8", "replace")
            _record(host, True)
            _write_cache(url, body)
            return body, time.time(), False
        except urllib.error.HTTPError as exc:
            last_err = f"HTTP {exc.code}"
            _record(host, False)
            # 429/5xx are worth waiting out; a 404 never becomes a 200.
            if exc.code not in (429, 500, 502, 503, 504) or _breaker_open(host):
                break
        except Exception as exc:  # noqa: BLE001 - network paths vary widely
            last_err = f"{type(exc).__name__}: {exc}"
            _record(host, False)
        if attempt < attempts - 1:
            time.sleep((2 ** attempt) * 1.5 + random.uniform(0, 0.75))

    if stale_ok:
        stale = _read_cache(url, None)
        if stale is not None:
            return stale["body"], stale["fetched_at"], True
    raise FetchError(f"{url}: {last_err}")


def get_json(url, **kw):
    body, fetched_at, cached = get(url, **kw)
    return json.loads(body), fetched_at, cached
