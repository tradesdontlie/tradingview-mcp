# Change: Consolidate shared constants, timing, and duplicated logic

## Why
A cluster of low-severity maintainability issues recur across all five audits and raise the cost of every
future change:
- The `CHART_API` literal is redeclared in `chart.js:7`, `indicators.js:6`, `stream.js:7` even though
  `connection.js` exports `KNOWN_PATHS.chartApi` (only `data.js` uses it) — a TV path change needs 4
  edits (all audits B-1/B-4; `KNOWN_PATHS` confirmed at `connection.js:11`).
- 20–38 magic-number `setTimeout` delays are scattered across ~14 files with no named constants or
  rationale (all audits S-5/P-6/S-10).
- Duplicated logic: compile-button finder in `pine.js` (A3 B-4), strategy-finding loop across three
  `data.js` functions (A2 P-4), bar-index range search in `chart.js` (A3 B-5), and hand-rolled polling
  loops that could share a `pollUntil` helper in `wait.js` (A3 B-14).
- Tool-count drift: `server.js` says "78 tools", `cli/index.js` says "70", `CLAUDE.md` says "68" — the
  server string is read by LLMs as ground truth (A3 B-5).
- The Pine REST base URL is hardcoded, breaking air-gapped/proxy setups (A1 B-6).
- `package.json` has no `engines.node` despite requiring Node ≥18 (A3 B-4).
- `replay_stop` doesn't hide the replay toolbar (A1 S-9). Tool-layer error boilerplate is duplicated ~70×
  and could share a `wrap(fn)` helper (A3 patterns).

## What Changes
- Import `KNOWN_PATHS.chartApi` in `chart.js`, `indicators.js`, `stream.js`; remove the literals.
- Extract timing delays into named constants with one-line rationale comments.
- Extract shared helpers: `findCompileButton()`, `findStrategy()`, `findBarIndexRange()`, and a generic
  `pollUntil(predicate,{interval,timeout})` in `wait.js` (reused by `waitForChartReady` and the pine
  editor poll).
- Establish a single source of truth for the tool count; align server/CLI/docs.
- Allow overriding the Pine REST base URL via an environment variable (default unchanged).
- Add `"engines": { "node": ">=18.0.0" }` to `package.json`.
- `replay_stop` SHALL hide the replay toolbar. Add a `wrap(fn)` helper in `_format.js` for tool error
  boilerplate.

## Impact
- Affected specs: `maintainability` (new capability)
- Affected code: `src/core/{chart,indicators,stream,pine,data,replay}.js`, `src/wait.js`,
  `src/tools/_format.js`, `src/server.js`, `src/cli/index.js`, `CLAUDE.md`, `package.json`
