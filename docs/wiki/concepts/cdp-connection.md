---
title: CDP connection — the singleton bridge
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/connection.js:52
  - src/connection.js:66
  - src/connection.js:92
related:
  - "[[evaluate-and-known-paths]]"
  - "[[architecture]]"
  - "[[bottom-widget-bar]]"
---

# CDP connection

All communication with TradingView goes through one CDP client, memoized in
module scope in `src/connection.js`.

## Attach flow

`getClient()` (`src/connection.js:52`) returns the cached client after a liveness
probe (`Runtime.evaluate('1')`); on failure it nulls the cache and reconnects.
`connect()` (`src/connection.js:66`) retries up to `MAX_RETRIES=5` with
exponential backoff, calls `findChartTarget()`, attaches via
`chrome-remote-interface`, and enables the `Runtime`, `Page`, and `DOM` domains.

`findChartTarget()` (`src/connection.js:92`) hits `http://localhost:9222/json/list`
and prefers a `page` target whose URL matches `tradingview.com/chart`, falling
back to any `tradingview` page. TV Desktop opens **many** CDP targets (chart,
tooltip, new-tab, renderer-service, etc.) — only the chart page is useful.
**[verified live 2026-05-27]** a fresh TV Desktop 3.1.0 launch exposed 8 page
targets; picking the chart one is essential.

## Why a singleton

CDP attach is expensive and the chart page is stateful. One memoized client per
process avoids re-attaching on every tool call. The liveness probe makes the
singleton self-healing across TV restarts.

## Host / port

Hard-coded `localhost:9222` (`src/connection.js:7-8`). TV must be launched with
`--remote-debugging-port=9222` — `tv_launch` / `core/health.js` automate that.

## Popup auto-dismiss (a double-edged sweep)

Before each `evaluate()`, throttled to once per 3s (`POPUP_CHECK_INTERVAL`,
`src/connection.js:5-6`), `dismissBlockingPopups()` (`src/connection.js:108`)
clicks reconnect/close/dismiss buttons matching a broad selector set. Intent:
keep "session disconnected" modals from wedging automation.

> **Known hazard:** the selector set includes generic `button[aria-label="Close"]`
> and `[class*="dialog__close"]`. A flow that legitimately opens a dialog (e.g.
> the Pine "Save Script" name prompt in `core/pine.js`) can have its dialog
> swept closed if the 3s window elapses mid-flow. Scope-tighten if this bites.
> See review notes in git history.

## Related

`getTargetInfo()` exposes the attached target; `disconnect()` tears down. Direct
API path helpers (`getChartApi`, etc.) verify a `KNOWN_PATHS` entry exists before
returning it — see [[evaluate-and-known-paths]].
