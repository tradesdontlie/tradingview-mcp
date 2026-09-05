#!/usr/bin/env python3
"""Congressional trades from the House Clerk's own disclosure system.

The commercial mirrors are gone — House/Senate Stock Watcher both 403 and
QuiverQuant wants a key — but the primary source is public and keyless:

    .../public_disc/financial-pdfs/<year>FD.ZIP   tab-separated filing index
    .../public_disc/ptr-pdfs/<year>/<DocID>.pdf   one Periodic Transaction Report

The index says who filed a PTR and when; the PDF holds the transactions. They
are digitally generated rather than scanned, so the text extracts cleanly.

Only the most recent filings are fetched, and each PDF is cached, so a re-bake
costs nothing.
"""
import csv, datetime, io, os, re, zipfile

from fetcher import FetchError, get

INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP"
PTR_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc}.pdf"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PTR_CACHE = os.path.join(ROOT, "cache", "ptr")

# A transaction row, flattened. The asset name wraps unpredictably, so the
# ticker in parentheses immediately before the asset-type code is the anchor.
ROW = re.compile(
    r"\((?P<ticker>[A-Z][A-Z0-9.\-]{0,6})\)\s*"
    r"\[(?P<atype>[A-Z]{2})\]\s*"
    r"(?P<action>P|S \(partial\)|S|E)\s+"
    r"(?P<traded>\d{2}/\d{2}/\d{4})"
    r"(?P<notified>\d{2}/\d{2}/\d{4})\s*"
    r"(?P<amount>\$[\d,]+\s*-\s*\$[\d,]+)"
)

ACTION = {"P": "Buy", "S": "Sell", "S (partial)": "Sell", "E": "Sell"}


def _iso(mmddyyyy):
    month, day, year = mmddyyyy.split("/")
    return f"{year}-{month}-{day}"


def fetch_index(year, max_age=6 * 3600):
    """Every filing the House recorded this year, newest first."""
    body, _, _ = get(INDEX_URL.format(year=year), max_age=max_age, binary=True)
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".txt")), None)
        if name is None:
            raise FetchError(f"{year}FD.ZIP contains no index text file")
        text = zf.read(name).decode("utf-8-sig", "replace")

    rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))

    def filed_on(row):
        try:
            month, day, year_ = row["FilingDate"].split("/")
            return datetime.date(int(year_), int(month), int(day))
        except (ValueError, KeyError):
            return datetime.date.min

    ptrs = [r for r in rows if (r.get("FilingType") or "").strip() == "P"]
    ptrs.sort(key=filed_on, reverse=True)
    return ptrs


def parse_ptr(pdf_bytes):
    """Transactions out of one PTR. Returns [] if the text will not extract."""
    try:
        import pypdf
    except ImportError:
        return []
    try:
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        text = "".join(page.extract_text() or "" for page in reader.pages)
    except Exception:  # noqa: BLE001 - a malformed filing is just a skip
        return []

    flat = re.sub(r"\s+", " ", text)
    out = []
    for m in ROW.finditer(flat):
        out.append({
            "ticker": m.group("ticker"),
            "type": ACTION.get(m.group("action"), "Sell"),
            "date": _iso(m.group("traded")),
            "notifiedAt": _iso(m.group("notified")),
            "amount": re.sub(r"\s*-\s*", " - ", m.group("amount")),
            "assetType": m.group("atype"),
        })
    return out


def _politician(row):
    name = " ".join(p for p in [(row.get("First") or "").strip(),
                                (row.get("Last") or "").strip()] if p)
    suffix = (row.get("Suffix") or "").strip()
    if suffix:
        name = f"{name} {suffix}"
    district = (row.get("StateDst") or "").strip()
    return f"{name} ({district})" if district else name


def recent_trades(limit=25, max_filings=40, year=None, log=print):
    """Most recent congressional stock transactions, newest first."""
    year = year or datetime.date.today().year
    try:
        index = fetch_index(year)
    except Exception as exc:  # noqa: BLE001
        log(f"  gap  house index {year}: {exc}")
        return []
    if not index:
        return []

    os.makedirs(PTR_CACHE, exist_ok=True)
    trades, scanned = [], 0
    for row in index[:max_filings]:
        doc = (row.get("DocID") or "").strip()
        if not doc.isdigit():
            continue
        path = os.path.join(PTR_CACHE, f"{year}-{doc}.pdf")
        try:
            if os.path.isfile(path):
                with open(path, "rb") as fh:
                    pdf = fh.read()
            else:
                pdf, _, _ = get(PTR_URL.format(year=year, doc=doc),
                                max_age=0, binary=True, attempts=2)
                with open(path, "wb") as fh:
                    fh.write(pdf)
        except Exception as exc:  # noqa: BLE001
            log(f"  skip PTR {doc}: {exc}")
            continue

        scanned += 1
        who = _politician(row)
        for t in parse_ptr(pdf):
            trades.append({**t, "politician": who, "filedAt": row.get("FilingDate", "")})
        if len(trades) >= limit:
            break

    trades.sort(key=lambda t: t["date"], reverse=True)
    log(f"  ok   house PTRs   {scanned} filings scanned, {len(trades)} transactions")
    return trades[:limit]
