#!/usr/bin/env python3
"""Structural verification of the built index.html — no browser required.

The browser preview only EXECUTES scripts for files inside the session's
project folder. Outside it, it silently renders a static snapshot and
javascript_tool fails. So a verification step written as "open it and check
the console" stops verifying anything the moment the working copy moves —
without ever erroring. These checks do not depend on a browser.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(os.path.dirname(ROOT), "index.html")
errors = []
E = errors.append

html = open(OUT, encoding="utf-8").read()
app  = open(os.path.join(ROOT, "template", "app.js"), encoding="utf-8").read()
body = open(os.path.join(ROOT, "template", "body.html"), encoding="utf-8").read()

# --- 1. data blob must round-trip -----------------------------------------
i = html.find("window.__DATA__=")
if i < 0:
    E("no window.__DATA__ in the output")
    payload = {}
else:
    raw = html[i + len("window.__DATA__="): html.index(";</script>", i)]
    try:
        payload = json.loads(raw.replace("<\\/", "</"))
    except Exception as e:
        E(f"data blob does not parse: {e}")
        payload = {}

# --- 2. every id the script writes to must exist in the markup ------------
# A renamed or dropped mount point renders a blank panel and throws nothing.
mounts = set(re.findall(r"""\$\(['"]#([A-Za-z][\w-]*)['"]\)""", app))
mounts |= set(re.findall(r"""getElementById\(['"]([\w-]+)['"]\)""", app))
declared = set(re.findall(r'''id=["']([\w-]+)["']''', body))
for m in sorted(mounts - declared):
    E(f"script targets #{m} but no such id exists in body.html")

# --- 3. no unrendered template literals in the output ---------------------
for m in re.finditer(r"\$\{[^}\n]{1,60}\}", html[html.rindex("</script>") - len(html):] or ""):
    pass
tail = html[html.find("<header"): html.find("<script>window.__DATA__")]
for m in re.finditer(r"\$\{[^}\n]{1,60}\}", tail):
    E(f"unrendered template literal in markup: {m.group(0)}")

# --- 4. only Google Fonts may be fetched from outside ---------------------
# The workspace host is read from state.json rather than hardcoded, so this
# file carries no deployment-specific identifiers.
_state = json.load(open(os.path.join(ROOT, "state.json"), encoding="utf-8"))
_allowed = {"fonts.googleapis.com", "fonts.gstatic.com", "www.w3.org", "claude.ai"}
for _u in (_state.get("artifact_url"), _state.get("workspace_host")):
    if _u:
        _allowed.add(re.sub(r"^https?://", "", _u).split("/")[0])
for _r in json.loads(html[html.find("window.__DATA__=") + 16:
                          html.index(";</script>", html.find("window.__DATA__="))]
                     .replace("<\\/", "</")).get("trades", [])[:1]:
    pass
for host in set(re.findall(r"https?://([A-Za-z0-9.-]+)", html)):
    if host not in _allowed:
        E(f"external host referenced: {host}")

# --- 5. payload internally consistent -------------------------------------
if payload:
    sp = payload.get("sp1500", {})
    for d, s in sp.items():
        if sum(s["universe"].values()) != s["n"]:
            E(f"snapshot {d}: signal census does not sum to the row count")
        bb = 100 * s["universe"]["BB"] / s["n"]
        if not 0 <= bb <= 100:
            E(f"snapshot {d}: breadth {bb} outside 0-100")
    for k in ("trades", "calls", "perf", "regime", "persistence", "copy", "meta"):
        if k not in payload:
            E(f"payload missing {k!r}")
    if payload.get("meta", {}).get("n_pdf", 0) < 1:
        E("meta.n_pdf is zero — corpus not found at build time")

# --- 6. the local file must declare its own charset -----------------------
# The artifact wrapper supplies one, but index.html is also opened directly
# via file://, where nothing else declares it and the non-ASCII punctuation
# in the copy renders as mojibake.
if not re.search(r'<meta\s+charset', html[:600], re.I):
    E("no <meta charset> in the first 600 bytes — non-ASCII text will mangle "
      "when the file is opened directly rather than through the artifact wrapper")

# --- 7. no hardcoded dates in the markup ----------------------------------
# A baked-in filter end-date silently hides every record added after the build
# that introduced it — the table looks fine and is simply short.
_body = open(os.path.join(ROOT, "template", "body.html"), encoding="utf-8").read()
for m in re.finditer(r'value=["\'](\d{4}-\d{2}-\d{2})["\']', _body):
    E(f"hardcoded date {m.group(1)} in body.html — derive it from the data instead")

# --- 8. both themes must define their tokens ------------------------------
for probe in (":root{", "prefers-color-scheme:dark", 'data-theme="dark"'):
    if probe not in html:
        E(f"theme block missing: {probe}")

print(f"structural check: {len(mounts)} mount points, "
      f"{len(payload.get('trades', []))} trades, {len(payload.get('sp1500', {}))} snapshots, "
      f"{len(html)} bytes")
for e in errors:
    print("  ERROR " + e)
if errors:
    print(f"\nFAILED — {len(errors)} structural error(s).")
    sys.exit(1)
print("OK — output is structurally sound without opening a browser.")
