#!/usr/bin/env python3
"""corpus/pdf/*.pdf -> txt/*.txt  (idempotent; skips already-extracted files)"""
import os, re, sys
from pypdf import PdfReader
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = os.path.join(ROOT, "corpus", "pdf"), os.path.join(ROOT, "txt")
os.makedirs(OUT, exist_ok=True)
new = 0
for f in sorted(os.listdir(SRC)):
    if not f.lower().endswith(".pdf"):
        continue
    dst = os.path.join(OUT, f[:-4] + ".txt")
    if os.path.exists(dst) and os.path.getmtime(dst) > os.path.getmtime(os.path.join(SRC, f)):
        continue
    parts = []
    for i, pg in enumerate(PdfReader(os.path.join(SRC, f)).pages):
        t = pg.extract_text() or ""
        t = re.sub(r"\n(?=[a-z,\.\)])", " ", t)
        t = re.sub(r"[ \t]+", " ", t)
        parts.append("\n--- p%d ---\n%s" % (i + 1, t.strip()))
    open(dst, "w", encoding="utf-8").write("".join(parts))
    print("extracted", f)
    new += 1
print("%d new, %d total" % (new, len(os.listdir(OUT))))
