# Change: Consolidate the remaining TradingView path literals into `KNOWN_PATHS`

## Why
`consolidate-shared-constants-and-timing` centralized TradingView internal API paths in `KNOWN_PATHS`
(`src/connection.js:43-60`) with the rule "modules import them rather than redeclaring the literal." Four
call sites still hardcode the literals (audit 2026-06-26 finding B-3), so a future path change would
silently bypass the single source of truth:

- `src/core/data.js:95,129,504` — re-spell `window.TradingViewApi._activeChartWidgetWV.value()` even
  though the module already has `const CHART_API = KNOWN_PATHS.chartApi` (`:15`).
- `src/core/pane.js:14,71,165` — `const CWC = 'window.TradingViewApi._chartWidgetCollection'` and inline
  chartApi literals; `pane.js` does not import `KNOWN_PATHS` at all.
- `src/core/stream.js:395` — redeclares the collection path as a literal while already importing
  `KNOWN_PATHS` and using `CHART_API`.
- `src/core/pine.js:21` — `PINE_FACADE_BASE` duplicates the exact `KNOWN_PATHS.pineFacadeApi`
  env-resolution + trailing-slash-trim (`src/connection.js:59`).

## What Changes
- Each hardcoded literal SHALL be replaced by the corresponding `KNOWN_PATHS` member
  (`chartApi` / `chartWidgetCollection` / `pineFacadeApi`), interpolating `${CHART_API}` where the module
  already aliases it. `pane.js` SHALL import `KNOWN_PATHS`.
- No behavior change — the resulting expression strings are identical to today's literals.

## Impact
- Affected specs: `shared-constants` (new capability)
- Affected code: `src/core/data.js`, `src/core/pane.js`, `src/core/stream.js`, `src/core/pine.js`
- Completes `consolidate-shared-constants-and-timing`; low risk, mechanical.
