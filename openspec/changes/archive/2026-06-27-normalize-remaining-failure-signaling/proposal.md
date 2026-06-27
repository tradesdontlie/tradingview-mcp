# Change: Normalize the remaining `core` failure-signaling violations

## Why
`normalize-failure-signaling` established the contract "core functions THROW on failure; `tools/*.js`
wrap to `{success:false,error}`; core must NOT return `{success:true}` with an embedded `error`." Three
`core` paths still violate it (audit 2026-06-26 findings B-1, B-2):

- `alerts.list()` returns `{ success: true, ..., error: result?.error }` (`src/core/alerts.js:119`) —
  on the REST/`.catch` failure branch the payload carries `{alerts:[], error}` and core forwards it as
  success-with-error.
- `pine.listScripts()` returns `{ success: true, ..., error: scripts?.error }`
  (`src/core/pine.js:678-684`) — same shape.
- `alerts.deleteAlerts()` returns `{ success: false, error: '...' }` directly from core for the
  unsupported-deletion branch (`src/core/alerts.js`, non-`delete_all` path), instead of throwing — so
  the tool layer passes it through `jsonResult` **without** the MCP `isError` flag.

Sibling functions already do this correctly (`openScript`, `getStrategyResults`, `getTrades` throw on
`result.error`), so this is residual cleanup, not new behavior.

## What Changes
- `alerts.list()` and `pine.listScripts()` SHALL throw on `result?.error` (letting the tool wrap it),
  instead of returning `success:true` with an embedded `error`.
- `alerts.deleteAlerts()` SHALL throw for the unsupported-operation branch instead of returning a
  `{success:false}` shape from core, so the tool wrapper sets the MCP `isError` flag.

## Impact
- Affected specs: `failure-signaling` (new capability)
- Affected code: `src/core/alerts.js`, `src/core/pine.js`, `tests/`
- Extends `normalize-failure-signaling`; no new tool surface. Callers that already check `.success`
  begin seeing `false` (with `isError`) on these failure branches instead of a misleading `true`.
