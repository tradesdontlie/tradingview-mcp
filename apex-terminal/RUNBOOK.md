# APEX manual push routine

Refreshes the **APEX Institutional Macro & Liquidity Terminal** from live, keyless data
sources. Everything is one command; there is no server to keep running and no API key
to hold.

```bash
cd apex-terminal
python3 bake.py            # refresh anything older than its TTL
python3 serve.py           # http://127.0.0.1:8787
```

## What this is

Perplexity shipped a **compiled frontend only** — `vendor-dist/` is a Vite build with no
source and no backend. It fetches twelve `/api/*` endpoints that were never included.
This pipeline is that missing backend, run as a batch instead of a service: `bake.py`
writes the twelve payloads as static files and any static server hands them over.

Two things had to be fixed before it could work at all:

1. **The shipped bundle cannot reach any backend.** A Vite substitution went wrong and
   the API base URL was emitted as the literal string `"port/5000"`:

   ```js
   const qD = "port/5000".startsWith("__") ? "" : "port/5000";
   const r  = await fetch(`${qD}${queryKey.join("/")}`);   // "port/5000/api/scorecard"
   ```

   The guard exists to blank an *unsubstituted placeholder*, but the value that landed
   is not one, so every request goes to a relative path that can never resolve.
   `lib/patch_frontend.py` rewrites the constant to `""` so it fetches `/api/scorecard`
   from the serving origin. It is idempotent and `verify_build.py` fails the build if an
   unpatched bundle ever reaches `public/`.

2. **The payloads are extension-less on purpose.** The bundle fetches `/api/scorecard`,
   not `/api/scorecard.json`. `Response.json()` ignores `Content-Type`, so writing the
   files with no extension makes them work under any static server — `serve.py`,
   `python3 -m http.server`, Netlify, GitHub Pages.

## Running it

Two ways, same pipeline:

```bash
cd apex-terminal && python3 bake.py     # by hand
```

or trigger the **`apex-terminal-now`** routine, which lives with the other on-demand
terminals in `~/.claude/scheduled-tasks/`. It is registered **manual only** — no cron, no
`fireAt`, no launchd job — so it never fires on its own. It runs the same command, then
republishes the snapshot Artifact and reports the regime and stress read.

The routine's `SKILL.md` is self-contained (each run starts with no memory of the last),
so anything a run needs to know — the expected gaps, the abort conditions, the Artifact
URL, the no-push rule — is duplicated there deliberately. If a rule here changes, change
it there too.

## Layout

```
apex-terminal/
  vendor-dist/             the Perplexity build, untouched — the input
  public/                  generated — serve this, never edit by hand
    index.html assets/     patched copy of vendor-dist
    api/<endpoint>         the twelve payloads, no file extension
  report/apex-readout.html generated — the self-contained snapshot published as an Artifact
  bake.py                  the routine
  serve.py                 local static server
  lib/
    fetcher.py             throttle + disk cache + backoff + circuit breaker
    sources.py             Nasdaq / CBOE / FRED / CoinGecko / Yahoo + the route table
    macro_sources.py       OECD SDMX and Eurostat JSON-stat
    fundamentals.py        Nasdaq 13F holdings and analyst consensus
    congress.py            House Clerk filing index + PTR PDF parser
    series.py              returns, moving averages, drawdown, Sharpe, correlation
    universe.py            what is watched, and which series back each indicator
    panels.py              one builder per endpoint
    report.py              the snapshot renderer (design tokens live here)
    mirror.py              copies public/ to local disk for the browser check
    validate.py            the contract read off the compiled bundle
    verify_build.py        structural check of what was written
    patch_frontend.py      vendor-dist -> public, base URL repaired
  tests/test_contract.py   proves the contract gate actually fires
  cache/                   HTTP cache, incl. cache/ptr/ for filings (gitignored)
  build-manifest.json      provenance of the last bake
  state.json               artifact URL + last regime score, for the gauge delta
```

## Sequence

`bake.py` does all of this in one pass:

1. **Market data** — backtest symbols first at ten years, then the scorecard, vol complex
   and credit ETFs at one. One fetch per symbol, shared by every panel.
2. **Market pulse** — a quarter of history for the ranked universe.
3. **Macro** — FRED, OECD and Eurostat; index series converted to year-over-year.
4. **Smart money** — Nasdaq 13F holdings and analyst consensus per watchlist ticker, then
   the House Clerk PTR filings.
5. **Compute** — the twelve payloads.
6. **Gate** — `validate.py` checks every payload against the contract extracted from the
   bundle. A violation aborts the bake; nothing is written.
7. **Write** — atomically, then `verify_build.py` re-reads `public/` and checks the
   bundle is patched, all twelve endpoints parse, and the numbers are worth showing.
8. **Mirror** — copies `public/` to local disk and asserts the copy is byte-identical, so
   the browser check has something it can actually load (see Gotchas).
9. **Report** — renders `report/apex-readout.html`, the self-contained snapshot.
10. **Stamp** — `build-manifest.json` records sources, gaps, elapsed time and the reading.

| flag | effect |
|---|---|
| *(none)* | refetch anything older than 15 min (6 h for FRED) |
| `--force` | ignore the cache entirely |
| `--offline` | build only from what is already cached — no network at all |

## Sources

All keyless. The route table in `lib/sources.py` names them in preference order and a
symbol falls through on failure rather than going blank.

| Source | Carries | Note |
|---|---|---|
| **Nasdaq** | ETF and stock closes, 13F holdings, analyst consensus | Primary for prices. Matched Yahoo to the cent, ~10 years deep. `api.nasdaq.com` needs no key and no crumb. |
| **CBOE** | VIX, VIX9D, VIX3M, VVIX, SKEW, VXTLT | The exchange publishing its own indices. VIX history to 1990. |
| **FRED** | US/EU macro, ICE BofA credit spreads, WTI, dollar index | Also the fallback for VIX and VIX3M. |
| **OECD** | UK and Japan consumer prices | SDMX-JSON. Needs the sdmx-data `Accept` header or it does not return JSON at all. |
| **Eurostat** | Euro-area unemployment | JSON-stat. |
| **House Clerk** | Congressional trades | The yearly filing index plus the PTR PDFs themselves. |
| **CoinGecko** | BTC daily | 365 days. |
| **Yahoo** | everything, in principle | **Fallback only** — see below. |

**Yahoo is deliberately last.** It is the only source that covers every asset class, and
it was the obvious primary, but it bans a bake-sized burst: during development roughly
thirty requests earned a 429 that persisted for **over twenty minutes** on both
`query1` and `query2`. A dashboard whose every panel depends on that is a dashboard that
is down. The reliable sources now lead and Yahoo is the backstop, which is why a bake
completes in seconds with Yahoo still refusing every call.

### Congressional trades

Every commercial mirror is gone — House and Senate Stock Watcher both return 403 and
QuiverQuant wants a key — so `lib/congress.py` goes to the primary source:

```
.../public_disc/financial-pdfs/<year>FD.ZIP   tab-separated index of every filing
.../public_disc/ptr-pdfs/<year>/<DocID>.pdf   one Periodic Transaction Report
```

The index says who filed a PTR and when; the PDF holds the transactions. They are
digitally generated rather than scanned, so `pypdf` extracts the text cleanly and a
regex anchored on the ticker-in-parentheses reads out ticker, side, trade date and
amount band. Only the most recent filings are fetched and each PDF is cached under
`cache/ptr/`, so a re-bake costs nothing. Requires `pypdf`; without it the panel gaps
rather than failing the build.

### What is still missing

| Gap | Why |
|---|---|
| `^MOVE` | ICE's index has no free feed. CBOE's **VXTLT** covers the rates-vol tell instead, with its own thresholds — the radar row renames itself to whichever it used. |
| Japan inflation | The OECD prices series stops at June 2021 at the source, and FRED mirrors that dead series. No keyless replacement found, so the staleness guard blanks it rather than showing a five-year-old print. |

## Gotchas

- **FRED refuses a browser User-Agent.** A request whose UA starts with `Mozilla/5.0`
  hangs until it times out; `curl`'s default UA and a named agent both return 200. The
  fetcher therefore sends an honest `apex-terminal/1.0` everywhere and a browser UA only
  to Yahoo, which is the one host that wants one. This cost a whole bake before it was
  spotted — the symptom is every macro series gapping at once.
- **Both FRED and Yahoo throttle a burst.** The per-host gap in `fetcher.py` (1.0s for
  FRED, 1.2s for Yahoo) and the circuit breaker exist because of this. The breaker trips
  after three consecutive failures and short-circuits that host for five minutes; without
  it a rate-limited host charges every one of ~57 symbols the full retry backoff and a
  30-second bake becomes a four-minute one.
- **FRED silently retires its OECD mirrors.** UK CPI stopped there in March 2025 and
  euro-area unemployment in January 2023, while both still publish upstream — the series
  does not error, it just stops advancing. Anything sourced from an OECD mirror should be
  read from OECD or Eurostat directly, which is what `macro_sources.py` does.
- **The euro-area geo code moves.** Eurostat renames the aggregate as the bloc expands —
  EA19, then EA20, now **EA21** — and a query pinned to last year's code returns an empty
  result with no error, just `size: 0` on the geo dimension. `_euro_area_code()` discovers
  the widest current code instead of hardcoding one.
- **OECD returns non-JSON without the right Accept header.** Omit
  `application/vnd.sdmx.data+json` and the response is not parseable; the failure looks
  like a malformed payload rather than a missing header.
- **Nasdaq reports 13F market value in thousands.** Vanguard's AAPL stake comes back as
  `"$456,368,064"`, which is $456bn, not $456m. The card formats whatever it is given as
  raw dollars, so `fundamentals.py` scales by 1,000 on the way in.
- **A discontinued FRED series looks live.** The macro cards render a value with no date
  beside it, so `JPNCPIALLMINMEI` — last published June 2021 — would read as a current
  print. `panels.MACRO_MAX_AGE_DAYS` (420) blanks any observation older than that. UK and
  Japan inflation and Euro-area unemployment are currently blanked for this reason; they
  are discontinued OECD series and want live replacements.
- **The 200-day rule needs real history.** A two-year pull leaves ~300 usable days after
  warm-up, which is not a sample. Backtests fetch ten years; `verify_build.py` fails any
  result under 500 trading days.
- **Nasdaq spells class shares with a dot.** `BRK-B` on Yahoo is `BRK.B` on Nasdaq —
  see `NASDAQ_SYMBOL` in `sources.py`. A slash (`BRK/B`) returns a 400.
- **The in-app preview launcher cannot read this tree.** It lives in iCloud Drive and
  the process the preview spawns gets `Operation not permitted` on `serve.py`. Running
  `python3 serve.py` from a normal terminal works fine — the restriction is on that
  launcher, not on the files. To drive the page from a browser tool, copy `public/` to
  local disk and serve the copy. `verify_build.py` covers the same ground without a
  browser and runs automatically at the end of every bake, so a check written as "open
  it and look" can never pass vacuously here.
- **`public/` is generated.** Edit `vendor-dist/`, `lib/` or the universe — never the
  output.

## Publishing

Two artefacts come out of a bake, and they are published differently.

**The terminal** — `public/` is a self-contained static site: no build step, no
server-side code, no secrets. Any static host serves it as-is. Re-run `bake.py` and
re-upload to refresh.

**The snapshot** — `report/apex-readout.html` is published as a Claude Artifact. Its URL
lives in `state.json → artifact_url` and is carried forward across bakes, so republishing
must pass that URL or it spawns a second artifact instead of updating the first:

```
Artifact(file_path="apex-terminal/report/apex-readout.html",
         url=<state.json artifact_url>, favicon="🧭")
```

The snapshot inlines every number at render time rather than fetching `/api/*`, because
the Artifact sandbox blocks all external hosts except Google Fonts. That also makes it a
record of one bake rather than a live view drifting under its own timestamp.

## Verifying in a browser

`verify_build.py` runs automatically and is browser-independent, so the build is already
gated without one. To look at the page as a reader sees it:

```bash
python3 bake.py                                   # writes public/ and the mirror
python3 "$TMPDIR/apex-mirror/serve.py" --port 8791
```

Then open `http://127.0.0.1:8791/`. Serve the **mirror**, not `public/` directly, if you
are driving it from a tool — see the iCloud note in Gotchas. `.claude/launch.json` already
points the in-app preview at the mirror path.
