# Change: Delete alerts by id (and all) via the pricealerts REST API

## Why
`deleteAlerts()` (`src/core/alerts.js`) cannot remove a specific alert: the `delete_all` path only opens
the alerts context menu and returns a "requires manual confirmation" note (it doesn't actually delete),
and the non-`delete_all` path throws "Individual alert deletion not supported". A live CDP Network
capture of the TradingView client revealed the real internal endpoint, so per-id and bulk deletion can
now be done directly and reliably:

```
POST https://pricealerts.tradingview.com/delete_alerts
Content-Type: text/plain;charset=UTF-8        (application/json triggers a CORS preflight the server rejects)
body: {"payload":{"alert_ids":[<id>, ...]}}    (the payload wrapper is required)
-> {"s":"ok"}                                  (validated end-to-end: created via dialog, deleted via REST)
```

`list_alerts` (already used by `list()`) returns each `alert_id`, so `delete_all` can list-then-delete via
the same API instead of the non-functional context-menu path.

## What Changes
- `deleteAlerts()` SHALL accept `alert_ids` (a single id or an array) and delete exactly those alerts via
  `POST /delete_alerts` with the `{"payload":{"alert_ids":[...]}}` body and `text/plain` content-type.
- `deleteAlerts({ delete_all: true })` SHALL fetch the current alert ids via `list()` and delete them all
  through the same REST call (replacing the context-menu path that never actually deleted).
- `deleteAlerts()` SHALL throw when neither `alert_ids` nor `delete_all` is given, and SHALL throw when the
  REST call returns a non-`ok` status — keeping the core-throws failure-signaling contract.
- On success it SHALL return `{ success: true, deleted_count, deleted_ids, source: 'pricealerts_api' }`.
- The `alert_delete` tool + `tv alert delete` CLI SHALL expose the new `alert_ids` / `--id` input.
- `create_alert` REST is **out of scope**: the captured schema requires an internal per-symbol
  `currency-id` (a plain ticker returns `invalid_request`), so the dialog-driven `create()` stays the
  creation path.

## Impact
- Affected specs: `error-handling` (MODIFIED: the deletion-mode requirement now supports per-id/all REST
  deletion instead of "individual deletion unsupported"), `alert-management` (ADDED: REST deletion).
- Affected code: `src/core/alerts.js` (`deleteAlerts`), `src/tools/alerts.js`, `src/cli/commands/alerts.js`,
  `tests/alerts.test.js`.
- Supersedes the "Optional alert deletion mode" requirement from `normalize-failure-signaling` /
  `normalize-remaining-failure-signaling` (individual deletion is no longer unsupported).
