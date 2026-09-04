#!/usr/bin/env python3
"""Integrity checks on ingest/data/ — run before every build.

Each check corresponds to a mistake this pipeline has actually made or is
one bad edit away from making. Exits non-zero on any ERROR so a broken
dataset can never reach the published artifact.
"""
import json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda n: json.load(open(os.path.join(ROOT, "data", n), encoding="utf-8"))
errors, warns = [], []
E = lambda m: errors.append(m)
W = lambda m: warns.append(m)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

state    = json.load(open(os.path.join(ROOT, "state.json"), encoding="utf-8"))
trades, calls, perf = D("trades.json"), D("calls.json"), D("perf.json")
rank, copy = D("rankings.json"), D("copy.json")
TRADE_CH = state["channels"]["dt_trade_updates"]["id"]
PUB_CH   = state["channels"]["mo_publishing"]["id"]

# --- 1. permalinks must point at the channel the record came from ----------
# A research call linking into the trade channel is a real bug that shipped once.
for t in trades:
    if t.get("url") and TRADE_CH not in t["url"]:
        E(f"trade {t['date']} {t['ticker']}: url is not a {TRADE_CH} permalink")
for c in calls:
    if c.get("url") and PUB_CH not in c["url"]:
        E(f"call {c['date']} {c['subject']}: url is not a {PUB_CH} permalink")

# --- 2. every record needs a usable citation ------------------------------
for c in calls:
    if not c.get("url") and not c.get("pdf"):
        E(f"call {c['date']} {c['subject']}: no url and no pdf — uncitable")
for t in trades:
    if not t.get("url") and not t.get("pdf"):
        E(f"trade {t['date']} {t['ticker']}: no url and no pdf — uncitable")

# --- 3. referenced PDFs must exist on disk --------------------------------
have = {os.path.basename(p) for p in glob.glob(os.path.join(ROOT, "corpus", "pdf", "*.pdf"))}
for r in trades + calls:
    if r.get("pdf") and r["pdf"] not in have:
        W(f"{r.get('ticker') or r.get('subject')} cites missing PDF {r['pdf']}")

# --- 4. dates well-formed and not from the future -------------------------
# Compare against the clock, NOT against the latest trade: a Friday brief
# routinely lands on a day with no portfolio action, and blocking that would
# stall the weekly run.
import datetime as _dt
today = _dt.date.today().isoformat()
asof = max([t["date"] for t in trades] + [c["date"] for c in calls] + [p["date"] for p in perf])
for r in trades + calls + perf:
    d = r["date"]
    if not DATE.match(d):
        E(f"malformed date {d!r}")
    elif d > today:
        E(f"date {d} is in the future (today is {today})")

# --- 5. performance series: unique, ordered, plausible --------------------
pd = [p["date"] for p in perf]
if len(set(pd)) != len(pd):
    E("perf.json has duplicate dates — a re-run appended instead of replacing")
if pd != sorted(pd):
    E("perf.json is not in date order")
for p in perf:
    for k in ("dt", "spx"):
        if not isinstance(p.get(k), (int, float)):
            E(f"perf {p['date']}: {k} missing or non-numeric")
    if p.get("cash") is not None and not 0 <= p["cash"] <= 100:
        E(f"perf {p['date']}: cash {p['cash']} outside 0-100")

# --- 6. no duplicate portfolio actions ------------------------------------
seen = {}
for t in trades:
    k = (t["date"], t["ticker"], t["action"])
    if k in seen:
        E(f"duplicate trade {k}")
    seen[k] = 1

# --- 7. a SELL must follow an open position -------------------------------
pos = {}
for t in sorted(trades, key=lambda x: x["date"]):
    tk, a = t["ticker"], t["action"]
    if a in ("BUY", "ADD"):
        pos[tk] = True
    elif a in ("SELL", "TRIM"):
        if not pos.get(tk):
            W(f"{t['date']} {a} {tk} with no prior open position in the record")
        if a == "SELL":
            pos[tk] = False

# --- 8. ranking snapshots: breadth must be a share, not a raw count -------
# The universe ran 1448-1450 rows then jumped to 1496; raw counts are not comparable.
for date, snap in sorted(rank["sp1500"].items()):
    n, u = snap["n"], snap["universe"]
    if sum(u.values()) != n:
        E(f"snapshot {date}: signal states sum to {sum(u.values())}, universe is {n}")
    if not 1000 < n < 2000:
        E(f"snapshot {date}: implausible universe size {n}")
    if len(snap["sectors"]) != 11:
        W(f"snapshot {date}: {len(snap['sectors'])} sectors, expected 11")
    ranks = sorted(int(s["Rank"]) for s in snap["sectors"])
    if ranks != list(range(1, len(ranks) + 1)):
        E(f"snapshot {date}: sector ranks are not 1..{len(ranks)}")

# --- 9. dashboard copy must be present (empty panels render blank) --------
for k in ("summary", "chartNotes", "workflow", "footer", "brandline", "bookNote", "sumRange"):
    if not copy.get(k):
        E(f"copy.json missing {k!r} — a dashboard panel would render empty")
for k in ("breadth", "perf", "themes", "cadence"):
    if not copy.get("chartNotes", {}).get(k):
        E(f"copy.json chartNotes.{k} missing")

# --- 10. watermarks must not run ahead of ingested records ----------------
for name, ch in state["channels"].items():
    if not re.match(r"^\d+\.\d+$", str(ch.get("last_ts", ""))):
        E(f"state.json {name}: last_ts {ch.get('last_ts')!r} is not a Slack ts")

print(f"validated  trades={len(trades)} calls={len(calls)} perf={len(perf)} "
      f"snapshots={len(rank['sp1500'])} asof={asof}")
for w in warns:
    print("  WARN  " + w)
for e in errors:
    print("  ERROR " + e)
if errors:
    print(f"\nFAILED — {len(errors)} error(s). Build blocked.")
    sys.exit(1)
print(f"OK — {len(warns)} warning(s), no errors.")
