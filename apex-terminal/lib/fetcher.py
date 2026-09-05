#!/usr/bin/env python3
"""Polite HTTP with an on-disk cache.

Yahoo rate-limits by IP and answers a burst with 429s that persist for minutes,
so every request goes through one throttled, backing-off path and lands in a
cache keyed by URL. A re-run inside the TTL costs no requests at all, which is
what makes this safe to run by hand as often as you like.
"""
import hashlib, json, os, random, threading, time
import urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")

# Identify the client honestly by default. FRED actively refuses anything whose
# UA starts with "Mozilla/5.0" (the request hangs until it times out), and both
# Nasdaq and SEC are happy with a named agent, so spoofing a browser is both
# unnecessary and counterproductive. Yahoo is the one host that expects a
# browser UA, so it gets one — and only it.
UA = "apex-terminal/1.0 (dashboard bake; python-urllib)"

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

_HOST_UA = {
    "query1.finance.yahoo.com": BROWSER_UA,
    "query2.finance.yahoo.com": BROWSER_UA,
}

# Minimum wall-clock gap between two outbound requests to the same host.
_HOST_GAP = {"query1.finance.yahoo.com": 1.2, "query2.finance.yahoo.com": 1.2,
             "fred.stlouisfed.org": 1.0}
_DEFAULT_GAP = 0.3

_lock = threading.Lock()
_last_hit = {}

# Circuit breaker. When a host answers with 429/5xx this many times in a row we
# stop asking for the rest of the run: a rate-limited Yahoo otherwise charges
# every one of ~60 symbols the full retry backoff before the route table gets to
# try the next provider, turning a 1-minute bake into a 10-minute one.
_TRIP_AFTER = 3
_COOLDOWN = 300.0
_consecutive_fail = {}
_tripped_until = {}


class HostDown(Exception):
    """The host's breaker is open — fail immediately so the caller can reroute."""


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


class FetchError(Exception):
    """Raised when a URL could not be retrieved and no cached copy exists."""


def _cache_path(url):
    return os.path.join(CACHE, hashlib.sha256(url.encode()).hexdigest()[:32] + ".json")


def _read_cache(url, max_age):
    p = _cache_path(url)
    try:
        with open(p, encoding="utf-8") as fh:
            rec = json.load(fh)
    except (OSError, ValueError):
        return None
    if max_age is not None and time.time() - rec["fetched_at"] > max_age:
        return None
    return rec


def _write_cache(url, body):
    os.makedirs(CACHE, exist_ok=True)
    p = _cache_path(url)
    rec = {"url": url, "fetched_at": time.time(), "body": body}
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh)
    os.replace(tmp, p)


def _throttle(host):
    gap = _HOST_GAP.get(host, _DEFAULT_GAP)
    with _lock:
        wait = _last_hit.get(host, 0.0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_hit[host] = time.time()


def get(url, *, max_age=900, headers=None, attempts=4, stale_ok=True, binary=False):
    """Return the body of `url` as text.

    Serves from cache when the entry is younger than `max_age` seconds. On a
    live failure falls back to any cached copy regardless of age when
    `stale_ok` — a stale number that is labelled stale beats a blank panel.

    With `binary`, returns bytes and skips the JSON text cache; callers that
    want binary responses kept (PDFs) cache the file themselves.
    """
    if not binary:
        fresh = _read_cache(url, max_age)
        if fresh is not None:
            return fresh["body"], fresh["fetched_at"], True

    host = urllib.parse.urlsplit(url).netloc
    req_headers = {"User-Agent": _HOST_UA.get(host, UA), "Accept": "*/*"}
    if headers:
        req_headers.update(headers)

    if _breaker_open(host):
        if stale_ok and not binary:
            stale = _read_cache(url, None)
            if stale is not None:
                return stale["body"], stale["fetched_at"], True
        raise FetchError(f"{url}: {host} breaker open (recent repeated failures)")

    last_err = None
    for attempt in range(attempts):
        _throttle(host)
        try:
            req = urllib.request.Request(url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
            _record(host, True)
            if binary:
                return raw, time.time(), False
            body = raw.decode("utf-8", "replace")
            _write_cache(url, body)
            return body, time.time(), False
        except urllib.error.HTTPError as exc:
            last_err = f"HTTP {exc.code}"
            # 429/5xx are worth waiting out; a 404 never becomes a 200.
            if exc.code not in (429, 500, 502, 503, 504):
                _record(host, False)
                break
            _record(host, False)
            if _breaker_open(host):
                break
        except Exception as exc:  # noqa: BLE001 - network paths vary widely
            last_err = f"{type(exc).__name__}: {exc}"
            _record(host, False)
        if attempt < attempts - 1:
            time.sleep((2 ** attempt) * 1.5 + random.uniform(0, 0.75))

    if stale_ok and not binary:
        stale = _read_cache(url, None)
        if stale is not None:
            return stale["body"], stale["fetched_at"], True
    raise FetchError(f"{url}: {last_err}")


def get_json(url, **kw):
    body, fetched_at, cached = get(url, **kw)
    return json.loads(body), fetched_at, cached
