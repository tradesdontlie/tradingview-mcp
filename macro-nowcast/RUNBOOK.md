# Macro Nowcast manual push routine

Rebuilds the **Macro Nowcast / Regime Monitor** from live, keyless data. One command,
no server to keep running, no API key to hold.

```bash
cd macro-nowcast
python3 bake.py
open dist/macro-nowcast.html
```

## What this is

A recreation of the V11 Macro Nowcast dashboard where **every number is computed from a
published series** instead of typed. The original was a beautiful static artefact of one
research conversation: its numbers, its "verified / carry / stale" chips, its Δ tags and
its vintage selector were all hand-written strings that would never change again. This
pipeline keeps the instrument and replaces the substance.

| The original asserted | This computes |
|---|---|
| `triad:['Reserves $2.948tn','−$49.3bn w/w','TGA +$56.6bn w/w']` | level, velocity and acceleration from the H.4.1 series |
| `freshness:'verified'` | observation date vs the publisher's release cadence |
| `Δ` against a named prior vintage | a diff against the previous **stored** vintage |
| a 13-entry hand-written vintage list | the contents of `vintages/` |
| a prose change ledger | a real per-series diff of two vintages |
| confirmers written as sentences | predicates over scores, evaluated at build time |
| `score:39` | a weighted percentile composite, with its contributions shown |

## Sources — all keyless

| Publisher | Carries | Why not FRED |
|---|---|---|
| **FRED** `fredgraph.csv` | every US series, BoJ assets, ECB total assets | — |
| **ECB Data Portal** | QT runoff, excess liquidity, €STR, key rates, marginal lending | FRED carries only ECB *total assets*, none of the balance-sheet detail |
| **OECD** SDMX KEI | Japan money and rates, China trade, prices, CLI, confidence | FRED's mirrors are dead: Japan M2 stopped **Feb 2017**, China CPI **Apr 2025** |
| **Eurostat** JSON-stat | euro-area HICP | the ECB's own ICP series lags further |
| **CBOE** daily CSV | VIX, VIX3M, VVIX, SKEW | CBOE publishes these itself |

The JSON APIs at FRED and OECD need keys; the CSV and SDMX endpoints used here do not.

## The nine pillars

| Card | Backed by | Weight in composite |
|---|---|---|
| `US-INF` US inflation | CPI, core CPI, PPI, core PPI, core PCE, breakevens | — |
| `US-GRO` Growth / labour | payrolls, unemployment, U-6, participation, retail, claims, IP, earnings | — |
| `US-POL` Fed / policy impulse | target range, EFFR, 2y, 10y, curve, TIPS real rate | 15% |
| `US-LIQ` Treasury / Fed liquidity | reserves, TGA, RRP, total assets, securities, **net liquidity** | 30% |
| `EU-LIQ` ECB liquidity | securities held for MPO, deposit facility, current account, MRO+LTRO, €STR, DFR, HICP | 15% |
| `JP-LIQ` BoJ / Japan money | BoJ assets, M3 y/y and m/m, call rate, JGB 10y, yen | 10% |
| `CN-CRD` PBoC / China credit & activity | exports, imports, CPI, CLI, business confidence, 3m rate | 10% |
| `GL-FND` Funding stress | primary credit, swap lines, **SOFR−IORB**, HY and IG OAS, ECB marginal lending | 20% |
| `GL-MKT` Positioning / market regime | VIX, VIX3M, **term structure**, VVIX, SKEW, dollar, oil | — |

Bold entries are **derived series** — computed from two or more published series, with their
own history, so they are percentile-scored like anything else. The unweighted pillars inform
the regime geometry and the alerts but stay out of the liquidity composite on purpose: the
composite is a liquidity measure, not a summary of the page.

## How a number becomes a score

1. Fetch the publisher's series (cached on disk, throttled per host).
2. Compute **level**, **velocity** (latest sequential change) and **acceleration**
   (change in that velocity).
3. Percentile-rank the quantity named in the registry against **its own five years**.
4. Flip the sign where a higher reading means *less* liquidity (`polarity`).
5. Average the members by weight into a pillar score; average the weighted pillars into
   the composite.

Ranking against a series' own history is what removes the hand-set threshold. There is no
judgement anywhere that says "4.1% unemployment is good" — only that it sits at a given
percentile of where it has been.

### One trap worth knowing about

Percentile-ranking the **daily change** of an administered rate is ranking a constant. Over
the year to the first build, the Fed funds target and IORB each had **260 of 260** zero daily
changes, so their "score" was an artifact of tie-counting, not a reading. Rates, spreads and
prices are therefore ranked on their **level**; only genuine flows (balance-sheet stocks, week
over week) are ranked on a change. `tests/test_nowcast.py` fails if any daily series is ever
scored on its daily change again.

## Freshness is measured, not asserted

| Chip | Means |
|---|---|
| `verified` | the newest observation is **new since the previous stored vintage** |
| `carry` | still current for its publication cadence, but unchanged since then |
| `stale` | older than one publication interval plus grace (daily 6d, weekly 13d, monthly 48d) |

FRED labels July CPI as `2026-07-01`. Read literally that ages every monthly US series by
thirty days and marks half the page stale on arrival, so a monthly series is dated to the
**end** of the month it describes. FRED also forward-dates IORB to the day a new rate takes
effect, which is current, not negative age.

## Layout

```
macro-nowcast/
  bake.py                  the routine
  dist/macro-nowcast.html  generated — the deliverable, self-contained
  vintages/*.json          one file per bake; the vintage selector reads this
  build-manifest.json      provenance of the last bake
  cache/                   HTTP cache, keyed by URL (gitignored)
  lib/
    fetcher.py             throttle + disk cache + backoff + circuit breaker
    sources.py             FRED / ECB / OECD / Eurostat / CBOE clients
    universe.py            the registry: every series, its polarity and its weight
    indicators.py          level / velocity / acceleration, percentiles, freshness
    derived.py             series computed from other series, with alignment
    pillars.py             one presenter per card
    build.py               cards, composite, geometry, alerts, ledger, timeline
    render.py              the self-contained page (design tokens live here)
    history.py             the vintage store
    verify.py              the gate
    fmt.py                 number formatting
  tests/test_nowcast.py    50 tests, each guarding a bug this pipeline has had
```

## The gate

Nothing is written unless both checks pass:

**The vintage** — nine cards in registry order, every score inside 0–100, every verdict a
known value, a triad that is not entirely `n/a`, at least half the pillars current, and at
least 50% of the intended composite weight resolved.

**The page** — a doctype, a charset, no placeholder text in the *visible* content, and
genuine self-containment: no external script, no stylesheet link, no runtime `fetch`.

A failure prints what broke and exits **without writing anything**, so a bad build can never
replace a good page.

## Failure behaviour

- **A source fails** → that member becomes a named gap on its card, the pillar is scored on
  the rest, coverage and confidence fall, and a low alert names it. It is never replaced by a
  carried-forward number pretending to be current.
- **A whole pillar fails** → it is dropped from the composite and the remaining weights are
  renormalised. Below 50% coverage the build refuses.
- **A host rate-limits** → three consecutive failures trip a five-minute breaker for that
  host, and any cached copy is served with its real age.
- **Nothing resolves** → the build aborts and the previous page stands.

## Usage

```bash
python3 bake.py              # refresh anything past its TTL (daily 15m, weekly 6h, monthly 12h)
python3 bake.py --force      # ignore the cache, refetch everything (~90s, ~58 requests)
python3 bake.py --offline    # rebuild from cache only, no network at all
python3 tests/test_nowcast.py
```

Re-running inside the TTL costs **zero** outbound requests, so the push is safe to run as
often as you like. `--offline` is the one to use when iterating on presentation.

## Reading the output

Each bake prints a line per pillar — score, move against the previous vintage, freshness,
confidence and status — then the composite. The page itself carries the full audit trail
under **Method, sources & limits**, including a row for every one of the 58 series and
whether it resolved.

## Known limits, stated on the page as well as here

- **China credit is proxied.** PBoC aggregate financing and the credit impulse have no keyless
  feed. The pillar reads trade, prices, the CLI and the interbank rate, and is named
  *credit & activity* for that reason.
- **Euro-area HICP lags** whatever Eurostat has last published; the card shows its real
  observation date rather than implying currency.
- **Percentile scores are relative.** A pillar at 50 sits at its own five-year median — a
  statement about its history, not about whether that level is comfortable.
- **Revisions are not tracked.** A publisher revising an earlier observation moves the score
  with no new observation; the ledger reports exactly that.
- **The composite is a model output, not an official index, and none of this is advice.**
