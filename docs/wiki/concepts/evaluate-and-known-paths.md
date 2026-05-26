---
title: evaluate() and KNOWN_PATHS — reaching TV internals
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/connection.js:136
  - src/connection.js:13
  - src/connection.js:174
related:
  - "[[cdp-connection]]"
  - "[[cdp-injection-safety]]"
  - "[[monaco-fiber-walk]]"
  - "[[pine-graphics-path]]"
---

# evaluate() and KNOWN_PATHS

## evaluate()

The universal primitive (`src/connection.js:136`): take a JavaScript string, run
it in TV's renderer via `Runtime.evaluate({ returnByValue: true })`, return the
value. `evaluateAsync()` (`:158`) sets `awaitPromise: true` for expressions that
return a Promise. On `exceptionDetails` it throws `JS evaluation error: <msg>`.

Almost every core function is "build a string, `evaluate()` it, shape the
result". The injected scripts are nearly always an IIFE returning a plain object:

```js
const data = await evaluate(`
  (function() {
    var api = ${CHART_API};
    /* ... read/mutate TV state ... */
    return { ok: true, value: ... };
  })()
`);
```

### returnByValue gotcha — JSON-serializable only

`returnByValue` serializes the result. If the IIFE returns a live object (DOM
node, class instance with circular refs), CDP silently yields `undefined`. Always
return plain JSON-able data.

### ASI gotcha — wrap interpolated multi-line snippets in parens

A constant like `FIND_MONACO` begins with a newline. Interpolating it bare after
`return` triggers JavaScript Automatic Semicolon Insertion:

```js
// BROKEN: ASI ends the statement at `return`, IIFE returns undefined
`(function(){ return ${FIND_MONACO} !== null; })()`
// CORRECT: parens keep it one expression
`(function(){ return (${FIND_MONACO}) !== null; })()`
```

This exact bug silently broke Pine Editor open-detection for a long time — see
[[monaco-fiber-walk]]. **When interpolating a newline-leading snippet into a
`return`, wrap it in parens.**

## KNOWN_PATHS

A map (`src/connection.js:13`) of TV-internal entry points discovered by live
probing (the repo references a `PROBE_RESULTS.md`). The load-bearing ones:

| Key | Path |
|-----|------|
| `chartApi` | `window.TradingViewApi._activeChartWidgetWV.value()` |
| `chartWidgetCollection` | `window.TradingViewApi._chartWidgetCollection` |
| `bottomWidgetBar` | `window.TradingView.bottomWidgetBar` |
| `replayApi` | `window.TradingViewApi._replayApi` |
| `alertService` | `window.TradingViewApi._alertService` |
| `mainSeriesBars` | `…_chartWidget.model().mainSeries().bars()` |

These are **private, unstable internals**. TV ships new bundles and renames or
removes them without notice — exactly what happened to `bottomWidgetBar` (see
[[bottom-widget-bar]]). Treat every path as a `[verified live]` fact with an
expiry, not a contract.

### verifyAndReturn

`verifyAndReturn(path, name)` (`src/connection.js:174`) evals
`typeof (path) !== 'undefined' && path !== null` before returning the path string,
so callers fail fast with a named error ("Chart API not available at …") instead
of a cryptic undefined deref deep in an injected script. `getChartApi()`,
`getChartCollection()` wrap it.
