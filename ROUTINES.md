# Routines

Every dashboard in this repo is rebuilt by a **push routine**: one command that fetches live
data, recomputes the page, verifies what it produced, and writes only if the verification
passes. There is no service to keep running and no shared state between them.

| Routine | Command | Scheduled task | Trigger | Runbook |
|---|---|---|---|---|
| **Macro Nowcast** — 9-pillar macro & liquidity regime monitor | `cd macro-nowcast && python3 bake.py` | `macro-nowcast-now` | manual only | [RUNBOOK](macro-nowcast/RUNBOOK.md) |
| **APEX Terminal** — institutional macro & liquidity terminal | `cd apex-terminal && python3 bake.py` | `apex-terminal-now` | manual only | [RUNBOOK](apex-terminal/RUNBOOK.md) |
| **Dual Trend Desk** — weekly research ingest from Slack | `cd dt-research-desk && python3 ingest/lib/build.py` (rebuild only — the sweep and the file fetch run inside the routine) | `dt-push` | manual only | [RUNBOOK](dt-research-desk/ingest/RUNBOOK.md) |

The **scheduled task** column is the routine's id in `~/.claude/scheduled-tasks/`. All three
deliberately carry no cron expression and no launchd job — they exist so the run is one
trigger with its reporting rules attached, not so it fires on a timer. The Dual Trend Desk
ran on two timed tasks until 2026-10-21; they fired together on an app-launch catch-up and
duplicated each other's records, so they were merged into the single manual `dt-push`, whose
prompt is committed at `dt-research-desk/ingest/routine/dt-push.SKILL.md`.

## Manual push

```bash
# Macro Nowcast — 58 series, 5 publishers, ~55s cold / instant warm
cd macro-nowcast && python3 bake.py && open dist/macro-nowcast.html
```

```bash
# APEX Terminal — 12 payloads behind the compiled frontend
cd apex-terminal && python3 bake.py && python3 serve.py
```

Both are keyless and both cache on disk, so re-running inside the cache TTL costs no
outbound requests. Run them as often as you like.

## Shared conventions

These are the properties every routine here is built to have. They are worth keeping when
adding another.

- **Keyless sources only.** No API key is stored anywhere in this repo. Where a publisher's
  JSON API requires registration, the routine uses the CSV or SDMX endpoint that does not.
- **A gap is shown, never filled.** A source that fails becomes a visible, named gap that
  lowers the page's stated confidence. It is never replaced by a stale number presented as
  current.
- **The build verifies its own output.** Each routine gates on the structure of what it just
  produced — not on the inputs — and a failure writes nothing, leaving the previous good page
  in place.
- **Provenance is written down.** `build-manifest.json` records what each run fetched, from
  where, how long it took and what failed.
- **The page is self-contained.** Generated HTML carries its data inline, with no runtime API
  call, so it survives being opened from disk or published under a strict CSP.
- **Licensed input never enters the repo.** Where a routine reads subscriber-only research,
  the repo holds the pipeline and the machine holds the corpus, the figures and the
  attribution. `dt-research-desk/ingest/lib/audit_public.py` gates the push on that.

## Adding a routine

1. Put it in its own top-level directory with a `bake.py` (or `build.py`) entry point.
2. Give it a `lib/` with the fetch, compute, render and verify stages separated.
3. Write a `RUNBOOK.md` covering sources, failure behaviour and known limits.
4. Gitignore everything the routine writes — the repo holds the pipeline, the machine holds
   the state.
5. Register a scheduled task (`<name>-now`, manual only) carrying the command, the gates and
   what to report, and commit a copy of its prompt next to the pipeline. Task definitions are
   global to the machine, not per-session, so an uncommitted one can be overwritten silently
   with no way back.
6. Add a row to the table above.
