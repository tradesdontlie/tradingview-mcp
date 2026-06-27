## 1. Core — REST deletion
- [x] 1.1 In `src/core/alerts.js`, add a `deleteAlertsJS(ids)` builder that returns the page-side
      `fetch('https://pricealerts.tradingview.com/delete_alerts', { method:'POST', credentials:'include',
      headers:{'Content-Type':'text/plain;charset=UTF-8'}, body: <{"payload":{"alert_ids":[...]}}> })`
      and resolves the parsed JSON (catching transport errors to `{ error }`).
- [x] 1.2 Rewrite `deleteAlerts({ alert_ids, delete_all, _deps })`: normalize `alert_ids` to an array;
      when `delete_all`, get ids from `list({ _deps })`; throw when no target is given; run the REST call
      via `evaluateAsync`; throw on `error` / non-`ok` status; return
      `{ success: true, deleted_count, deleted_ids, source: 'pricealerts_api' }`. `delete_all` with no
      alerts returns `deleted_count: 0`.

## 2. Tool + CLI surface
- [x] 2.1 `src/tools/alerts.js` `alert_delete`: add `alert_ids` (single int or int array, optional);
      keep `delete_all`. Pass both to `core.deleteAlerts`.
- [x] 2.2 `src/cli/commands/alerts.js` `delete`: add `--id` (comma-separated ids) alongside `--all`;
      parse to a number array via `requireFinite`.

## 3. Tests (DI-mocked, offline)
- [x] 3.1 `deleteAlerts({ alert_ids: 123 })` issues the `delete_alerts` POST and returns
      `deleted_count: 1`, `deleted_ids: [123]` when the injected `evaluateAsync` resolves `{ s: 'ok' }`.
      → also asserts the payload-wrapped body + text/plain content-type.
- [x] 3.2 `deleteAlerts({ alert_ids: [1,2,3] })` reports `deleted_count: 3`.
- [x] 3.3 `deleteAlerts({ delete_all: true })` lists then deletes (scripted `evaluateAsync` distinguishes
      `list_alerts` vs `delete_alerts`); 0 alerts → `deleted_count: 0` and no delete call.
- [x] 3.4 `deleteAlerts({})` (no target) throws; REST non-`ok` and transport-error both throw.

## 4. Validate
- [x] 4.1 `openspec validate rest-alert-deletion --strict` → "Change 'rest-alert-deletion' is valid".
- [x] 4.2 Offline suite green (70). Live round-trips: production `deleteAlerts({ alert_ids })` and
      `tv alert delete --id <id>` both created→deleted→restored the baseline count.
