# Fork Notes — lnv-louis/tradingview-mcp

> Local inventory of our divergence from upstream `tradesdontlie/tradingview-mcp`.
> Anything not listed here is identical to upstream `main` at base commit `4795784`.

**Active branch:** `fixes/integration`
**Remotes:**
- `origin` → `git@github.com:lnv-louis/tradingview-mcp.git` (our fork)
- `upstream` → `https://github.com/tradesdontlie/tradingview-mcp.git`

**Test status:**
- Unit tests: **97/97 pass** (sanitization 68 + pine_analyze 16 + cli 13)
- Live smoke tests: **10/10 effective pass** (`tests/smoke-live.mjs` against running TV Desktop)
- E2E suite: skipped during integration to avoid disrupting active chart state

---

## Why this branch exists

Three pressure points hit at once:
1. Two upstream PRs (`#62`, `#72`) for a real DI-regression bug introduced by `f23eb1b` — both unmerged for 9+ days while users hit the bug daily.
2. `alert_create` had been DOM-broken since the last TV Desktop UI refresh — particularly painful in non-English locales (e.g. Vietnamese).
3. A separate cluster of small useful fixes (TV 3.1.0 strategy scraper, layout_switch i18n, Pine editor robustness) was scattered across PRs `#90`/`#91`/`#95`/`#97`.

Rather than wait for a sequence of upstream merges, we're consolidating the high-value patches here, validating them against live TV, and shipping. The fork stays as our permanent escape hatch when future TV updates break things.

---

## Patches on top of upstream `main` (4795784)

Listed oldest → newest. **15 commits.**

### 1. `4841d57` — DI restore in 7 core functions (drawing.js + chart.js)

**Bug:** Upstream commit `f23eb1b` (DI sanitization refactor) wrapped some functions with `_resolve(_deps)` but left 7 others calling bare `evaluate()` / `getChartApi()` — which, after the refactor, were under `_evaluate` / `_getChartApi` aliases at module scope. Result: `draw_list`, `draw_clear`, `draw_remove_one`, `draw_get_properties`, `chart_get_visible_range`, `chart_scroll_to_date`, `symbol_info` all threw `getChartApi is not defined` or `evaluate is not defined`.

**Fix:** Apply the `_resolve(_deps)` destructure pattern to all 7. ~15 lines across 2 files. Closes upstream issues #83, #84, #85. Supersedes upstream PRs #62 (drawing) + #72 (chart).

**Verified live:** `draw_list` returns shapes; `chart_get_visible_range` returns timestamps; `symbol_info` returns metadata.

---

### 2. `dabb9a7` — `pine_labels` cap raise + `watchlist_get` lazy-render fix (cherry-pick of PR #89's `80a69eb`)

**Part A — `data_get_pine_labels` default cap.** Was `max_labels || 50`. Dense indicators (multi-EMA dashboards, ASTA 3Cs) routinely emit 100+ labels; the 50-cap silently dropped the earliest ones, which are often foundational (Fib levels, pivot prices). Raised default to 500 + new `truncated: boolean` field per study so callers can detect truncation.

**Part B — `watchlist_get` lazy-render.** TV lazy-renders sidebar widgets: when Alerts (or another tab) is the active sidebar, the watchlist DOM exists but is empty. Fix: click the watchlist tab if `aria-pressed !== "true"`, wait 400ms, then scrape.

---

### 3. `681305b` — `alert_create` rewritten over TV's REST API (cherry-pick of PR #89's `33b578b`)

**Bug:** Old code used DOM automation (open dialog → fill fields → click Create) with stale selectors (`"Create Alert"` capital A, but TV now uses lowercase `"Create alert"`) and broken targeting. Worked even worse in non-English locales like Vietnamese.

**Fix:** POST directly to `https://pricealerts.tradingview.com/create_alert`. Wire format reverse-engineered via in-page `fetch` interceptor:

```
POST /create_alert
Body (no Content-Type header — preflight-free!):
{
  "payload": {
    "symbol": "={\"symbol\":\"...\",\"adjustment\":\"dividends\",\"currency-id\":\"USD\"}",
    "resolution": "1",
    "message": "...",
    ...
    "conditions": [{ "type": "cross", "frequency": "on_first_fire",
                     "series": [{"type":"barset"},{"type":"value","value":<price>}],
                     "resolution": "1" }],
    "active": true, "ignore_warnings": true
  }
}
```

**Critical:** sending `Content-Type: application/json` triggers a CORS preflight that the server rejects. Send the JSON as plain string body with no `Content-Type` to keep it a "simple" request.

**Verified live:** smoke test creates and deletes a sentinel alert successfully.

---

### 4. `0f31d7f` — `alert_delete` rewritten over REST + bulk support (cherry-pick of PR #89's `9d05087`)

**Bug:** Old code only handled `{delete_all: true}` and even then opened a context menu requiring user click-through. Individual deletion was unsupported.

**Fix:** POST to `https://pricealerts.tradingview.com/delete_alerts` with `{"payload": {"alert_ids": [id1, id2, ...]}}`. TV supports native bulk delete in one request. Accepts `{alert_id}`, `{alert_ids: []}`, or `{delete_all: true}`.

**Verified live:** smoke test deletes the just-created sentinel alert.

---

### 5. `9daf46b` — Watchlist management tools via REST API (cherry-pick of PR #89's `f475946`)

Adds 6 new tools wrapping TV's watchlist REST endpoints (`/list_watchlists`, `/create`, `/rename`, `/remove_symbol`, `/delete`, `/switch`). All use the same fetch-interceptor pattern as alerts.

---

### 6. `f7ddcb0` — `hotlist_get` new tool (cherry-pick of PR #89's `c59d03b`)

Exposes TradingView's public scanner presets via `https://scanner.tradingview.com/presets/US_<slug>?label-product=right-hotlists`. 9 allowed slugs (volume_gainers, percent_change_gainers/losers, gap_gainers/losers, etc.) — both bull and bear, useful for screener-style workflows. Whitelist enforced server-side; bad slugs return a clear error listing valid ones.

**Verified live:** smoke test fetches `volume_gainers` (5 symbols, total_count=4059) and rejects bogus slug correctly.

---

### 7. `fd23c37` — `alert_create` price-parity validator (cherry-pick of PR #89's `0a032a6`)

T31 — refuse `alert_create` when the user-provided message cites a price that disagrees with the condition value. Prevents the "phone alert says $X, actual trigger is $Y" drift. Returns `success: false` with `cited_prices` and `condition_value` in the response so the caller sees exactly what mismatched.

---

### 8. `ba2b539` — `quote_get` cross-symbol via scanner REST (cherry-pick of PR #89's `aed8ad2`)

T35 — when `quote_get` is called with a `symbol` arg different from the active chart, route through `https://scanner.tradingview.com/symbol?symbol=...` REST endpoint instead of forcing the chart to switch symbols (which corrupted layout state and was slow).

**Verified live:** `quote_get({symbol: "NASDAQ:NVDA"})` returns last=199.64, source=scanner_rest, without disturbing the active chart.

---

### 9. `a1ed1c0` — TV Desktop 3.1.0 compat for data.trades / data.strategy / data.equity (cherry-pick of PR #90's `04993ea`)

TradingView Desktop 3.1.0 changed the strategy-tester DOM layout. Three tools (`data_get_strategy_results`, `data_get_trades`, `data_get_equity`) all DOM-scrape that panel and silently returned empty results on 3.1.0+. Fix adds DOM-fallback selectors plus an internal-API path via `model.dataSources()`.

---

### 10. `f8593c7` — `layout_switch` i18n: PT/ES/FR/DE locales (cherry-pick of PR #91's `b0be30f`)

`layout_switch` clicks the "Open anyway / Discard" button on the unsaved-changes dialog. Old regex matched English only. PR adds Portuguese, Spanish, French, German.

---

### 11. `90b4b8d` — `layout_switch` i18n: Vietnamese (our extension to PR #91)

Adds `vẫn mở | không lưu | bỏ qua` to the multilingual regex. Required because the user's TradingView Desktop is in Vietnamese (`vn.tradingview.com/chart/...`), and PR #91 didn't include VI.

---

### 12. `47f20c4` — Pine editor: match Add/Update buttons by `title` attr (cherry-pick of PR #95's `f78e270`)

Pine compile/save buttons were matched by visible text, which broke when TV changed button labels. Switching to `[title="..."]` matching is more stable across UI refreshes.

---

### 13. `416b5ae` — Pine editor: resilient detection during state transitions (cherry-pick of PR #97's `a9719d7`)

Pine editor presence-check used to fail if TV was mid-transition (compiling, saving, switching scripts). Adds polling + fallback selectors to handle transient states.

---

### 14. `6fe98a6` — `draw_shape` hardening: Zod enum + entity_id null detection (our work)

Two related fixes for silent-failure modes in `draw_shape`:

**Part A — Zod enum.** Replaced free-form `shape: z.string()` with `z.enum([...])` covering all supported TV shape types. Misspellings like `"horizontalline"` previously passed validation and failed silently inside TradingView; now Zod rejects at the MCP layer with a clear error listing valid options.

**Part B — entity_id null detection.** Old `core.drawShape` extracted `entity_id` from the diff between pre/post `getAllShapes()`. If `createShape` silently failed (bad coords for the bar resolution, off-screen, etc.), the diff was empty → returned `{success: true, entity_id: null}` — actively misleading. New code detects `newId === null` and returns `{success: false, error: "createShape returned no new entity..."}`.

**Verified live via smoke test:**
- Old MCP returned `{success: true, entity_id: null}` for a `horizontal_line` on a 1D chart with sub-day timestamp
- New code returns `{success: false, error: "createShape returned no new entity. Common causes: invalid shape name ... or point coordinates outside the chart's loaded range."}`

Both behaviors stem from the same TV rejection — but the new code surfaces it instead of lying.

---

### 15. `08eb607` — Live smoke test harness (`tests/smoke-live.mjs`)

Standalone Node script (not registered in `npm test`) that exercises the modified tools end-to-end against a running TV Desktop. Designed to be safe: alert tests use a sentinel price ($999,999) and clean up immediately; drawings remove themselves after creation. Run with:

```
node tests/smoke-live.mjs
```

Currently 10 checks: alerts × 3, watchlist, hotlist × 2, quote × 2, drawing × 2.

---

## Skipped from PR #89

- `285587d` (drawing DI cherry-pick from #62) — already in our `4841d57` with chart.js side included
- `8627d31`, `57cb75e`, `e41dd22`, `5a00ca5` — kuldeeppatel123's own FORK_NOTES — not relevant to our fork

---

## Skipped from upstream entirely

- **PR #54** (remove `ui_evaluate`) — `ui_evaluate` is our escape hatch when typed tools break. Keep it.
- **Windows MSIX detection cluster** (PRs #52, #73, #76, #79, #93) — we're on macOS.
- **Personal trading rules / Docker** (PRs #98, #74, #69, #86, #53) — out of scope.

## Open work (not yet patched)

- Issue **#41** — UI perf degradation with `--remote-debugging-port` on heavy charts. Affects us when stacking heavy Pine indicators.
- Issue **#37** — `tab_switch` / `layout_switch` Electron CDP limitation: switches happen but visual update lags.
- Issue **#84** — `chart_set_visible_range` silent success without moving the chart. Needs investigation.
