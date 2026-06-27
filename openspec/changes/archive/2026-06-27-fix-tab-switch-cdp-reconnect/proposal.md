# Change: Reconnect the CDP session on tab switch

## Why
`tab_switch` (`src/core/tab.js:88-106`) only calls TradingView's `/json/activate/<id>` HTTP endpoint,
which brings a tab to the foreground but does **not** migrate the CDP session. The module-level `client`
in `src/connection.js` stays bound to the previous target, and its liveness probe still succeeds because
the old target is alive. Every subsequent tool (`chart_get_state`, `quote_get`, …) therefore silently
operates on the **previous** chart while returning `success: true` with the wrong symbol's data.
Flagged High by audits 3, 4, and 5 (each S-1). Related: `tab.js` duplicates `CDP_HOST`/`CDP_PORT`
instead of importing them (A2 S-9), and its `fetch` calls have no timeout so a wedged CDP can hang
indefinitely (A3 S-6, A5 S-4); `newTab`/`closeTab` use fixed sleeps without verifying the tab list
actually changed (A3 nit, A5 S-L2).

## What Changes
- After activating a target, `tab_switch` SHALL rebuild the cached CDP client against the new target id
  before returning. **BREAKING**: subsequent calls now hit the newly selected tab (previously the old one).
- Expose a reconnect/`disconnect` seam from `src/connection.js` so `tab.js` can invalidate and rebuild
  the singleton against a specific target id.
- `tab.js` SHALL import `CDP_HOST`/`CDP_PORT` (and a shared `fetchWithTimeout`) from `connection.js`
  instead of redeclaring them.
- All `tab.js` HTTP calls (`list`, `switchTab` activate) SHALL use an `AbortController` deadline.
- `newTab`/`closeTab` SHALL verify the tab count actually changed (poll) rather than trusting a fixed sleep.

## Impact
- Affected specs: `tab-management` (new capability)
- Affected code: `src/core/tab.js`, `src/connection.js` (reconnect/disconnect + shared host/port + fetch
  helper), `src/tools/tab.js` (no schema change), `tests/` (new tab reconnect test)
