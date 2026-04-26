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

### 5. `f475946` — Watchlist management extension (6 new REST-backed tools)

**Bug / gap:** Upstream MCP shipped only `watchlist_get` (read) and `watchlist_add` (DOM automation — keyboard-driven, single symbol, no target list selection). Skills like `/watchlist-scan`, `/3cs`, `/watchlist-review` were half-manual because we couldn't programmatically remove symbols, switch between lists, or create/rename/delete watchlists. Blocked full automation of the tiered lists (02 MASTER → 03 FOCUS → 05 STALK → 04 HOT) and any future `watchlist_scan_cron.py` job.

**Diagnostic method:** Same playbook as `alert_create` / `alert_delete`. Installed a broad `fetch` + `XMLHttpRequest` interceptor via `ui_evaluate`, asked the user to manually perform each target action (remove a symbol, switch list, create list, rename list, delete list), and captured the outgoing REST requests.

**Scope:** 6 new MCP tools, all REST-backed (no DOM automation), plus a shared `tvRest()` helper. Wire formats captured on TV Desktop 3.1.0.7818 (2026-04-21):

```
GET    /api/v1/symbols_list/all/?source=web-tvd
  -> [{id, type:"custom"|"colored", name, color|null, symbols:[...], active, shared, modified, ...}]

POST   /api/v1/symbols_list/active/{id_or_color}/?source=web-tvd
  Body: empty
  -> numeric id for custom lists; color name ("red"/"blue"/"green"/"yellow"/"purple") for colored

POST   /api/v1/symbols_list/custom/{id}/remove/?source=web-tvd
  Body: ["NYMEX:CL1!"]

POST   /api/v1/symbols_list/custom/?source=web-tvd
  Body: {"name":"99_mcp_test","symbols":[]}
  -> returns the new list record including id

POST   /api/v1/symbols_list/custom/{id}/rename/?source=web-tvd
  Body: {"name":"new name"}

DELETE /api/v1/symbols_list/custom/{id}/?source=web-tvd
  Body: none
```

**Critical CORS asymmetry (opposite of alerts.js):** These endpoints live on `www.tradingview.com` — **same-origin** as the chart page, so setting `Content-Type: application/json` is SAFE (no CORS preflight). The `/custom/` create and `/custom/{id}/rename/` endpoints actually REQUIRE it and return `HTTP 415 Unsupported Media Type` otherwise. Contrast: `alerts.js` hits `pricealerts.tradingview.com` which is cross-origin — there the `Content-Type` header triggers a preflight TV rejects. `tvRest()` documents this asymmetry inline so future patches don't re-trip the same mine.

**Destructive-action guard on `watchlist_delete` (added 2026-04-22 after a real incident):** During smoke-test, the AI mis-targeted `watchlist_delete` and destroyed a live 26-symbol working watchlist (`🦏FOCUS`) instead of the throwaway test list. The list was recoverable because its contents were in chat context, but the near-miss demonstrated that `confirm_active` alone is not a sufficient safeguard against wrong-name errors. New design: `watchlist_delete` requires a `confirm_name` parameter that must exactly match the target list's resolved name (case-sensitive, trimmed). Refusal error includes the list's symbol_count so the caller sees what's at stake. Do not remove this guard without a better replacement.

**Tool matrix:**

| Tool | Priority | Method + path | Notes |
|---|---|---|---|
| `watchlist_list` | P1 | GET `/all/` | Includes custom+colored; `include_symbols:true` for full arrays |
| `watchlist_switch` | P0 | POST `/active/{id_or_color}/` | Accepts list name or color; case-insensitive |
| `watchlist_remove` | P0 | POST `/custom/{id}/remove/` body `["SYM",...]` | Defaults to active list; `from` targets other |
| `watchlist_create` | P1 | POST `/custom/` body `{name, symbols}` | Returns new id |
| `watchlist_rename` | P2 | POST `/custom/{id}/rename/` body `{name}` | Refuses colored (built-in) |
| `watchlist_delete` | P2 | DELETE `/custom/{id}/` | Requires `confirm_name` AND not-active (unless `confirm_active:true`); refuses colored |

**Smoke-test** (8 cases, live against TV 3.1.0.7818, 2026-04-21): all 8 pass including three refusal paths — delete-while-active (soft-refuse), delete-colored (soft-refuse), delete-without-confirm-name (hard-refuse). Guard verification on `watchlist_delete`: 3/3 pass (empty confirm → refuse, wrong-name confirm → refuse, matching confirm → succeed).

**Files touched:** `src/core/watchlist.js` (extended), `src/tools/watchlist.js` (6 new tool registrations).

**Spec:** `ASTA ECO4/system-design/MCP_WATCHLIST_MGMT_SPEC.md`.

---

### 6. `hotlist_get` — TradingView Hotlists (scanner presets) exposed as MCP tool

**Gap:** Skills had no way to discover market-moving tickers to seed `🌍 02 MASTER` / `🐻 06 BEAR`. We were relying on static hand-curated symbol lists that go stale within a week. TV's own right-rail **Hotlists** widget fetches dynamic scanner presets by category (volume gainers, % change gainers/losers, gap gainers/losers, etc.) with no auth, but nothing in the MCP surface exposed them.

**Discovery:** Installed a `fetch` interceptor via `ui_evaluate` and clicked the Hotlists tab in the TV UI. Captured:

```
GET https://scanner.tradingview.com/presets/US_{slug}?label-product=right-hotlists
Response: {
  totalCount: <int>,           // size of the underlying universe
  fields:     ["volume"],      // the sort column
  symbols:    [{s:"NASDAQ:NVDA", f:[<val>]}, ...],  // 20 rows max
  time:       <ms>
}
```

`scanner.tradingview.com` is cross-origin from `www.tradingview.com` but a simple GET with no custom headers needs no preflight. No credentials, no Content-Type — just works.

**9 working slugs** (probed live 2026-04-22):

| Direction | Slug | Sort column |
|---|---|---|
| Bull | `volume_gainers` | volume |
| Bull | `percent_change_gainers` | change |
| Bear | `percent_change_losers` | change |
| Bull | `percent_range_gainers` | change_from_open |
| Bear | `percent_range_losers` | change_from_open |
| Bull | `gap_gainers` | gap_up_abs |
| Bear | `gap_losers` | gap_down_abs |
| Bull | `percent_gap_gainers` | gap_up |
| Bear | `percent_gap_losers` | gap_down |

**Tool:** `hotlist_get(slug, limit=20)`. Pure REST, no DOM, no auth. New files: `src/core/hotlist.js`, `src/tools/hotlist.js`. Registered in `src/server.js`. Input validated against a whitelist (rejects unknown slugs) and `limit` is capped at 20 (TV page size).

**Why this matters:** Enables `scripts/refresh_master.py` to refresh 🌍 02 MASTER (bull) + 🐻 06 BEAR (bear) nightly from live market activity, then `/watchlist-scan` triages each side. Full autonomy from static lists.

---

### 7. `aed8ad2` — `quote_get` symbol-param bug (cross-symbol routes via scanner REST)

**Bug:** `quote_get({symbol:X})` read bars/symbolExt from the **active chart** regardless of the requested symbol, then pasted the requested symbol into the response envelope. Caller got X's name with some-other-ticker's OHLC. Silent wrong-ticker pricing — worst affected `/decay-check`, which would mis-classify every open invalidation rule using one ticker's price across all entries.

**Live-caught 2026-04-23** mid-pipeline. Repro: load `BATS:INTU`, call `quote_get(symbol="NASDAQ:TSCO")` — returned INTU's $383 close with `symbol:"NASDAQ:TSCO"` and `description:"Intuit Inc."`. Same result for any symbol passed.

**Root cause:** `src/core/data.js::getQuote()` set `sym = request_symbol || api.symbol()` and placed it in the envelope, but then read `bars = ${BARS_PATH}` (active chart's main series) and `ext = api.symbolExt()` (active chart's metadata). The `sym` variable was cosmetic; the data always came from the active chart widget.

**Diagnostic method:** Grep for the tool name → read the body of `getQuote()` → contradiction visible in one pass (envelope-field set from input, data-fields read from active chart). Live-probed the fix target by stashing a fetch result on `window.__t35_probe` and polling — confirmed the scanner endpoint wire format before writing the patch.

**Wire format** (probed live):

```
POST https://scanner.tradingview.com/america/scan
Body: {"symbols":{"tickers":["NASDAQ:TSCO","NASDAQ:AAPL","NASDAQ:NVDA"]},
       "columns":["close","open","high","low","volume","description","exchange","type"]}
No Content-Type header (cross-origin — same CORS gotcha as alerts.js).
Response: {"totalCount":3,"data":[{"s":"NASDAQ:TSCO","d":[38.17,38.98,38.98,38.04,11360613,"Tractor Supply Company","NASDAQ","stock"]}, ...]}
```

**Fix:** New `getQuoteViaScanner(symbol)` helper hits the scanner endpoint. `getQuote()` compares the requested symbol (uppercased/trimmed) against `api.symbol()`. If they match or `symbol` is omitted → active-chart path (keeps the bid/ask DOM scraping). If they differ → scanner path. Response adds `source: "scanner_rest" | "active_chart"` for debugging.

**Files touched:** `src/core/data.js` (+84 lines). Tool signature unchanged — no `src/tools/data.js` change needed.

**Node-check:** passes. **Live smoke:** 3/3 green post-restart 2026-04-23. On `BATS:INTU`: `quote_get(symbol="NASDAQ:TSCO")` → "Tractor Supply Company" close $38.17 `source:"scanner_rest"`; `quote_get(symbol="NASDAQ:AAPL")` → "Apple Inc." close $273.43 `source:"scanner_rest"`; `quote_get()` no-arg → INTU $383.30 `source:"active_chart"`. Cross-symbol envelope mismatch resolved.

---

### 8. `watchlist_insert` — REST-safe targeted-add (replaces DOM `watchlist_add` for race-free inserts)

**Gap:** The upstream `watchlist_add` types into the sidebar search box via CDP keyboard events, so adds always land on whichever list is **visibly open** in the UI, not whatever `watchlist_switch(name=X)` flagged active via REST. Any user click on a different sidebar tab during a skill run routed adds to the wrong list. The original workaround — `watchlist_delete` + `watchlist_create(symbols=[...])` — is race-free but assigns the recreated list a **new id**, which in TV drops it out of the user's pin/favorite sidebar order. Observed live (Session 20, 2026-04-24): repeated pin-order breakage on `/refresh-movers` runs forced the user to re-pin watchlists every session.

**Diagnostic method:** Same interceptor playbook as `alert_create` / `alert_delete` / watchlist-mgmt. Installed `fetch` + `XMLHttpRequest` interceptor via `ui_evaluate` stashing requests on `window.__t37_capture`, switched the UI to the empty `🐂 02 BULL` list via `watchlist_switch`, asked the user to manually add `NASDAQ:AAPL` via the sidebar "+" button, then polled the capture. Captured wire format on TV Desktop 3.1.0.7818:

```
POST https://www.tradingview.com/api/v1/symbols_list/custom/{id}/append/?source=web-tvd
Content-Type: application/json
Body: ["NASDAQ:AAPL"]
Response: HTTP 200 (empty body)
```

Exactly the mirror of `/remove/`: same same-origin endpoint, same numeric-id targeting, same array body. `Content-Type: application/json` is required (consistent with the other `/symbols_list/` mutations) and the existing `tvRest()` helper sets it automatically for bodied requests.

**Fix:** New `appendSymbols({ symbol, symbols, to })` in `src/core/watchlist.js` — cloned from `removeSymbol()` with `/remove/` → `/append/` and the response key renamed. New `watchlist_insert` tool registered in `src/tools/watchlist.js` with `symbol` / `symbols` / `to` params (same signature shape as `watchlist_remove`). DOM `watchlist_add` kept in place for backward compatibility but skills should switch to `watchlist_insert`.

**Tool matrix delta:**

| Tool | Method + path | Notes |
|---|---|---|
| `watchlist_insert` (new) | POST `/custom/{id}/append/` body `["SYM",...]` | Race-free mirror of `watchlist_remove`; defaults to active list; `to` targets other |

**Files touched:** `src/core/watchlist.js` (+62 lines), `src/tools/watchlist.js` (+14 lines).

**Node-check:** passes on both files. **Live smoke:** deferred to post-restart (requires Claude Code restart to reload MCP process and register `watchlist_insert`).

---

## §9 — `scanner_enrich`: batch price/volume/market-cap enrichment (T26, 2026-04-24)

**Why:** `/refresh-movers` populates 🐂 02 BULL + 🐻 06 BEAR from the raw TV hotlist presets. Hotlists are great at finding *movers* but terrible at finding *tradeable* movers — today's 9-hotlist scan surfaced LIDR ($1.40), SMX (<$1), OIO ($1), TRUG, WNW, ZTG, SIDU — pump/penny tickers that ASTA quality gates will never allow a trade on. Triaging them with `/find-setups` burns ~40 Claude calls per sweep with a foregone-conclusion SKIP verdict. User directive (Session 20): "we are not going to look at anything under $10 and we need a certain amount of volume." Filed as T26 in TASKS.md.

**Chosen path:** Enrich every unique candidate symbol in ONE cross-origin POST to `scanner.tradingview.com/america/scan` — the same endpoint T35 fixed `quote_get` to route through, so we already know the CORS rules (plain-string body, no `Content-Type`). The scanner returns any columns you ask for; for T26 we request `close` + `average_volume_30d_calc` + `market_cap_basic` + `description`. Python-side filter then drops anything below `price $10 / avg_vol 1M / mcap $1B` BEFORE the vote-rank dedup — a 4-vote pump loses to a 1-vote real name.

**Wire format** (mirror of T35's `getQuoteViaScanner`):
```
POST https://scanner.tradingview.com/america/scan
Body (plain-string, no Content-Type):
  {"symbols":{"tickers":["NASDAQ:AAPL","NASDAQ:SMX",...]},
   "columns":["close","average_volume_30d_calc","market_cap_basic","description"]}
Response: {"data":[{"s":"NASDAQ:AAPL","d":[180.5, 51000000, 2.8e12, "Apple Inc."]}, ...]}
```

**Fix:** New `enrichSymbols({ symbols })` in `src/core/data.js` — cloned structurally from `getQuoteViaScanner` (T35) but with a batched request body and a keyed-by-upper-symbol output shape. New `scanner_enrich` tool registered in `src/tools/data.js` with `symbols[]` param (z.array). Cap 500 symbols per call. Returns `{ success, count, requested, missing[], enriched{SYMBOL:{close,avg_vol_30d,market_cap,description}}, source:"scanner_rest" }`. Non-US / OTC / delisted tickers end up in `missing[]` — skill can surface them without treating as drops.

**Tool matrix delta:**

| Tool | Method + path | Notes |
|---|---|---|
| `scanner_enrich` (new) | POST `scanner.tradingview.com/america/scan` body `{symbols:{tickers:[…]},columns:[…]}` | Cross-origin, no `Content-Type`. Up to 500 per call. Powers T26 pre-3Cs quality gate. |

**Files touched:** `src/core/data.js` (+94 lines for `enrichSymbols` + export), `src/tools/data.js` (+7 lines for tool registration).

**Node-check:** passes on both files. **Live smoke:** deferred to post-restart (requires Claude Code restart to reload MCP process and register `scanner_enrich`).

**Python-side companion:** `scripts/refresh_movers.py` gained an optional `enriched` input key, `MIN_PRICE=10.0 / MIN_AVG_VOL_30D=1M / MIN_MARKET_CAP=1B` constants, pre-dedup filter, and output fields `filter{thresholds,dropped,dropped_count,no_enrichment_data}` + `warnings[]`. 26/26 unit tests pass (15 existing back-compat + 11 new T26 cases covering: no-enrichment back-compat, each threshold, multi-failure, pre-dedup ordering, case-insensitive keys, exclude-takes-precedence, under-cap warning, full-cap clean).

---

## §10 — `pine_save_source` + `pine_get_source_rest`: Pine round-trip via REST (T74, 2026-04-26)

**Why:** The Monaco-based `pine_set_source` / `pine_get_source` / `pine_save` toolchain has been a recurring blocker — diagnosed root cause during T74 was that TV lazy-mounts Monaco only when the Pine Editor pane is **visibly expanded**, and the existing `ensurePineEditorOpen` only knew how to expand the **bottom widget bar**. User's actual layout is the **side-docked Pine Editor** (data-uri ends in `editorType=dialog`) — a completely different surface that `bwb.setMode()` doesn't reach. Patching `ensurePineEditorOpen` to handle every layout would have been whack-a-mole + still slow (≤10s polling per `pine_set_source`). User explicitly requested a rethink: "lets find a better solution."

**Pivot:** TradingView's Pine UI itself talks to a REST API (`pine-facade.tradingview.com`). The fork already used pine-facade for `pine_list_scripts` (GET `/list/`), `pine_open` (GET `/get/{id}/{ver}`), and `pine_check` (POST `/translate_light` for server-side compilation). The missing piece was the SAVE endpoint — captured live during T74:

```
POST https://pine-facade.tradingview.com/pine-facade/save/next/USER%3B{id}
     ?allow_create_new=false&name={url-encoded-name}
Content-Type: application/x-www-form-urlencoded
Body: source=<full Pine source>
Response: {"success":true, "result":{"IL":"<encrypted-blob>"}}
```

Same auth profile as the existing pine-facade calls — cookie auth via `credentials: 'include'`, no CSRF token, no session header. The `IL` field is TV's signed/encrypted form of the source (used by chart-side verification); we don't inspect it.

**Diagnostic method:** Same fetch+XHR interceptor playbook as `alert_create` / `alert_delete` / `watchlist_insert` / `scanner_enrich`. Installed interceptor on `pine-facade.tradingview.com` + `tradingview.com` POST/PUT/PATCH/DELETE traffic via `ui_evaluate`, stashed captures on `window.__T74_save_capture`, asked user to make a tiny edit in the side-docked Pine Editor and Ctrl+S, polled the capture. TV's UI made 3 calls during a save: (1) `/parse_title` (extract title from source — we skip this; we already know the title), (2) `/save/next/USER;{id}` (the real save — the captured payload), (3) `telemetry/pine/report` (analytics — we skip).

**Fix:**
- New `saveSource({ id, name, source })` in `src/core/pine.js` (~80 lines). Resolves `id` from `name` via the same pine-facade `/list/` lookup that `openScript` uses. POSTs URL-encoded form data to `/save/next/USER;{id}` with `credentials: 'include'`. Returns `{success, id, name, source_lines, source_chars, has_il_blob}`.
- New `getSourceByREST({ id, name, version })` in `src/core/pine.js` (~50 lines). Mirrors `saveSource`'s id-resolution; GETs from `/get/{id}/{ver}`. Replaces the Monaco-based `getSource()` for the round-trip case. Returns `{success, id, name, version, source, line_count, char_count}`.
- Registered as new MCP tools `pine_save_source` and `pine_get_source_rest` in `src/tools/pine.js` (~26 lines). Both accept either `id` (preferred) or `name`. Tool descriptions explicitly note "no Monaco editor required" so callers know they can use these regardless of editor pane layout.

**Workflow change for skills + RULEBOOK:**

Old (Monaco-driven, fragile, slow):
```
pine_open → pine_set_source → pine_smart_compile → pine_save → pine_list_scripts (verify)
```

New (REST, layout-agnostic, sub-second):
```
pine_check (server-side compile, optional gate)
→ pine_save_source (single REST call)
→ chart_manage_indicator (remove + re-add to pick up new version on chart)
→ data_get_pine_tables (verify)
```

The Monaco-based tools (`pine_set_source`, `pine_get_source`, `pine_compile`, `pine_get_errors`, `pine_save`, `pine_get_console`, `pine_smart_compile`) are kept in place for callers that genuinely want them, but skills should default to the REST path going forward.

**Tool matrix delta:**

| Tool | Method + path | Notes |
|---|---|---|
| `pine_save_source` (new) | POST `/pine-facade/save/next/USER;{id}` body `source=<...>` | Layout-agnostic; no Monaco; sub-second. Replaces `pine_set_source` + `pine_save`. |
| `pine_get_source_rest` (new) | GET `/pine-facade/get/{id}/{ver}` | Replaces Monaco-based `pine_get_source`. |

**Files touched:** `src/core/pine.js` (+135 lines for `saveSource` + `getSourceByREST`), `src/tools/pine.js` (+18 lines for two tool registrations).

**Follow-up patch — 771fa38 (2026-04-26):** Live smoke on the original `1e9ef2b` exposed two bugs that blocked round-trip. Both fixed in `771fa38`:

1. **Cookie scope.** The functions called node-side `fetch()` against `pine-facade.tradingview.com`, which has no TradingView session cookie. pine-facade therefore returned an anonymous (empty) saved-scripts list and id/name lookup always failed with "Script ... not found in pine-facade list." Fix: route the entire fetch chain (list + get/save) through `evaluateAsync` so it runs in the live TV page context with `credentials: 'include'`. Same pattern that `openScript` and `listScripts` already use.
2. **Double `USER;` prefix on save URL.** `scriptIdPart` from pine-facade already contains the `USER;` prefix verbatim, but the original code prepended a hardcoded `USER%3B` before the resolved id, producing `/save/next/USER;USER;{hex}`. TV is tolerant in practice (both forms hit the same script), but the canonical form is single-prefix. Fix: drop the hardcoded prefix; just `encodeURIComponent(scriptId)`.

Both bugs were diagnosed in-page via `ui_evaluate`: confirmed `scriptIdPart` shape from the live `/pine-facade/list/` response, then identity-wrote the dashboard's own source back via the single-prefix URL form (status 200, `{success:true, result:{IL:"..."}}`, version bumped 48.0→49.0). `node --check` passes after the patch.

**Live smoke:** deferred to next Claude Code restart so the patched MCP server reloads. Smoke matrix: round-trip on `asta_3cs_dashboard.pine` (~30KB / 856 lines) AND `asta_patterns.pine` (~50KB / 1200 lines — largest script in our indicator set).

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
