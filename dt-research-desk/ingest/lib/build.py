#!/usr/bin/env python3
"""data/*.json + template/* -> index.html

Locked, validated and atomic: two sessions cannot interleave, a dataset that
fails integrity checks cannot reach the artifact, and a reader never sees a
half-written file.
"""
import json, os, sys, glob, subprocess, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import pipeline_lock, write_atomic, payload_hash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTP = os.path.join(os.path.dirname(ROOT), "index.html")
LIB  = os.path.dirname(os.path.abspath(__file__))
D = lambda n: json.load(open(os.path.join(ROOT, "data", n), encoding="utf-8"))
T = lambda n: open(os.path.join(ROOT, "template", n), encoding="utf-8").read()

OWNER = os.environ.get("DT_OWNER", "build.py")

with pipeline_lock(OWNER):
    # ---- gate: never build from a dataset that fails integrity checks ----
    v = subprocess.run([sys.executable, os.path.join(LIB, "validate.py")],
                       capture_output=True, text=True)
    sys.stdout.write(v.stdout)
    if v.returncode != 0:
        sys.stderr.write(v.stderr)
        raise SystemExit("build aborted: data validation failed")

    meta = D("meta.json")
    meta["n_pdf"]  = len(glob.glob(os.path.join(ROOT, "corpus", "pdf", "*.pdf")))
    meta["n_xlsx"] = len(glob.glob(os.path.join(ROOT, "corpus", "xlsx", "*.xlsx")))
    rank, trades = D("rankings.json"), D("trades.json")
    dates = sorted(t["date"] for t in trades)
    meta["asof"] = max(meta.get("asof", ""), dates[-1] if dates else "")

    payload = {"meta": meta, "trades": trades, "calls": D("calls.json"),
               "perf": D("perf.json"), "regime": D("regime.json"),
               "persistence": D("persistence.json"), "copy": D("copy.json"),
               "sp1500": rank["sp1500"], "thematic": rank["thematic"]}

    # hash exactly the bytes that land in the HTML, so preflight's extraction
    # of window.__DATA__ from a fetched page produces the identical digest
    blob = json.dumps(payload, separators=(",", ":"), default=str).replace("</", "<\\/")
    digest = payload_hash(blob)
    html = (T("head.html") + "\n" + T("body.html") +
            "\n<script>window.__DATA__=" + blob + ";</script>"
            "\n<script>\n" + T("app.js") + "\n</script>\n")
    write_atomic(OUTP, html)

    # provenance: who built it, from what, when — so a mystery republish is traceable
    stamp = {"built_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
             "owner": OWNER, "payload_sha256_16": digest, "bytes": len(html),
             "snapshots": len(rank["sp1500"]), "trades": len(payload["trades"]),
             "calls": len(payload["calls"]), "perf": len(payload["perf"]),
             "n_pdf": meta["n_pdf"], "n_xlsx": meta["n_xlsx"], "asof": meta["asof"]}
    write_atomic(os.path.join(ROOT, "build-manifest.json"),
                 json.dumps(stamp, indent=1) + "\n")

print("built %s  %d bytes  payload=%s" % (OUTP, len(html), digest))
print("  snapshots=%d trades=%d calls=%d perf=%d pdf=%d xlsx=%d asof=%s owner=%s"
      % (stamp["snapshots"], stamp["trades"], stamp["calls"], stamp["perf"],
         stamp["n_pdf"], stamp["n_xlsx"], stamp["asof"], OWNER))
