---
name: dt-push
description: Manual only: sweep both Slack channels, fetch new PDFs/workbooks via the Slack app, rebuild, preflight and republish the Dual Trend Desk
---

Refresh the **Dual Trend Desk** dashboard. This is a manual, on-demand push — it replaces the old
`dt-weekly-ingest` (Monday) and `dt-friday-brief` (Friday) tasks, which were merged into this one
routine on 2026-10-21 after they fired simultaneously on an app-launch catch-up and duplicated each
other's records.

Working directory:
`<repo>/dt-research-desk`, where `<repo>` is your local checkout

**First: read `ingest/RUNBOOK.md` in full and follow it.** It is the authority on schemas, file naming,
gotchas and known limits. This prompt is the dispatch summary only.

One routine now covers both legs: the Monday S&P 1500 ranking report plus its workbook, and the Friday
Weekly Brief with its performance pair, cash level and call outcomes. There is one watermark pair in
`ingest/state.json → channels`; the sweep is incremental, so it picks up whatever is new since the last
run regardless of which day you run it.

Run:

1. Load `ingest/state.json` for watermarks and the artifact URL. Check `ingest/build-manifest.json` and
   `last_published` — if a build newer than your own read already covers this window, stop and say so
   rather than rebuilding.
2. Read both channels since their `last_ts` (ids and author filter are in `state.json → channels`).
   If nothing new by the analyst, set `last_run`, advance watermarks past any skipped third-party posts,
   report "no change", and stop. A quiet run is a valid result.
3. **Fetch the files.** `state.json → pending_download` carries anything an earlier run could not
   get; it is a failure log, not a work queue. Retrieval goes through the Slack desktop app with
   computer-use, and in a hand-started run **this works without any approval prompt** — the grant is
   stored on the task and reused. An earlier version of this routine read the unattended-run limit in
   `RUNBOOK.md` as applying here too and skipped the attempt; that left 29 files unread for six weeks.
   Attempt it every time. (That limit is real but narrower: a run fired by a *timer* cannot raise the
   approval card at all, which is why this routine is manual and must stay manual.)
   - `request_access(apps=["Slack"])` returns the stored grant. If `app_list_windows` comes back empty,
     Slack is running headless: `open -a Slack`, wait ~6s, list again.
   - Files tab → collapse Templates → search box at `(900, 108)` (`app_type` with
     `overwrite_existing: true`, then Return) → row 1 download icon at `(1274, 214)`; rows below are
     `+132px` each. Coordinates are the 1400x851 frame; `RUNBOOK.md` step 3 has the full table.
   - **Check row 1 is the file you want from a screenshot before clicking.** Date tokens
     (`Positioning 20261009`, `SP1500_DT_Assessment_2026-09-11`) return exactly one row; title
     fragments may rank something else first.
   - Taking several files from one result list: click **bottom-up**. The download toast grows from the
     bottom right and will cover the icons of rows you have not clicked yet.
   - Files land in `~/Downloads` under their Slack filename. Copy each to the `dest` in
     `pending_download` and remove it from that list. Match on the `slack` field, normalising case and
     punctuation — curly apostrophes and double spaces appear in real titles. PDFs are named by **post
     date**, workbooks by the **data date in the filename** (`SP1500_<YYYY-MM-DD>.xlsx`), decks to
     `corpus/pptx/`.
   - Only if a fetch genuinely fails does it stay in `pending_download`. Say which layers did not
     refresh as a result.

4. Append new records per the runbook schemas. **Use the append tool — never hand-edit the JSON:**
   `python3 ingest/lib/append.py <records.json> --owner dt-push`
   It takes the pipeline lock, re-reads inside it, and skips records already present, so re-running the
   same window is a no-op instead of a collision. Pass `--dry-run` first to see what would change.
   Schemas: `trades`, `calls`, `perf` (Weekly Brief only — the only source for the performance pair),
   `regime`, `cash` (cash levels stated in Slack between briefs), `framework` (decision rules the
   analyst states outright), `persistence` (upserts — re-mark earlier calls Held / Faded / Reversed /
   Confirmed). Use the actual message and PDF text; do not invent figures you have not read.
5. Rebuild:
   `DT_OWNER=dt-push python3 ingest/lib/parse_xlsx.py && python3 ingest/lib/extract_pdf.py && DT_OWNER=dt-push python3 ingest/lib/build.py`
   `build.py` takes the lock, runs `validate.py` and aborts on any integrity error, writes atomically,
   runs `verify_build.py`, and stamps `build-manifest.json`. If validation fails, fix the data — never
   bypass it. Universe row counts drift week to week, so breadth is always a percentage of that
   snapshot's own row count.
6. Verify: open `index.html` in the browser preview, confirm no console errors, the charts tab renders
   its 5 SVGs, and the KPIs and record counts moved as expected.
7. **Preflight before publishing.** Read the artifact with the Artifact tool (`action: "read"` on
   `state.json → artifact_url`) — it saves the live page to a local file whose name carries the artifact
   version. Then:
   `python3 -I ingest/lib/preflight.py <that-file>`
   - **exit 0 (PUBLISH)** — publish with `url` set to the artifact URL, then
     `python3 ingest/lib/record_publish.py <the-version-you-read>`.
   - **exit 3 (SKIP)** — live already matches local. Do not publish. Say so.
   - **exit 2 (CONFLICT)** — someone published in between. **Do not publish.** Report the conflict, name
     both payload hashes, and stop.
   Never publish without `url` — that creates a second artifact.
8. Write back `state.json`: both `last_ts`, `last_run`, processed inventories, `pending_download`.

Report briefly: new portfolio actions and research calls; any sector that moved 3+ rank places and the
current dual-bullish breadth versus the prior week; which calls changed status; the current cash level
and where it came from; validation warnings that look new; the preflight outcome; what is still in
`pending_download`; and any layer that did not refresh. Accuracy over completeness — if a figure is not
in the source, leave it out and say it was unavailable.