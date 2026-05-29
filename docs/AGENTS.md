# docs/ — LLM Wiki Schema

This `docs/` directory is an **LLM-maintained wiki** for the `tradingview-mcp`
codebase. It follows the [LLM Wiki pattern](https://github.com/) — a persistent,
compounding knowledge base that an LLM agent writes and maintains, not a
one-shot RAG dump.

**Read this file first** at the start of any wiki session. It tells you how the
wiki is structured, what the conventions are, and what to do when ingesting
sources, answering questions, or maintaining the wiki.

---

## What the "raw source" is here

In the canonical LLM Wiki pattern, raw sources are articles/papers you drop into
a folder. **Here the raw source is the codebase itself** — everything under
`src/`, plus `CLAUDE.md`, `README.md`, `PLAN.md`, `RESEARCH.md`, tests, and live
behavioural facts discovered by probing the running TradingView Desktop app over
CDP.

The codebase is the source of truth. The wiki is a synthesized, interlinked
layer that sits between a reader (human or LLM) and the raw code. You read the
code; you write the wiki.

> **Immutability rule (inverted from canonical pattern):** The code is the live,
> changing source — it is NOT immutable. That means wiki pages can go stale when
> code changes. Every page records the commit/date it was synthesized from and
> cites `file:line` so drift is detectable. See [Lint](#lint).

---

## Three layers

1. **Raw source** — `src/**`, root `*.md`, `tests/**`. The LLM reads, never
   treats as wiki. Cite with `path:line`.
2. **The wiki** — `docs/wiki/**`. LLM-owned markdown. Overview, architecture,
   concept pages, module pages, tool catalog. The LLM creates and updates these.
3. **The schema** — this file (`docs/AGENTS.md`). Conventions + workflows.
   Co-evolve it as the wiki grows.

---

## Directory layout

```
docs/
├── AGENTS.md          ← this file (schema)
├── index.md           ← content catalog of every wiki page
├── log.md             ← chronological append-only log
└── wiki/
    ├── overview.md            ← synthesis entry point — read after index
    ├── architecture.md        ← the 3-tier + CDP bridge big picture
    ├── concepts/              ← cross-cutting ideas (one file per concept)
    │   ├── cdp-connection.md
    │   ├── evaluate-and-known-paths.md
    │   ├── monaco-fiber-walk.md
    │   ├── pine-graphics-path.md
    │   ├── bottom-widget-bar.md
    │   ├── chart-ready-polling.md
    │   ├── cdp-injection-safety.md
    │   └── context-management.md
    ├── modules/               ← one file per load-bearing source module
    │   ├── connection.md
    │   ├── core-pine.md
    │   ├── core-chart.md
    │   ├── core-data.md
    │   ├── core-capture.md
    │   ├── core-ui.md
    │   └── wait.md
    └── tools/
        └── catalog.md         ← all MCP tools, grouped, with one-liners
```

---

## Page conventions

Every wiki page (except `index.md` and `log.md`) starts with YAML frontmatter:

```yaml
---
title: Human-readable page title
type: concept | module | architecture | overview | tool-catalog
synthesized_from: <git short sha or "working tree">
synthesized_on: YYYY-MM-DD
sources:                       # raw-source citations this page rests on
  - src/connection.js
  - src/core/pine.js:42
related:                       # wikilinks to sibling pages
  - "[[evaluate-and-known-paths]]"
  - "[[monaco-fiber-walk]]"
---
```

Body rules:

- **Cite code with `path:line`** (e.g. `src/core/pine.js:173`). These are the
  load-bearing claims. A reader must be able to jump to the code.
- **Link related pages with `[[page-slug]]`** (Obsidian-style). Link liberally.
  A `[[slug]]` with no target yet is a TODO marker, not an error.
- **Lead with the synthesis**, not a file tour. Explain *why* the code is shaped
  this way, what the gotchas are, what surprised us. Mechanical "this function
  does X" belongs in the code; the wiki captures the non-obvious.
- **Record behavioural facts** discovered by live probing (CDP findings, TV
  internal API shapes) — these are NOT in the code and are the most valuable
  thing the wiki holds. Mark them with **`[verified live YYYY-MM-DD on TV <ver>]`**.
- Keep pages focused: 1 concept / 1 module per file. Split when a page grows
  past ~300 lines.

---

## Operations

### Ingest

Trigger: a code change lands, a new module appears, or a live-probing session
reveals new behaviour about TradingView's internals.

Flow:
1. Read the changed/new source (and `git log`/`git diff` for the why).
2. Discuss key takeaways with the human (unless batch mode).
3. Update or create the relevant module/concept page(s). A single change often
   touches 3–8 wiki pages (the module page + concept pages + overview + catalog).
4. Refresh code citations (`path:line`) against current HEAD.
5. Update `index.md` (add/relocate the page entry).
6. Append an entry to `log.md` (see format below).

### Query

Trigger: a question about the codebase / TV behaviour.

Flow:
1. Read `index.md` to locate candidate pages.
2. Read those pages; follow `[[links]]`.
3. If the wiki answers it — synthesize with `path:line` citations.
4. If the wiki is thin — read the raw code, answer, **then file the answer back**
   as a new/updated page (don't let the synthesis evaporate into chat).
5. Append a `query` entry to `log.md`.

### Lint

Trigger: periodic health check (run it after a few ingests, or on request).

Check for:
- **Citation drift** — does each `path:line` still point at what the page claims?
  Code changes silently invalidate citations. This is the #1 rot source here.
- **Stale behavioural facts** — TV ships new builds; `[verified live]` facts may
  no longer hold. Re-probe load-bearing ones.
- **Contradictions** between pages.
- **Orphan pages** (no inbound `[[links]]`) and **missing pages** (a concept
  referenced often but with no page of its own).
- **Coverage gaps** — modules in `src/` with no wiki page yet (list them in
  `index.md` under "Not yet documented").

Output a punch list; fix the cheap ones; log the pass.

---

## log.md format

Append-only. Each entry starts with a consistent, grep-able prefix:

```
## [YYYY-MM-DD] <ingest|query|lint> | <short subject>
```

So `grep "^## \[" docs/log.md | tail -5` gives the last five events. Body: a few
bullets on what changed / what was asked / what the lint found.

---

## index.md format

Content-oriented catalog. Every page listed under a category heading with a
one-line summary. Keep it current on every ingest — it's the first thing read on
a query. Categories: Overview, Architecture, Concepts, Modules, Tools, Not yet
documented.

---

## Optional tooling

- This wiki is plain markdown in a git repo — version history for free.
- At small scale `index.md` is sufficient for navigation; no embedding RAG
  needed. If it outgrows that, a local markdown search (e.g. `qmd`) can be
  shelled out to — but don't add it pre-emptively.
- Obsidian opens `docs/` directly: graph view shows hubs/orphans, `[[links]]`
  resolve, frontmatter feeds Dataview.

---

## The division of labour

- **Human**: curates what matters, directs the analysis, asks the questions,
  decides what the code *should* be.
- **LLM (you)**: all the bookkeeping — reading, summarizing, cross-referencing,
  filing, citation maintenance, contradiction-flagging. You do the grunt work
  that makes the knowledge base stay useful.
