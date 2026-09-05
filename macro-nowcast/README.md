# Macro Nowcast / Regime Monitor

A nine-pillar macro and liquidity dashboard where every number is computed from a published
series. Nine signal cards, a weighted liquidity composite, computed regime geometry, live
scenario confirmers, a real change ledger and a stored vintage history — rendered as one
self-contained HTML file with no runtime API and no key.

```bash
python3 bake.py
open dist/macro-nowcast.html
```

Full operating detail, sources, scoring and failure behaviour: **[RUNBOOK.md](RUNBOOK.md)**.

## Why it exists

The dashboard this recreates was a static artefact of a research conversation — its readings,
freshness chips, deltas and thirteen "vintages" were hand-written strings frozen at the moment
it was generated. The instrument was excellent; it just could not be run again. This is that
instrument with a live pipeline underneath it.

Where the original hard-coded `freshness:'verified'`, this measures the observation date
against the publisher's release cadence. Where it listed prior vintages as prose, this diffs
against the previous stored bake. Where it asserted a composite of 39, this shows the weighted
percentile contributions that produce the number.

## Guarantees

- **Keyless.** FRED, the ECB Data Portal, OECD SDMX, Eurostat and CBOE, all on endpoints that
  need no registration.
- **Self-contained output.** No external script, stylesheet or runtime fetch — the gate fails
  the build if one appears. The page works from disk, over email, or behind a strict CSP.
- **Gaps are visible.** A source that fails is named on its card and lowers confidence. It is
  never replaced by a number that looks current and is not.
- **Nothing ships unverified.** 50 tests plus a structural gate on both the built vintage and
  the rendered page; a failure writes nothing and leaves the previous page standing.
- **Cheap to re-run.** Everything is cached and throttled per host; a re-run inside the TTL
  makes no outbound requests at all.

## Not advice

The composite is a transparent model output, not an official index, and nothing here is
investment advice.
