# Fork Notes — kuldeeppatel123/tradingview-mcp

> Local inventory of our divergence from upstream `tradesdontlie/tradingview-mcp`.
> Anything not listed here is identical to upstream.

**Active branch:** `fixes/draw-api-resolve`
**Remotes:**
- `origin` → `https://github.com/kuldeeppatel123/tradingview-mcp.git` (our fork)
- `upstream` → `https://github.com/tradesdontlie/tradingview-mcp.git`

## Why we forked

We hit four concrete bugs on TradingView Desktop 3.0.0 (MSIX install, distributed from both tradingview.com and the Microsoft Store) that blocked the live-trading workflow. Three were unreported upstream; one had a PR open but unmerged. Rather than wait, we forked and fixed them in-tree so the trading loop doesn't stall.

The fork is also our permanent escape hatch: when a future TV update breaks something else, we now have the build tooling, fetch-interception recipes, and patch workflow ready to go. See the "Fork workflow" section in the project's `CLAUDE.md` for the diagnostic playbook.

## Patches on top of upstream `main`

Commits are listed oldest → newest. All four are on `fixes/draw-api-resolve`.

### 1. `285587d` — Drawing API DI (cherry-pick of upstream PR #62, commit `4b13405`)

**Bug:** `draw_list`, `draw_clear`, `draw_remove_one`, `draw_shape` all failed with `getChartApi is not defined` after upstream commit `f23eb1b` (CDP injection sanitization refactor).

**Root cause:** `f23eb1b` wrapped `drawShape` with a `_resolve(_deps)` dependency injector but forgot to wrap the other four functions — they still called bare `getChartApi()` and `evaluate()` which weren't in scope after the refactor.

**Fix:** ~8-line change in `src/core/drawing.js`, applying the same `_resolve(_deps)` pattern to `listDrawings`, `getProperties`, `removeOne`, and `clearAll`. Tests in `tests/sanitization.test.js` updated to cover the new signatures.

**Source:** Upstream PR https://github.com/tradesdontlie/tradingview-mcp/pull/62 (open as of 2026-04-21). Cherry-picked commit `4b13405` verbatim.

---

### 2. `80a69eb` — `pine_labels` default cap + `watchlist_get` lazy-render

**Part A: `data_get_pine_labels` default cap.** Before: `max_labels || 50` in `src/core/data.js:389`. Dense indicators (ASTA 3Cs Dashboard, multi-EMA dashboards) routinely emit 100+ labels; the 50-cap silently dropped the earliest ones — which are often foundational (Fib levels, pivot prices, EMA tags) — while retaining only the latest dynamic event labels. After: default raised to 500, plus a new `truncated: boolean` field on each study entry so callers can detect truncation without comparing `showing` vs `total_labels`.

**Part B: `watchlist_get` returns `count:0` when a different sidebar tab is active.** TradingView lazy-renders sidebar widgets: when the Alerts tab (or Object Tree, News, etc.) is the active sidebar tab, the `[class*="widgetbar-widget-watchlist"]` element exists in the DOM but has empty `innerHTML` — so `[data-symbol-full]` returns 0 elements and both DOM-fallback paths find nothing. Fix: before scraping, click `[aria-label="Watchlist, details, and news"]` if `aria-pressed !== "true"`, then wait 400ms for TV to populate the DOM. No selector change needed — the existing `[data-symbol-full]` scraping still works once the widget renders.

**Files touched:** `src/core/data.js`, `src/core/watchlist.js`.

---

### 3. `33b578b` — `alert_create` rewritten over TV's REST API

**Bug:** The old implementation used DOM automation to open the alert-creation dialog, fill in the price field, fill in the message, and click Create. It had been failing silently (`success: false, price_set: false, source: dom_fallback`) because (a) selectors were stale — code looked for `aria-label="Create Alert"` with capital A, but TV now uses lowercase `"Create alert"`; and (b) even with the right selector, the specific button the code targeted wasn't the one that opens the full dialog.

**Diagnostic method:** Installed a `fetch` + `XMLHttpRequest` interceptor via `ui_evaluate`, asked the user to create one alert manually in TV, then captured the outgoing POST to `pricealerts.tradingview.com/create_alert`. Wire format was:

```json
POST https://pricealerts.tradingview.com/create_alert
Body (double-wrapped, no Content-Type header!):
{
  "payload": {
    "symbol": "={\"symbol\":\"BATS:NFLX\",\"adjustment\":\"dividends\",\"currency-id\":\"USD\"}",
    "resolution": "1",
    "message": "NFLX Crossing 100.00",
    "sound_file": null, "sound_duration": 0, "popup": true,
    "expiration": "<ISO 8601 30 days out>",
    "auto_deactivate": true, "email": false, "sms_over_email": false,
    "mobile_push": true, "web_hook": null, "name": null,
    "conditions": [{
      "type": "cross",                 // or cross_up / cross_down
      "frequency": "on_first_fire",
      "series": [{"type":"barset"},{"type":"value","value":100}],
      "resolution": "1"
    }],
    "active": true, "ignore_warnings": true
  }
}
```

**Critical detail:** Sending `Content-Type: application/json` triggers a CORS preflight that the server rejects with an opaque "Failed to fetch" error. TV's own client sends the JSON as a plain string body with no `Content-Type` header — which works because it's a "simple" request in CORS terms. Our patch does the same.

**Fix:** Replaced the DOM dance with a single `evaluateAsync` call that POSTs to `/create_alert` with the reconstructed payload, reading `symbol` / `resolution` / `currency` from the active chart via TV's internal `model.mainSeries()` API. Friendly condition names (`"crossing"` / `"greater_than"` / `"less_than"`) are normalized to TV's internal types (`cross` / `cross_up` / `cross_down`).

**Files touched:** `src/core/alerts.js`, `src/tools/alerts.js`.

---

### 4. `9d05087` — `alert_delete` rewritten over TV's REST API (individual + bulk)

**Bug:** Old `alert_delete` only accepted `{delete_all: true}` and even then just opened a context menu for the user to click through manually. Individual-alert deletion threw `"not yet supported"`. Useless for "delete this invalidated alert after the trade closes" or "clean up stale alerts" workflows.

**Diagnostic method:** Same playbook as `alert_create`. Installed `fetch` + `XMLHttpRequest` interceptor via `ui_evaluate`, asked user to right-click-delete one alert in TV's sidebar, captured the outgoing POST. Verified the bare endpoint (no telemetry query params) works by probing live:

```json
POST https://pricealerts.tradingview.com/delete_alerts
Body (no Content-Type header):
{"payload":{"alert_ids":[4524870449]}}

Response: status 200, {"s":"ok","id":"dbus-...","r":null}
```

**Nice surprise:** `alert_ids` is an array — TV supports **native bulk delete** in one request.

**Fix:** Replaced the DOM dance with a REST call. New tool signature accepts any of:
- `alert_id: 12345` — single
- `alert_ids: [1, 2, 3]` — bulk
- `delete_all: true` — `list()` first, then delete every returned id

Returns `{ success: true, deleted_count: N, deleted_ids: [...] }`.

**Files touched:** `src/core/alerts.js`, `src/tools/alerts.js`.

---

## Adding more fixes — workflow

The diagnostic playbook lives in `CLAUDE.md` (project root of ASTA ECO4). Summary:

1. Reproduce the bug, capture exact response.
2. `Grep` the tool name or symptom to find the source file in `src/core/`.
3. Probe root cause with `ui_evaluate` (DOM inspection, TV internal API exploration, or REST interceptor + manual UI trigger).
4. Write a surgical patch; one concern per commit; always document _why it was broken_ in the commit message.
5. `node --check src/core/<file>.js` before commit.
6. Restart Claude Code; smoke-test the fix with a real chart loaded.
7. Commit on `fixes/draw-api-resolve`, push to `origin`.
8. Update this file + the "Known limitations" section in the ASTA ECO4 CLAUDE.md.
9. (Optional) File upstream issue with repro + link to our commit.

## Tests

38/38 sanitization tests pass after all three patches. Run: `node --test tests/sanitization.test.js`.

The `source audit — no unsafe interpolation patterns` test case has a pre-existing Windows path-handling bug in its setup (constructs `C:\C:\...`) — it fails at the suite-setup stage, not because any real test failed. Not caused by our patches; ignore.

## Staying in sync with upstream

Periodic rebase pattern:

```bash
cd C:\Users\Kp\tradingview-mcp
git fetch upstream
git checkout fixes/draw-api-resolve
git rebase upstream/main
# resolve conflicts if any
git push origin fixes/draw-api-resolve --force-with-lease
```

If upstream merges PR #62, drop our `285587d` commit during rebase (git should auto-detect the duplicate). Our `80a69eb`, `33b578b`, and `9d05087` should stay separate; they're not upstream.

## Open upstream-facing work (optional)

Draft issue reports for the two unreported bugs we patched exist in the ASTA ECO4 session transcript (Session 15). Paste at https://github.com/tradesdontlie/tradingview-mcp/issues/new when you want maintainer attention. Issues:

- `data_get_pine_labels` silently truncates to 50 labels — default cap too low for real indicators
- `watchlist_get` returns `count: 0` when a different sidebar tab is active — TV lazy-renders hidden widgets
- `alert_create` DOM automation is stale — REST endpoint `pricealerts.tradingview.com/create_alert` works instead (this one may be especially valuable to the maintainer)
- `alert_delete` only supports `delete_all`, and even that opens a context menu — REST endpoint `pricealerts.tradingview.com/delete_alerts` supports native bulk delete by ID
