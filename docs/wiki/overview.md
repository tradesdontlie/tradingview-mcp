---
title: Overview — tradingview-mcp
type: overview
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/server.js
  - CLAUDE.md
  - README.md
related:
  - "[[architecture]]"
  - "[[cdp-connection]]"
  - "[[context-management]]"
  - "[[catalog]]"
---

# tradingview-mcp — Overview

An MCP (Model Context Protocol) server that lets an LLM **read and control a live
TradingView Desktop chart**. It drives the real desktop app — not a headless
browser, not the TV REST API — by attaching to the Electron renderer over Chrome
DevTools Protocol (CDP) on `localhost:9222` and evaluating JavaScript inside the
running page.

```
Claude / LLM ⇄ MCP server (stdio) ⇄ CDP (localhost:9222) ⇄ TradingView Desktop (Electron)
```

## What it does

~79 tools (`src/server.js:36` advertises "78") across 25 groups: read chart
state and indicator values, scrape custom Pine drawings (lines/labels/tables/
boxes that normal data APIs can't see), switch symbol/timeframe/type, develop and
compile Pine Script, run bar replay + paper trades, screenshot, draw shapes, set
alerts, drive arbitrary UI, and pull external market data (Yahoo, Hyperliquid,
brokers, screeners). Full list in [[catalog]].

## How the code is shaped

Three tiers — see [[architecture]] for the full picture:

- **`src/tools/*`** — MCP tool registrations. Zod schemas + thin handlers that
  call core and wrap the result in `{ success, ... }`. Never contain logic.
- **`src/core/*`** — the actual logic. Plain async functions taking option
  objects, returning plain objects, **throwing on error**. Most build a JS
  string and hand it to `evaluate()`.
- **`src/connection.js`** — the single CDP chokepoint: `evaluate()`,
  `KNOWN_PATHS`, connection retry, popup auto-dismiss, injection-safe helpers.

`src/cli/*` mirrors the tool layer for terminal use (the `tv` binary). `src/wait.js`
holds the chart-ready polling that gates state changes.

## The load-bearing ideas

If you only read a few concept pages, read these — they are where the project's
real difficulty and most of its bugs live:

- [[cdp-connection]] — how the CDP attach works and why it's a singleton.
- [[evaluate-and-known-paths]] — every core function funnels through
  `evaluate()`; TV's internals are reached via discovered `KNOWN_PATHS`.
- [[monaco-fiber-walk]] — Pine Editor's Monaco instance is found by walking the
  React fiber tree, not a global. Subtle and bug-prone.
- [[bottom-widget-bar]] — TV redesigned the bottom panel; the old `bwb` API is
  gone. This broke Pine-Editor-open and was the subject of a deep fix.
- [[pine-graphics-path]] — custom Pine drawings live at a deep private path;
  this is the project's signature capability.
- [[cdp-injection-safety]] — user values are interpolated into evaluated JS;
  `safeString`/`requireFinite` exist to stop injection.
- [[context-management]] — these tools can return huge payloads; the server
  prompt and tool defaults aggressively keep responses small.

## Stack

ESM Node. Deps: `@modelcontextprotocol/sdk`, `chrome-remote-interface`, `ws`,
`yahoo-finance2`, `technicalindicators`, `rss-parser`, `dotenv`
(`package.json`). Tests are Node's built-in runner (`tests/*.test.js`) and run
against a **live** TradingView session, so they are environment-sensitive.

## Status / provenance notes

- `package.json` version is `1.0.0` but `src/server.js:32` reports `2.0.0` —
  inconsistent. **[unverified]** which is authoritative.
- Tool count drifts between the server prompt ("78"), the CLAUDE.md ("68"), and
  the actual registrations (~79). Treat [[catalog]] as the ground truth and
  re-derive on ingest.
