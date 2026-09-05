#!/usr/bin/env python3
"""Analyst consensus and 13F holdings from Nasdaq's public company endpoints.

Both are keyless and need no crumb, which is what makes the three "smart money"
panels live rather than gapped. Yahoo's quoteSummary would serve the same data
but requires an authenticated cookie+crumb.
"""
import re

from fetcher import get_json

TARGETS = "https://api.nasdaq.com/api/analyst/{sym}/targetprice"
HOLDINGS = ("https://api.nasdaq.com/api/company/{sym}/institutional-holdings"
            "?limit={limit}&type=TOTAL&sortColumn=marketValue&sortOrder=DESC")

JSON_HEADERS = {"Accept": "application/json"}


def _num(raw):
    """Parse Nasdaq's display strings: '$456,368,064', '1.919%', '(2.5%)'."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    txt = str(raw).strip()
    if not txt or txt in ("--", "N/A", ""):
        return None
    negative = txt.startswith("(") and txt.endswith(")")
    txt = re.sub(r"[$,()%\s]", "", txt)
    if not txt:
        return None
    try:
        value = float(txt)
    except ValueError:
        return None
    return -value if negative else value


def analyst_targets(ticker, max_age=6 * 3600):
    """{lowPriceTarget, avgPriceTarget, highPriceTarget, numAnalysts} or None."""
    payload, _, _ = get_json(TARGETS.format(sym=ticker), max_age=max_age,
                             headers=JSON_HEADERS, attempts=2)
    data = (payload or {}).get("data") or {}
    overview = data.get("consensusOverview") or {}
    low = _num(overview.get("lowPriceTarget"))
    avg = _num(overview.get("priceTarget"))
    high = _num(overview.get("highPriceTarget"))
    if low is None and avg is None and high is None:
        return None
    counts = [_num(overview.get(k)) for k in ("buy", "hold", "sell")]
    n = sum(int(c) for c in counts if c is not None) or None
    return {"ticker": ticker, "lowPriceTarget": low, "avgPriceTarget": avg,
            "highPriceTarget": high, "numAnalysts": n}


def institutional_holders(ticker, limit=10, max_age=12 * 3600):
    """Top holders by market value, largest first."""
    payload, _, _ = get_json(HOLDINGS.format(sym=ticker, limit=limit), max_age=max_age,
                             headers=JSON_HEADERS, attempts=2)
    data = (payload or {}).get("data") or {}
    rows = ((data.get("holdingsTransactions") or {}).get("table") or {}).get("rows") or []

    out = []
    for r in rows:
        shares = _num(r.get("sharesHeld"))
        value = _num(r.get("marketValue"))
        out.append({
            "institution": (r.get("ownerName") or "").strip(),
            "shares": shares,
            # Nasdaq reports market value in THOUSANDS — Vanguard's 1.43bn AAPL
            # shares come back as "$456,368,064", which is $456bn not $456m. The
            # card formats whatever it is given as raw dollars, so scale here.
            "value": None if value is None else value * 1000.0,
            "qoqChangePct": _num(r.get("sharesChangePCT")),
            "asOf": (r.get("date") or "").strip(),
        })
    return [h for h in out if h["institution"] and h["shares"] is not None]


def crowding(holders):
    """How concentrated the top holder is within the top five."""
    if not holders:
        return {"label": None, "topHolderSharePct": None}
    top5 = sum(h["shares"] for h in holders[:5])
    if not top5:
        return {"label": None, "topHolderSharePct": None}
    share = holders[0]["shares"] / top5 * 100.0
    return {"label": "Crowded" if share >= 35 else "Dispersed",
            "topHolderSharePct": round(share, 2)}
