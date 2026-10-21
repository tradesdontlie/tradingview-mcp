#!/usr/bin/env python3
"""Refuse to publish the licensed source into a public repo.

This repo is public; the research this pipeline ingests is not — the reports carry a
DO NOT DISTRIBUTE notice. So the strings that must never be committed are themselves
confidential, and hardcoding them in this file would *be* the leak. Two kinds of rule
instead:

  * structural regexes, which name nothing (a Slack channel id has a shape);
  * literals derived at run time from the gitignored local state (state.json,
    data/copy.json), which exist only on the machine that holds the licence.

Matched against tracked files only — what git would actually push. Once pushed, a
string is public even after a later commit removes it, so this gates the push:

    python3 -I ingest/lib/audit_public.py && git push ...

Exit 0 clean, 1 on any hit, 2 if it could not run (never treat 2 as a pass).
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
INGEST = os.path.dirname(HERE)
REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=INGEST,
                      capture_output=True, text=True).stdout.strip()

# Shapes, not names. Safe to commit because they identify no one. The home-path rule
# exempts documentation placeholders (/Users/username and friends) — a real account
# called "user" would slip through, which is the right trade for a docs-heavy repo.
STRUCTURAL = [
    (r"\bC0[A-Z0-9]{9,10}\b", "Slack channel id"),
    (r"\bU0[A-Z0-9]{9,10}\b", "Slack user id"),
    (r"\b[a-z0-9][a-z0-9-]{2,}\.slack\.com\b", "Slack workspace host"),
    (r"/Users/(?!username\b|user\b|you\b|yourname\b|your-name\b|me\b|<)"
     r"[a-z][a-z0-9._-]*", "absolute home path (names the account)"),
    (r"DO NOT DISTRIBUTE", "licence notice — implies the body of the report came too"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
]

# Text files only, and never the compiled vendor bundle.
SKIP_DIRS = ("apex-terminal/vendor-dist/",)
SKIP_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".xlsx",
            ".pptx", ".woff", ".woff2", ".ttf", ".zip", ".pyc")


# Words that appear in the brandline but are ordinary vocabulary here. Matching these
# alone produced 240 hits on "point" and "report" and buried the two that mattered.
GENERIC = {
    "report", "reports", "point", "points", "turning", "market", "markets", "research",
    "trend", "trends", "macro", "weekly", "monthly", "daily", "global", "signal",
    "signals", "index", "desk", "review", "update", "updates", "capital", "trading",
    "model", "models", "composite", "assessment", "collective",
}


def derived_literals():
    """The confidential literals, read from files git never sees.

    Phrases are matched whole. A single word is only matched if it is the distinctive
    part of a phrase — long enough, and not ordinary vocabulary — so a surname is
    caught on its own while "Report" is not.
    """
    out = []
    state = os.path.join(INGEST, "state.json")
    if os.path.exists(state):
        s = json.load(open(state, encoding="utf-8"))
        for ch in (s.get("channels") or {}).values():
            for k in ("id", "author_filter"):
                if ch.get(k):
                    out.append((ch[k], "Slack %s" % k))
        if s.get("workspace_host"):
            out.append((s["workspace_host"], "workspace host"))
    # Channel *names* are deliberately not on this list: they are dict keys in
    # validate.py and a display label in app.js, and a channel name without a
    # workspace host locates nothing. The ids and the host are the identifiers.

    copy = os.path.join(INGEST, "data", "copy.json")
    if os.path.exists(copy):
        c = json.load(open(copy, encoding="utf-8"))
        # The brandline is "<publisher> · <analyst>" — both are attributions that tie
        # this public repo to a DO NOT DISTRIBUTE product.
        for phrase in re.split(r"[\u00b7,|/]", c.get("brandline", "")):
            phrase = " ".join(phrase.split())
            if len(phrase.split()) >= 2:
                out.append((phrase, "attribution"))
            for word in phrase.split():
                if len(word) >= 6 and word.lower() not in GENERIC and word[0].isupper():
                    out.append((word, "attribution (distinctive name)"))

    # Anything else this machine must not publish, one per line, gitignored.
    extra = os.path.join(INGEST, "forbidden_extra.txt")
    if os.path.exists(extra):
        for line in open(extra, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                out.append((line, "forbidden_extra.txt"))

    # Longest first so a report names the most specific rule it broke.
    seen, uniq = set(), []
    for lit, why in sorted(out, key=lambda pair: -len(pair[0])):
        if lit.lower() not in seen:
            seen.add(lit.lower())
            uniq.append((lit, why))
    return uniq


def tracked():
    r = subprocess.run(["git", "ls-files", "-z"], cwd=REPO,
                       capture_output=True, text=True)
    if r.returncode:
        print("ABORT: git ls-files failed — cannot tell what would be pushed")
        sys.exit(2)
    for p in r.stdout.split("\0"):
        if not p or p.startswith(SKIP_DIRS) or p.endswith(SKIP_EXT):
            continue
        yield p


def main():
    if not REPO:
        print("ABORT: not in a git repository")
        return 2
    lits = derived_literals()
    if not lits:
        print("ABORT: no local state to derive the confidential literals from.\n"
              "       state.json / data/copy.json are gitignored and must exist here;\n"
              "       without them this audit only checks shapes and would pass a\n"
              "       commit naming the analyst. Refusing to report a pass.")
        return 2

    me = os.path.relpath(os.path.abspath(__file__), REPO)
    hits = 0
    for rel in tracked():
        path = os.path.join(REPO, rel)
        try:
            text = open(path, encoding="utf-8", errors="strict").read()
        except (UnicodeDecodeError, OSError):
            continue
        for pat, why in STRUCTURAL:
            # This file documents the shapes it looks for.
            if rel == me:
                continue
            for m in re.finditer(pat, text):
                ln = text[:m.start()].count("\n") + 1
                print("  LEAK %s:%d  %s  [%s]" % (rel, ln, m.group(0)[:60], why))
                hits += 1
        for lit, why in lits:
            for m in re.finditer(re.escape(lit), text, re.I):
                ln = text[:m.start()].count("\n") + 1
                print("  LEAK %s:%d  %s  [%s]" % (rel, ln, m.group(0)[:60], why))
                hits += 1

    n = len(list(tracked()))
    if hits:
        print("\nFAIL: %d disclosure%s in tracked files. Do not push.\n"
              "Fix the file, amend the commit, and re-run — a string that has already\n"
              "been pushed stays public, so removing it in a later commit is not enough."
              % (hits, "" if hits == 1 else "s"))
        return 1
    print("  clean: %d tracked text files, %d structural rules, %d derived literals"
          % (n, len(STRUCTURAL), len(lits)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
