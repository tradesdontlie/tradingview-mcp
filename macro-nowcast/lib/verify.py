#!/usr/bin/env python3
"""Structural gate on the built vintage and the rendered page.

This checks the OUTPUT, not the inputs. It is what catches a card that silently
lost its numbers, a composite that drifted outside its own range, or a page that
still carries a placeholder. A bake that fails here writes nothing.
"""
import re

import universe as U

# Word-bounded on purpose: an unbounded "NaN" matches inside "financing", and
# a page that says "PBoC aggregate financing" is not a page with a broken number.
PLACEHOLDER = re.compile(
    r"(lorem ipsum|\bTODO\b|\bFIXME\b|\bXXX\b|\bundefined\b|\[object Object\]|\bNaN\b)")


def check_vintage(v):
    errors = []
    ids = [c["id"] for c in v["cards"]]
    expected = [p[0] for p in U.PILLARS]
    if ids != expected:
        errors.append(f"cards {ids} != registry {expected}")

    for c in v["cards"]:
        where = f"card {c['id']}"
        if not c["members"] and not c["gaps"]:
            errors.append(f"{where}: no members and no gaps — registry entry is empty")
        if c["score"] is not None and not 0 <= c["score"] <= 100:
            errors.append(f"{where}: score {c['score']} outside 0-100")
        if c["freshness"] not in ("verified", "carry", "stale"):
            errors.append(f"{where}: freshness {c['freshness']!r} not a known verdict")
        if c["direction"] not in ("improving", "deteriorating", "mixed"):
            errors.append(f"{where}: direction {c['direction']!r} not a known verdict")
        if c["confidence"] not in ("high", "medium", "low"):
            errors.append(f"{where}: confidence {c['confidence']!r} not a known verdict")
        if len(c["triad"]) != 3:
            errors.append(f"{where}: triad has {len(c['triad'])} entries, expected 3")
        # A card with members must show numbers. All-n/a means the presenter and
        # the registry have drifted apart, which is exactly the silent failure
        # this gate exists to catch.
        if c["members"] and all("n/a" in t for t in c["triad"]):
            errors.append(f"{where}: every triad entry is n/a despite {c['members']} members")
        if c["members"] and not c["facts"]:
            errors.append(f"{where}: no fact tiles despite {c['members']} members")
        if not c["status"] or not c["copy"]:
            errors.append(f"{where}: empty status or copy")
        for key, r in c["readings"].items():
            if r["level"] is None and r["raw"] is None:
                errors.append(f"{where}: member {key} resolved with no value")

    comp = v["composite"]
    if comp["score"] is not None and not 0 <= comp["score"] <= 100:
        errors.append(f"composite score {comp['score']} outside 0-100")
    if comp["weight_covered"] < 50:
        errors.append(f"composite covers only {comp['weight_covered']}% of intended weight")
    if not v["regime"]["title"]:
        errors.append("regime has no title")
    if not v["timeline"]:
        errors.append("timeline is empty")

    # At least half the pillars must be current, or the page is a museum piece.
    current = sum(1 for c in v["cards"] if c["freshness"] != "stale")
    if current < len(v["cards"]) / 2:
        errors.append(f"only {current}/{len(v['cards'])} pillars are current")
    return errors


def check_page(html):
    errors = []
    if "<!doctype html>" not in html[:200].lower():
        errors.append("rendered page has no doctype")
    if 'charset' not in html[:600].lower():
        errors.append("rendered page declares no charset")
    # Scan what a reader sees, not the machinery. `undefined` is ordinary
    # JavaScript and `NaN` is a real number literal; neither is a defect inside
    # a <script>. A placeholder that reaches the visible text is.
    visible = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
    visible = re.sub(r"<style\b[^>]*>.*?</style>", " ", visible, flags=re.S | re.I)
    hit = PLACEHOLDER.search(visible)
    if hit:
        errors.append(f"rendered page contains placeholder text {hit.group(0)!r}")
    # A value that failed to compute renders as the literal string, which the
    # cards use deliberately for a missing member. Too many means a broken build.
    na = visible.count("n/a")
    if na > 40:
        errors.append(f"rendered page shows {na} 'n/a' values — the presenters have drifted")
    if len(html) < 20_000:
        errors.append(f"rendered page is only {len(html)} bytes — content is missing")
    # The page must be self-contained: no runtime fetch, no external asset.
    for pattern, why in ((r"<script[^>]+src=", "external script"),
                         (r"<link[^>]+stylesheet", "external stylesheet"),
                         (r"\bfetch\s*\(", "runtime fetch call")):
        if re.search(pattern, html, re.I):
            errors.append(f"rendered page is not self-contained: {why}")
    return errors
