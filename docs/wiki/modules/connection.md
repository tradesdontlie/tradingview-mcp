---
title: src/connection.js — the CDP bridge
type: module
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/connection.js
related:
  - "[[cdp-connection]]"
  - "[[evaluate-and-known-paths]]"
  - "[[cdp-injection-safety]]"
  - "[[architecture]]"
---

# Module: src/connection.js

The single CDP chokepoint. ~200 lines. Everything that touches TradingView goes
through here. Conceptually split across three concept pages; this page is the
file-level map.

## Exports

| Export | Purpose |
|--------|---------|
| `evaluate(expr, opts)` | run JS in TV, return value (`:136`). The workhorse. |
| `evaluateAsync(expr)` | `evaluate` with `awaitPromise: true` (`:158`). |
| `getClient()` | memoized CDP client w/ liveness probe (`:52`). |
| `connect()` | retrying attach to chart target (`:66`). |
| `getTargetInfo()` | the attached target descriptor (`:101`). |
| `disconnect()` | tear down the client (`:162`). |
| `getChartApi()` / `getChartCollection()` | verified `KNOWN_PATHS` accessors (`:182`/`:186`). |
| `safeString(str)` | injection-safe string literal (`:38`). |
| `requireFinite(v, name)` | numeric guard (`:46`). |
| `KNOWN_PATHS` | map of TV internal entry points (`:13`, re-exported `:31`). |

## Internal state (module-scoped singletons)

- `client`, `targetInfo` — the memoized CDP connection.
- `lastPopupCheck`, `POPUP_CHECK_INTERVAL=3000` — throttle for popup sweep.
- Constants: `CDP_HOST/PORT=localhost:9222`, `MAX_RETRIES=5`, `BASE_DELAY=500`.

## Behaviour highlights

- **Self-healing singleton** — `getClient()` probes with `evaluate('1')`; on
  failure nulls and reconnects. See [[cdp-connection]].
- **Popup auto-dismiss** — `dismissBlockingPopups()` (`:108`) runs before each
  eval (throttled). Broad selectors; can sweep legitimate dialogs — see hazard
  note in [[cdp-connection]].
- **Injection guards** — `safeString`/`requireFinite`, see
  [[cdp-injection-safety]].
- **returnByValue / ASI gotchas** — see [[evaluate-and-known-paths]].

## Change-risk

This is the highest-blast-radius file in the repo. A regression in `evaluate()`
or `findChartTarget()` breaks every tool. The popup-dismiss selectors and
`KNOWN_PATHS` are the parts most likely to need updates when TV ships a new build.
