#!/usr/bin/env python3
"""data/*.json + template/* -> index.html  (single source of truth for the dashboard)"""
import json, os, glob
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTP = os.path.join(os.path.dirname(ROOT), "index.html")
D = lambda n: json.load(open(os.path.join(ROOT, "data", n), encoding="utf-8"))
T = lambda n: open(os.path.join(ROOT, "template", n), encoding="utf-8").read()

meta = D("meta.json")
meta["n_pdf"]  = len(glob.glob(os.path.join(ROOT, "corpus", "pdf", "*.pdf")))
meta["n_xlsx"] = len(glob.glob(os.path.join(ROOT, "corpus", "xlsx", "*.xlsx")))
rank = D("rankings.json")
trades = D("trades.json")
dates = sorted(d["date"] for d in trades)
meta["asof"] = max(meta.get("asof", ""), dates[-1] if dates else "")

payload = {"meta": meta, "trades": trades, "calls": D("calls.json"), "perf": D("perf.json"),
           "regime": D("regime.json"), "persistence": D("persistence.json"), "copy": D("copy.json"),
           "sp1500": rank["sp1500"], "thematic": rank["thematic"]}

blob = json.dumps(payload, separators=(",", ":"), default=str).replace("</", "<\\/")
html = T("head.html") + "\n" + T("body.html") + \
       "\n<script>window.__DATA__=" + blob + ";</script>\n<script>\n" + T("app.js") + "\n</script>\n"
open(OUTP, "w", encoding="utf-8").write(html)
print("built %s  %d bytes" % (OUTP, len(html)))
print("  snapshots=%d  trades=%d  calls=%d  perf=%d  pdf=%d  xlsx=%d  asof=%s" % (
    len(rank["sp1500"]), len(payload["trades"]), len(payload["calls"]),
    len(payload["perf"]), meta["n_pdf"], meta["n_xlsx"], meta["asof"]))
