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

**Part A: `data_get_pine_labels` default cap.** Before: `max_labels || 50` in `src/core/data.js:389`. Dense indicators (complex multi-output dashboards, multi-EMA dashboards) routinely emit 100+ labels; the 50-cap silently dropped the earliest ones — which are often foundational (Fib levels, pivot prices, EMA tags) — while retaining only the latest dynamic event labels. After: default raised to 500, plus a new `truncated: boolean` field on each study entry so callers can detect truncation without comparing `showing` vs `total_labels`.

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

**Spec:** downstream consumer's watchlist-management spec.

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

**Gap:** The upstream `watchlist_add` types into the sidebar search box via CDP keyboard events, so adds always land on whichever list is **visibly open** in the UI, not whatever `watchlist_switch(name=X)` flagged active via REST. Any user click on a different sidebar tab during a skill run routed adds to the wrong list. The original workaround — `watchlist_delete` + `watchlist_create(symbols=[...])` — is race-free but assigns the recreated list a **new id**, which in TV drops it out of the user's pin/favorite sidebar order. Observed live (2026-04-24): repeated pin-order breakage on `/refresh-movers` runs forced the user to re-pin watchlists every session.

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

**Why:** `/refresh-movers` populates 🐂 02 BULL + 🐻 06 BEAR from the raw TV hotlist presets. Hotlists are great at finding *movers* but terrible at finding *tradeable* movers — today's 9-hotlist scan surfaced LIDR ($1.40), SMX (<$1), OIO ($1), TRUG, WNW, ZTG, SIDU — pump/penny tickers that downstream quality gates will never allow a trade on. Triaging them with `/find-setups` burns ~40 Claude calls per sweep with a foregone-conclusion SKIP verdict. Operator directive: "we are not going to look at anything under $10 and we need a certain amount of volume." Filed as T26 in downstream task tracker.

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

**Live smoke (2026-04-26 post-restart):** all green. key_levels (8KB) `8.0→9.0`; dashboard (53KB / 856 lines) `49.0→50.0` with `data_get_pine_tables` returning canonical 16 panel rows on SNDK; Patterns (72KB / 1201 lines) `30.0→31.0`; negative test on bogus name returns clean `{success:false}`. All saves returned `has_il_blob:true` (TV server-side compile clean).

**Follow-up — 6f5cb8b (2026-04-26): UI sidebar auto-refresh on watchlist mutations.** Symptom: after `watchlist_insert` / `watchlist_remove` / `watchlist_create` / `watchlist_rename` / `watchlist_delete` REST calls, the change persisted server-side but TV's sidebar didn't show it until the user manually clicked the affected list. Same root cause as the pine save UI bug, different surface: TV's UI handlers do BOTH the REST POST and a local Redux dispatch, but our REST tools only did the POST.

**Diagnosis** via webpack-chunk introspection (`window.webpackChunktradingview` push trick to capture `__webpack_require__`):
- `SymbolListService` is registered with the service-locator (chunk 20/257/341/382 mod 138654, exports `{service, hasService, registerService, unregisterService, waitServiceRegistered}`) under id `{ id: 'SymbolListService' }`.
- The service's `.store` is a Redux store; sidebar reads `state.customLists.lists.byId[listId].symbols`.
- The custom-lists slice (chunk 114 mod 230211, slice name `"custom-lists"`) exposes action types: `insert` (add symbols), `exclude` (remove symbols — NOT `remove`!), `create`, `remove` (delete WHOLE list), `rename`, `put`, `replace`, `exact`, `setup`, `share`, `changeDescription`, `updatePersistedState`.
- Action payloads need `actionTimestamp: Date.now()` to win over the list's own `lastChangeTimestamp` guard.
- Plain action-object dispatch (no module imports needed) updates the local store immediately and triggers React re-render. Empirically confirmed: 0 mirror REST fetches fired during dispatch.

**Fix:** Added `syncCustomListsStore(actionType, payload)` helper to `src/core/watchlist.js` that runs in-page via `evaluateAsync`, captures `__webpack_require__` from a one-shot chunk push (cached on `window.__tv_mcp_req`), resolves the service locator (cached on `window.__tv_mcp_locator` — tries module id 138654 first, falls back to scanning `req.cache` for any module exporting the locator surface), looks up `SymbolListService`, and dispatches a plain action object onto its store. Returns `{ ui_synced: bool, reason?: string }` — never throws; degrades to legacy "click to refresh" behavior on any failure.

Wired into all five mutators (`removeSymbol` → `exclude`, `appendSymbols` → `insert`, `create` → `create`, `rename` → `rename`, `deleteList` → `remove`). Each tool's response now carries `ui_synced` / `ui_sync_reason` fields so callers can tell if the sidebar auto-refreshed.

**Live verification** (in-page IIFE simulating the patched flow, 2026-04-26): added `NASDAQ:META` to HOT via REST POST + dispatch — user visually confirmed META appeared in the sidebar without clicking. Cleanup via REST DELETE + `exclude` dispatch removed it instantly. `node --check src/core/watchlist.js` passes.

**Follow-up patch — 05f441f (2026-04-26): `scriptName` corruption fix.** Live smoke uncovered a third regression: `pine_save_source` called id-only was rewriting the cloud script's `scriptName` field to the script id (e.g. `"USER;d101351..."`). Cause: the `name=` URL param on `/pine-facade/save/next/{id}` is **not cosmetic** — pine-facade overwrites the saved script's `scriptName` with whatever value the param carries. The original `doSave` defaulted `displayName` to `scriptId` when no name was provided, silently corrupting the name. After 3 saves during T74 smoke (dashboard, key_levels, Patterns), all three scripts in the user's TV "My Scripts" sidebar showed `USER;<hex>` instead of friendly names. Volume Confirmation, untouched, still showed correctly — confirming the bug was per-call, not session-wide cache pollution.

**Recovery:** A one-shot `ui_evaluate` script restored all 3 names by re-fetching each script's current source (via `/pine-facade/get/{id}/last`) and re-saving with the correct `name=` value. Three sub-second round-trips, source never crossed the MCP boundary. All names verified restored via `pine_list_scripts`.

**Fix:** Patched `doSave` in `src/core/pine.js` so it requires a resolved `displayName` and refuses to fall back to `scriptId`. The id branch now performs a `pine-facade/list/` lookup when the caller doesn't supply a name, extracting the current `scriptName` to preserve it. Caller-supplied name still wins (explicit rename intent). The name branch already used `match.scriptName || match.scriptTitle` correctly — kept verbatim. Added a defensive `if (!displayName) return { error: ... }` guard inside `doSave` so future regressions fail loudly instead of silently corrupting names. `node --check` passes.

---

## §11 — `removeSymbol` exchange-prefix matcher (T58, 2026-05-08)

**Bug class:** `watchlist_remove(symbol="TSM", from=L)` against a list storing `"NYSE:TSM"` returned `success:true, removed_count:1` even though the TV REST endpoint silently no-op'd (it only matches the exact stored form, prefix-included). Symmetric in the opposite direction (`"NASDAQ:TSM"` requested against a list storing bare `"TSM"`). The function had no view of what was actually targeted server-side — it echoed the caller's input back as `removed_symbols` and called the count from `toRemove.length`. Skills relying on the count to gate further action (decay sweeps, mover refreshes, journal mutators) would proceed as if a removal happened. Filed as T58 after the silent-success was caught by hand on a `/decay-check` mutation.

**Diagnostic method:** Replayed the failing case against `🎯 03 FOCUS` (3 prefixed symbols `NASDAQ:MXL`, `NASDAQ:LBRDK`, `NYSE:NOW`) with `watchlist_remove(symbol="NOW", from="🎯 03 FOCUS")` — got `removed_count:1` but `watchlist_list(include_symbols:true)` immediately after still showed all 3 symbols. Confirms the no-op + false-success at the wire level. The fix doesn't need a wire capture: `listAll()` already returns the list's stored `symbols:[…]` array for free, so we can do the resolution client-side.

**Fix:** Pre-resolve each requested symbol against `target.symbols` before issuing the POST. Resolution order per requested entry:
1. Exact case-insensitive match → push the stored form.
2. If requested is bare (`"TSM"`) → look for any stored `"EXCHANGE:TSM"` and push that.
3. If requested is prefixed (`"NASDAQ:TSM"`) → strip prefix, look for stored bare `"TSM"`.
4. No match → push to `not_found[]`, exclude from POST.

If `resolved.length === 0` → skip the POST entirely and return early with `removed_count:0` + the full `not_found[]`. Otherwise POST `resolved` (not the original `toRemove`), and dispatch the in-memory `custom-lists/exclude` action with `resolved` too so the UI store stays consistent with what the server actually saw. Response shape: `removed_symbols` is now the **resolved** server-side forms; `removed_count` reflects what was targeted; `not_found[]` is included only when non-empty (existing-call back-compat).

**Files touched:** `src/core/watchlist.js` (+64 / −4 lines, all in `removeSymbol`).

**Node-check:** passes.

**Live smoke (2026-05-08 post-restart):** 5/5 green against `🎯 03 FOCUS`:
1. `watchlist_remove(symbol="NOW", from="🎯 03 FOCUS")` → `removed_symbols:["NYSE:NOW"]`, `removed_count:1` (auto-qualified bare→prefixed). ✅
2. `watchlist_list(include_symbols:true)` → `NYSE:NOW` absent (2 symbols left). ✅
3. `watchlist_remove(symbol="FAKETICKER", from="🎯 03 FOCUS")` → `removed_count:0`, `not_found:["FAKETICKER"]`, no POST sent (verified via list still 2 symbols). ✅
4. `watchlist_insert(symbol="NYSE:NOW", to="🎯 03 FOCUS")` → restored. ✅
5. `watchlist_list(include_symbols:true)` → back to 3 symbols `[NASDAQ:MXL, NASDAQ:LBRDK, NYSE:NOW]`. ✅

The previous silent-success class is closed: any caller can now trust `removed_count` as ground truth and react to `not_found[]` for partial-match audits. Skills that expected to see a `not_found` field on no-op should note: it's only included when non-empty (a clean removal with zero misses returns the same shape as before — no breaking change).

---

## Adding more fixes — workflow

The diagnostic playbook lives in the downstream consumer's `CLAUDE.md`. Summary:

1. Reproduce the bug, capture exact response.
2. `Grep` the tool name or symptom to find the source file in `src/core/`.
3. Probe root cause with `ui_evaluate` (DOM inspection, TV internal API exploration, or REST interceptor + manual UI trigger).
4. Write a surgical patch; one concern per commit; always document _why it was broken_ in the commit message.
5. `node --check src/core/<file>.js` before commit.
6. Restart Claude Code; smoke-test the fix with a real chart loaded.
7. Commit on `fixes/draw-api-resolve`, push to `origin`.
8. Update this file + the "Known limitations" section in your downstream CLAUDE.md.
9. (Optional) File upstream issue with repro + link to our commit.

## Tests

38/38 sanitization tests pass after all three patches. Run: `node --test tests/sanitization.test.js`.

The `source audit — no unsafe interpolation patterns` test case has a pre-existing Windows path-handling bug in its setup (constructs `C:\C:\...`) — it fails at the suite-setup stage, not because any real test failed. Not caused by our patches; ignore.

## Staying in sync with upstream

Periodic rebase pattern:

```bash
cd ~/tradingview-mcp   # or wherever you cloned the fork
git fetch upstream
git checkout fixes/draw-api-resolve
git rebase upstream/main
# resolve conflicts if any
git push origin fixes/draw-api-resolve --force-with-lease
```

If upstream merges PR #62, drop our `285587d` commit during rebase (git should auto-detect the duplicate). Our `80a69eb`, `33b578b`, and `9d05087` should stay separate; they're not upstream.

---

### 9. `pine_refresh_catalog` — bust TV's chart-side My-scripts metaInfo cache (T107)

**Bug:** TV Desktop's Indicators dialog holds a one-shot Promise in `TradingViewApi._studyMarket._dialog._initIndicatorsPromises.userScriptsPromise` that was settled at chart-page load time. After `pine_save_source` REST-saves a new script version, the cached promise is still the stale resolved value from page-load — and `_studies['Script$USER']` (which feeds `chart.createStudy()`) is rebuilt only from that cached promise. Result: post-save `chart_manage_indicator(remove + add)` cycles serve the OLD compiled IL roughly 60% of the time. Hit on T67, T90, T51, T102, T103, T104, T74, T85, T91, T97, T92, T95, T98 (13+ ships requiring manual UI re-add to bust the cache).

**Diagnosis credit:** Upstream PR #152 commit `63fe862` by `taiwor88` (open, unmerged as of 2026-05-13). Investigation found `resetCache()` / `getStudiesList()` are `$t()` stubs that throw; `resetAllStudies()` clears `_studies` but reuses the same cached promises so the cache repopulates with stale data. The only method that actually rebuilds `_studies['Script$USER']` from a fresh REST hit is `_dialog._updateUserStudies()` — but only if `userScriptsPromise` is replaced first.

**Fix:** Cherry-pick `refreshCatalog()` + tool registration from PR #152 (NOT the full PR — it bundles 8 unrelated defects; we take only the cache-bust). New MCP tool `pine_refresh_catalog`:
1. Overwrite `_initIndicatorsPromises.userScriptsPromise` with a fresh `fetch('/pine-facade/list/?filter=saved', {credentials:'include'}).then(r => r.json())`.
2. Call `_dialog._updateUserStudies()` and await its completion — rebuilds `_studies['Script$USER']` from the new promise.
3. Return `{success, cache_before_count, cache_after_count, delta, scripts[{id,title}]}`.

Sub-second. No page reload. No UI flash. Routes through `evaluateAsync` so the TV session cookie is in scope (same lesson as T74 follow-up `771fa38`).

**Probe (2026-05-13)** — validated against live **TV Desktop 3.1.0 / Electron 38.2.2 / Chromium 140** that every required path exists. Re-verified `userScriptsPromise` is a Promise; `_updateUserStudies` is a function; `_studies['Script$USER']` is accessible (6 entries at probe time). No fallback needed; mechanism ports directly.

**Files touched:** `src/core/pine.js` (refreshCatalog function added after listScripts, ~95 LoC including the verbatim diagnostic comment from PR #152), `src/tools/pine.js` (server.tool registration after pine_list_scripts, ~8 LoC).

**Caveat from PR #152 author** — fixes the *catalog* half (script appears in dialog). The author notes `chart.createStudy`/`insertStudy` IL-selection-time half "silently fails" is flagged as a separate unresolved defect. T110 (Block H follow-up) wraps `pine_save_source` + `pine_refresh_catalog` + `chart_manage_indicator(remove + add)` + verify + retry in a `withPineSave` orchestrator to handle any residual race.

**Usage pattern (replaces manual RULEBOOK §11 step 5):**
```
pine_save_source({ id, source })
pine_refresh_catalog()
chart_manage_indicator({ action: "remove", entity_id: <study_id> })
chart_manage_indicator({ action: "add", indicator: "<My Indicator>" })
data_get_pine_tables({ study_filter: "<My Indicator>" })  // verify fresh IL via panel content
```

**Source:** Upstream PR https://github.com/tradesdontlie/tradingview-mcp/pull/152 commit `63fe862`. Cherry-picked verbatim with port to pine.js (upstream PR placed it in alerts.js — incidental, given PR bundles unrelated fixes).

---

### 10. `chart_manage_indicator(add)` — user-script descriptor + Escape recovery (T108, 2026-05-13)

**Bug 1 (root cause):** `src/core/chart.js` `manageIndicator()` add path called `chart.createStudy(<bare title string>, false, false, inputArr)` for ALL indicators. TV accepts a bare title only for built-ins (which have an internal name→token map for `"Volume@tv-basicstudies-241!"` etc.). For user scripts, `createStudy` rejects the bare title with `Error: unexpected study id:<lowercased input>`. The only accepted shape for user scripts is the `studyData.descriptor` OBJECT reached through `TradingViewApi._studyMarket._dialog._studies['Script$USER']` (populated by `_updateUserStudies()` — T107's mechanism).

Verified during T107 smoke 2026-05-13 (custom BB v1.1.4 on HWM-D, post-T107 cache refresh):
- `chart.createStudy("MyCustomBB", false, false, [])` → throws `unexpected study id:mycustombb`.
- `chart.createStudy(bb.studyData.descriptor, false, false, [])` → resolves to entity `s0ZGgl` named "MyCustomBB v1.1.4" first try.

This bug **pre-existed T107** — `chart_manage_indicator(add)` has always returned `success:false` for user scripts. The codebase's coping strategy was "ask operator to manually re-add via Indicators dialog" (cited in CLAUDE.md MCP recipes and in several skill workflows).

**Bug 2 (upstream Issue #142):** add-path failure leaves TV's Indicators-dialog modal stuck open. Subsequent automation calls fail until operator manually presses Escape. Surgical fix: dispatch synthetic Escape via CDP `Input.dispatchKeyEvent` on any failure path.

**Fix:** Rewrote the `add` branch of `manageIndicator()` to:
1. Run a single `evaluateAsync` that:
   a. Snapshots `getAllStudies()` ids before.
   b. Looks up `_studies['Script$USER']` for a case-insensitive title match. If empty, internally repeats T107's cache-populate (replace `userScriptsPromise` + `await _updateUserStudies()`) and retries.
   c. If matched → `firstArg = match.studyData.descriptor`; `resolution = 'descriptor'`. Else → `firstArg = <bare title>`; `resolution = 'fallback'`.
   d. Calls `chart.createStudy(firstArg, false, false, inputArr)`. For user scripts the return is a Promise (awaited); for built-ins it's synchronous.
   e. `await sleep(1500ms)`, snapshots `getAllStudies()` again, computes `newIds` diff.
2. On success (`newIds.length > 0`) → returns `{success:true, entity_id, new_study_count, resolution}`.
3. On failure → dispatches Escape via CDP `Input.dispatchKeyEvent` (pattern from `watchlist.js:731-732`) to clear stuck dialog state, returns `{success:false, error, recovery_attempted:true, resolution}`.

Single `evaluateAsync` round-trip replaces the prior three-call dance (before-snapshot + createStudy + after-snapshot with node-side sleep). Cleaner; same effective timing.

**Response shape additive** — existing callers see `success / action / indicator / entity_id / new_study_count` unchanged. New optional fields: `resolution: "descriptor" | "fallback"`, `error`, `recovery_attempted`.

**Files touched:** `src/core/chart.js` `manageIndicator()` add branch (~85 LoC).

**Source:** Bug 1 self-diagnosed during T107 smoke. Bug 2 cherry-pick of approach from [tradesdontlie/tradingview-mcp Issue #142](https://github.com/tradesdontlie/tradingview-mcp/issues/142) (no upstream patch shipped — only the Escape recovery technique is re-used; pattern was already present in our own `watchlist.js:731-732` for sidebar Add-Symbol).

---

### 11. Upstream cherry-pick batch (T109, 2026-05-13)

Five surgical cherry-picks landed from the open-PR triage at `system-design/research/upstream-pr-triage-2026-05-13.md`. Each is a separate commit on `fixes/draw-api-resolve` so they can be rebased / dropped individually if upstream merges them. PR #143 / Issue #141 are issues, not PRs; #143 was confirmed and fixed with our own patch; #141 was repro'd and found WORKING (no fix needed).

| Pick | Source | Commit | Files | Risk | Summary |
|---|---|---|---|---|---|
| A | upstream PR #148 `e177b56` | `b542b34` | `capture.js`, `tools/capture.js`, `wait.js` | LOW | `wait_for_render:true` opt-in on `capture_screenshot`. Polls canvas+symbol+resolution for 3 stable polls or 5s timeout. Closes upstream Issue #144 (stale-frame after `chart_set_symbol`). BOM bytes stripped post-pick. |
| B | upstream PR #117 `b64b2e0` + `264a55c` | `76cdc7e` | `chart.js`, `capture.js`, `tools/capture.js` | LOW-MED | `chart_scroll_to_date` now drives TV's native "Go to date" (Alt+G) dialog instead of `timeScale.zoomToBarsRange` (worked only for loaded bars). New `strategy` field in response. Plus `out_dir` / `path` params on `capture_screenshot`. Merged with pick A's `wait_for_render`. Skipped commit `2df3c93` (DI fix on getVisibleRange/symbolInfo) — deferred to T111. |
| C | Issue #143 — own fix | `08d44f5` | `data.js` `getStudyValues()` | LOW | `data_get_study_values` now returns `entity_id` and a normalized `inputs` map per study, so same-name studies (e.g. multiple EMAs) are disambiguable. Live repro confirmed 3× EMAs at L=5/13/200 came back as 3 identical entries pre-fix; post-fix shape additive (old `name`/`values` retained). |
| D | Issue #141 — verified WORKING | — | — | — | `chart_manage_indicator(add, inputs={length:N})` DOES apply the input — probe confirmed `propState.inputs.length.value = N` on the created study. The user-reported behavior was actually the dataWindowView staleness bug (separate, deferred). No fix needed. |
| E | upstream PR #133 `577f907` + `0887394` + `635da77` | `eea9b8b` | `connection.js`, `chart.js`, `wait.js` | MED | CDP target picker fails loud when no chart tab is found (was silently targeting wrong page); strict TV-API liveness probe; `symbolSearch` defensive array extraction; `waitForChartReady` uses TV-API bar count + non-empty legend (more reliable than canvas-only); bare-ticker tolerance. PR was macOS-tested upstream; re-smoke on Windows MSIX pending post-restart. |
| F | upstream PR #131 `6f0e530`, partial | `7f98d28` | `connection.js`, `capture.js`, `batch.js` | HIGH (alerts.js merge) | `withReconnect(operation, maxRetries=3)` helper with exponential backoff (500ms → 1s → 2s → 4s, cap 5s) keyed off `/connection closed\|websocket\|target closed\|liveness timeout\|socket hang up\|disconnected/i`. Wraps `Page.captureScreenshot` (capture.js + batch.js). `getClient()` liveness now wrapped in 2s `Promise.race` timeout — merged with pick E's strict TV-API probe (combined: TV-API check, 2s-bounded, attempts graceful `close()` before nulling). **alerts.js SKIPPED** — our alerts.js is REST-based (T31), not CDP; `withReconnect` doesn't apply to `fetch()` calls. |

**Deferred upstream picks (filed for later, NOT in T109):**
- PR #90 `04993ea` — TV 3.1 strategy/equity/trades compat in `data.js`. Defer until T105 strategy mode work begins.
- PR #112 — `alert_create_indicator` for Pine alertcondition signals. File as follow-up post-Block H if needed.
- PR #35 — `data_get_pine_shapes` for `plotshape()`/`plotchar()`. File when plotshape adoption begins.
- PR #107 — 16-fix bundle, ~80% redundant with our fork. Only `safeBacktickBody()` consolidation interesting; file as small refactor if it surfaces.

**Permanently skipped:**
- PR #54 — removes `ui_evaluate`; we actively rely on it for diagnostics.
- PR #97 / #95 — Monaco-Pine; deprecated per RULEBOOK §11.2.
- PR #103 / #110 / #76 — MSIX launch; resolved by our PowerShell recipe.

**Spec ref:** downstream task tracker T109.

---

### 12. `with_pine_save` orchestrator (T110, 2026-05-13)

Composes RULEBOOK §11's 5-step save cycle (compile → save → cache-bust → reload → verify) into one MCP call. Replaces every skill's hand-rolled dance.

**Files:** `src/core/pine.js` `withSave()` (~165 LoC at end of file), `src/tools/pine.js` `with_pine_save` registration (~19 LoC).

**Sequence:**
1. `pine_check(source)` — abort on errors. Records `errors`/`warnings` counts.
2. `pine_save_source({id|name, source})` — abort on save fail or missing `has_il_blob`.
3. `pine_refresh_catalog()` — best-effort; failure does not abort.
4. If `indicator_display_name`: find existing matching study via `chart_get_state`, remove all matches, `chart_manage_indicator(add)`.
5. Verify: prefer `expected_version` substring match on reloaded entity name; else `data_get_pine_tables` row count > 0.
6. On verify-fail with retries left, repeat (3)+(4)+(5) up to `max_retries` (default 2).

**Response:**
```
{
  success: bool,
  steps: [{name, success, ms, detail}, ...],
  final_verification: 'passed' | 'save_only' | 'failed_compile' | 'failed_save' | 'failed_reload' | 'failed_after_retries',
  total_ms: int,
  source_lines: int,
  has_il_blob: bool,
  error?: string,
}
```

**Id heuristic:** strict `^USER;` prefix → treated as id; otherwise treated as name. Removes the previous coin-flip in skills that hand-rolled the dispatch.

**Verification preference (most reliable first):**
1. `expected_version` + `indicator_display_name` → label substring match on reloaded entity name (works because Pine `indicator()` declaration title is reflected in `chart_get_state`).
2. `indicator_display_name` only → `pine_tables` row count > 0 (proves the IL renders the panel).
3. Neither → save-only mode; no reload, no verify, terminal success on save.

**Skill audit pending** (next session): `/3cs`, `pine-visual-verify`, and any in-tree script that does manual save+reload should switch to `with_pine_save` or document a reason to stay manual.

**Spec ref:** downstream task tracker T110.

---

### 13. `408dca4` — `getVisibleRange` + `symbolInfo` DI wiring (post-T110 smoke fix, 2026-05-13)

**Bug:** `chart_get_visible_range` and `symbol_info` returned `evaluate is not defined`. Both function bodies referenced the bare `evaluate` symbol, but the module-level import on line 4 has long been aliased: `import { evaluate as _evaluate, ... }`. Most other functions in chart.js go through `_resolve(_deps)` which destructures the alias back to `evaluate`; these two were left out of the DI refactor.

**Surfaced by:** T109 + T110 post-restart smoke (case 2 — `chart_scroll_to_date` validation tried to read back the visible range via `chart_get_visible_range` and got the error). Pre-existing bug, not a T109 regression. T108 baseline `692d630` already had it.

**Root cause / why missed by T109:** Pick B's spec rationale said "those functions don't use _deps in our fork; addressed in T111" — technically true but missed that the bare `evaluate` symbol they call is already broken regardless of DI status. Upstream's `2df3c93` (skipped during pick B) was the correct fix; this commit applies the same surgical change locally.

**Fix:** ~4 LoC. `getVisibleRange()` → `getVisibleRange({ _deps } = {})` + `const { evaluate } = _resolve(_deps)`. Mirror for `symbolInfo`. Function bodies otherwise unchanged. `tools/chart.js` call sites pass no args, so the default-empty-object pattern is back-compat.

**Validation:** `node --check src/core/chart.js` clean. Live re-smoke pending next MCP restart.

**Spec ref:** Closed inline (no separate downstream task — fix is a known-broken-tool repair surfaced during smoke).

---

### 14. T112 — reliable replay stepping (forward-progress `currentDate` watch)

**Bug:** `replay_step` was flaky. `step()` fired `doStep()` (async, no return value) then diffed `currentDate()` on a fixed `250ms × 12` timer, and on timeout **returned the stale date as success** — masking end-of-data as a normal step. Backtest loops built on this can't tell "advanced one bar" from "stuck at the last bar."

**Live findings (TV Desktop 3.1.0 / Electron 38 / Chrome 140, CDP probe):**
- `bars().lastIndex()` does **NOT** track the replay cursor — on the first step it jumps to the full loaded-series size (e.g. 300) and then freezes. So it is the wrong completion signal (an initial wrong hypothesis for this task, disproven by probing).
- `currentDate()` advances by exactly one bar per step (each replay bar has a unique timestamp) and is **strictly forward**, including across weekend gaps (Fri→Mon).
- `currentDate()` can **flicker to a transient/stale lower value** mid-transition before settling on the next bar — so an "any change" check catches garbage. The robust signal is **`current > before`** (forward progress), which rejects the glitch and only accepts the real next bar.
- `currentDate()` returns a **WatchedValue with `.subscribe`/`.spawn`/`.value`** (confirmed) — a future event-driven upgrade can replace polling entirely.

**Fix:** `step()` now reads `currentDate()`, calls `doStep()`, then polls every **60ms** (was 250ms) up to a 3s ceiling for `current > before`, and **throws** `"Replay bar did not advance (end of available data…)"` when the cursor never moves. Poll interval + ceiling are injectable via `_deps` (`pollMs`, `stepTimeoutMs`) for fast unit tests. Return shape unchanged (`{ success, action:'step', current_date }`).

**Validation:** unit `tests/replay.test.js` 41/41 (added forward-progress + no-stale-return + transient-glitch regression guards). Live smoke: 10 consecutive steps on `BATS:F` 1D, all forward, avg ~180ms/step (min 142 / max 259), clean start→step×10→status→stop.

**Ride-along (test-only):** `tests/e2e.test.js` `replay_stop` was failing on the **baseline** (proven via stash) — the test called `stopReplay()` then `goToRealtime()`, and on TV 3.1.0 `goToRealtime()` internally re-calls `stopReplay()` and asserts if already stopped. Wrapped each teardown step in best-effort try/catch. Real core `stop()` hardening is tracked in **T113**.

**Environment note for T113:** repeated replay start/stop cycles corrupt TV's persistent replay session state — symptom: `start()` returns `current_date = -63072000` (the `getReplayDepth` sentinel, ~Jan 1968) and subsequent steps can't advance. A full TradingView restart clears it. This is exactly the persistent `_replaySessionState` (incl. the `_linking` copy) that T113's `CLEAR_SESSION_STATE_JS` must null. The 70-tool `npm test` e2e suite only runs clean against a freshly-restarted TV for this reason.

**Files touched:** `src/core/replay.js` (`step()` + `STEP_POLL_MS`/`STEP_TIMEOUT_MS` exports), `tests/replay.test.js`, `tests/e2e.test.js` (teardown resilience).

**Spec ref:** task queue T112 (`tasks/done.md`).

---

### 15. T114 — `replay_set_resolution` (tick/second/minute/hour/day granularity)

**New tool.** Sets the replay stepping granularity so a backtest can walk at the interval a theory needs (e.g. 1H fills on a 1D structure) without changing the chart timeframe. Lands directly on `_replayApi`:
- Valid set read live via `replayResolutions()` (WatchedValue → array incl. `null` = auto). **The set is dynamic** — it depends on the chart symbol/timeframe (a 1D chart offers `["1H","2H","3H","4H","1D"]`; intraday charts expose finer). So we validate against the live list every call, not a hardcoded enum.
- Mutate via `changeReplayResolution(value)` (string, or `null` for auto). Validated **before** the call — an unsupported value corrupts TradingView's cloud replay state (S1), same footgun class as autoplay delay.
- Read back via `currentReplayResolution()` / `autoReplayResolution()`.

`"auto"` / `""` / `null` all normalize to auto (null). Returns `{ resolution, is_auto, auto_resolution, valid_resolutions }`.

**Validated:** unit `tests/replay.test.js` (+4: valid-passes-through, invalid-rejected-before-mutate, auto→null, omitted-throws) → 45/45. Live smoke (`BATS:F` 1D replay): set `1H` → reads back `1H`; set `auto` → reads back null/is_auto; set `7M` → rejected with the valid list, no mutation; clean stop.

**Files touched:** `src/core/replay.js` (`setResolution()`), `src/tools/replay.js` (tool), `src/cli/commands/replay.js` (`set-resolution` subcommand), `tests/replay.test.js`, `CLAUDE.md` (replay decision tree + tool count 83), `README.md` (counts).

**Source:** approach from `KarmicP@9ba5f9f8` → `iliaal` `setResolution()`; our impl uses the `_replayApi`-level methods (confirmed via live probe) rather than reaching into the private `_replayUIController`.

**Spec ref:** task queue T114 (`tasks/done.md`).

---

### 16. T116 — `chart_snapshot` (one-call per-bar capture)

**New tool.** Captures, in one concurrent call, everything needed to record a bar: chart state + current-bar OHLCV + study values + Pine graphics (lines/labels/tables/boxes). This is the per-bar capture primitive the T115 `replay_walk` loop is built on.

- **Reuses the tested decoders** in `data.js`/`chart.js` (getState, getOhlcv, getStudyValues, getPineLines/Labels/Tables/Boxes) rather than re-implementing the fragile undocumented-path extraction. Section fetchers run concurrently via `Promise.all`; not a literal single CDP round-trip, but per-bar latency is dominated by replay stepping (~180ms) so fusing into one IIFE would only duplicate the decoders for no measurable gain. New `src/core/snapshot.js`.
- `study_filter` applies across ALL sections (getStudyValues has no filter param, so we post-filter the studies array by name substring to keep behavior consistent).
- `include` selects a subset of sections (unknown names throw — fail loud). `max_labels` passes through to the labels section.
- Each section is error-isolated: a section that throws is captured as `{ error }` so one failure doesn't lose the whole snapshot.
- Surfaces `bar_time` (the last OHLCV bar's start time) as the natural per-bar key.

**Live finding (feeds T115):** during replay, `step().current_date` (the replay cursor) and the OHLCV bar's `time` use **different conventions** — on `BATS:F` 1D they differed by exactly one RTH session (6.5h): `current_date` is the session-close-ish period end (`…:59:59`), `bar.time` is the session open. They reference the **same bar**. → T115 should key its capture series on the canonical OHLCV `bar.time` and record `current_date` as a secondary field.

**Validated:** unit `tests/snapshot.test.js` 5/5 (section selection, study_filter, unknown-section throws, per-section error isolation, bar_time). Live smoke: realtime snapshot 111ms returning all 7 sections (4 studies, pine labels on 4 / lines on 2); in-replay snapshot 6ms.

**Files touched:** `src/core/snapshot.js` (new), `src/tools/data.js` (`chart_snapshot`), `src/cli/commands/data.js` (`tv snapshot`), `tests/snapshot.test.js` (new), `CLAUDE.md` (decision tree + count 84), `README.md`.

**Source:** concept from `niwang` PR #297 (single-call state+quote+ohlcv+studies+pine); our impl composes existing fork decoders concurrently.

**Spec ref:** task queue T116 (`tasks/done.md`).

---

### 17. T115 — `replay_walk` (capture-during-replay backtest loop) ⭐

**The headline feature.** Steps replay from `from` to `to` and captures every bar's study values + Pine graphics (via `chart_snapshot`) into a timestamped series keyed on the canonical OHLCV bar time. This is what makes systematic backtesting of custom Pine theories possible — **no fork or upstream has this**; it's net-new. New `src/core/backtest.js`.

- Composes T112 (reliable `step` that throws at end-of-data), T114 (`setResolution`), T116 (`chart_snapshot`). All collaborators injectable via `_deps` for unit testing.
- `capture` = indicator name substring (→ `chart_snapshot` study_filter). `sections` selects what to record (default `ohlcv, studies, pine_labels, pine_lines`). `resolution` sets stepping granularity.
- **Termination reasons** (explicit, never silent): `reached_end_date` (cursor ≥ `to`), `no_more_data` (step threw — end of available history), `max_bars` (safety cap hit → `truncated:true` + note). Default `max_bars` 1000.
- **Output:** `out` path → streams one JSONL row per bar to disk (survives interruption; recommended for long ranges) and omits the inline series; no `out` → returns the (bounded) series inline.
- **Warm-up:** after `start()` the chart series/studies take ~200ms to materialize, so we poll a cheap ohlcv-only snapshot (`waitReady`) before the loop. The first captured bar is still a warm-up bar — OHLCV present but indicators need lookback before values populate (captured honestly as empty, not null).

**Validated:** unit `tests/backtest.test.js` 7/7 (end-date/no-more-data/max_bars termination, JSONL streaming, capture+sections passthrough, resolution, date validation). Live smoke (`BATS:F` 1D, ~9-bar range → JSONL): 9 rows, strictly ascending bar times, zero nulls, `reached_end_date`, ~250ms/bar. Per-bar evolution captured correctly — study count ramps as indicators warm up and Pine label/line counts grow bar-over-bar, exactly the signal evolution a backtest needs.

**Files touched:** `src/core/backtest.js` (new), `src/tools/replay.js` (`replay_walk`), `src/cli/commands/replay.js` (`tv replay walk`), `tests/backtest.test.js` (new), `CLAUDE.md` (decision tree + count 85), `README.md`.

**Spec ref:** task queue T115 (`tasks/done.md`). Completes Block A (replay reliability + capture).

---

### 18. T113a — replay re-jump guard + drift-warning (safe subset of T113)

Partial ship of the T113 hardening. Two safe, validated pieces landed; the aggressive session-recovery + teardown were **tried, found to regress normal re-use, and reverted** (see below). Remainder tracked as T113b.

**Shipped:**
- **Re-jump guard** in `start()`: if replay is already running, `stopReplay()` + 300ms settle before the new `selectDate()`, so a re-start lands where asked instead of the second selectDate being absorbed (cursor pinned).
- **Drift-warning** in `start()`: if the landed cursor is >4 days from the requested date, return a `warning` field flagging a likely clamp (target predates the loaded history buffer). Threshold avoids false positives from the normal session-close-vs-midnight (~1 day) and weekend/holiday offsets. Read-only; validated it stays silent on correct landings (e.g. `start@2005-01-01` on a deep-history symbol lands at 2005 with no warning).

**Tried and reverted (important — do not re-attempt naively in T113b):**
- Adding `goToRealtime()` + nulling `_chartWidgetCollection._replaySessionState` inside `stop()` (and a session-clear in the re-jump path) **broke normal stop→start→step re-use** — the 2nd cycle's `step()` could no longer advance. All prior smokes (T112/114/115/116) did repeated stop→start with the plain `stopReplay()`-only `stop()` and worked; the additions caused the regression. TV's replay-state lifecycle is more involved than "null one field" — `_replaySessionState` is live state, not a stale cache, and clearing it mid-life desyncs the next session. `stop()` reverted to `stopReplay()`-only.

**Live finding for T113b:** repeated start/stop cycles degrade after ~4 (the 5th cycle's `step()` can't advance) — a pre-existing TV behavior, independent of this fork (earlier smokes never ran 5 rapid cycles). `step()` fails loud (throws) rather than returning stale, which is correct (T112). A TV restart clears it. Proper recovery needs investigating TV's actual replay-session teardown (likely `leaveReplay()` + `_replayContainer` handling), not blind field-nulling.

**S5 probe note:** the iliaal "two-path clear" (`_linking._chartWidgetCollection._replaySessionState`) does **not** apply to TV 3.1.0 — there is no `_chartWidgetCollection._linking`; only `_linkingGroupsCharts`/`_activeLinkingGroupWV` and a single `_replaySessionState` (+ `_replayContainer`).

**Validated:** `tests/replay.test.js` 48/48 (added re-jump-stop, drift-warn, no-drift-warn; full suite 60/60 with snapshot+backtest). Live: 4 forward start/stop/step cycles clean; `replay_walk` unaffected.

**Files touched:** `src/core/replay.js` (`start()` re-jump guard + drift-warning, `DRIFT_WARN_SECONDS`), `tests/replay.test.js`.

**Spec ref:** task queue T113a (`tasks/done.md`); remainder T113b (`tasks/backlog.md`).

---

### 19. T118 — headless backtest sidecar (`backtest_pull`, Block B) ⭐

**The scale unlock.** A browser-free backtest engine: pulls a Pine indicator's full per-bar output over TradingView's WebSocket (via `@mathieuc/tradingview`) and normalizes it to the **same `{t, values}` JSONL rows as `replay_walk`** (T115), so the browser and socket engines are interchangeable downstream. New `src/sidecar/backtest_socket.js` + `backtest_pull` MCP tool + `tv backtest-pull` CLI.

- **Array-speed:** live pull of a custom indicator over ~5 months = **102 bars + graphic (75 labels/7 lines/1 box/1 table) in ~2.3s total**, vs ~250 ms/bar (~25s) for the same range via `replay_walk`. The socket is ~constant-per-pull; the browser is linear-per-bar, so the gap widens with range/symbol count.
- **Loose coupling:** the socket lib is **dynamically imported inside the fetch function**, so it never loads at CDP-server startup and a protocol break can't destabilize the rest of the server. Socket I/O (`fetchStudy`) is injectable via `_deps` — the transform layer is fully unit-tested without a socket/token.
- **Indicator resolution:** built-in `STD;…` load via `getIndicator()`; private `USER;…` must load via the `getPrivateIndicators().get()` descriptor (getIndicator doesn't resolve USER ids) — branched accordingly.
- **Normalization:** TradingView's `1e100` na sentinel → `null`; socket returns newest-first so rows are re-sorted ascending; date-filtered to `[from, to]`; a `note` fires if `range` (bar count) wasn't deep enough to reach `from`.
- **Auth:** reads `TV_SESSION` / `TV_SIGNATURE` from the environment (or opts) — **Critical secret, never hardcode/log/commit**. The socket path is a reverse-engineered protocol (can break on TV changes — dep pinned at `@mathieuc/tradingview ^3.5.2`; re-smoke before relying) and a ToS grey area (defensible as personal, local use of one's own account). Graphic labels lack a clean per-bar time in the parsed lib output, so `graphic` is returned as counts/metadata, not per-bar; the per-bar `study.periods` values are the signal series.

**Validated:** `tests/backtest_socket.test.js` 6/6 (na→null, ascending sort, date filter, graphic counts, from-not-reached note, JSONL streaming, arg passthrough, missing-arg guards) — all with injected socket I/O, no token. Live smoke: pulled a custom private indicator (102 bars) — see above.

**When to use which:** `backtest_pull` for large-range / multi-symbol scans (fast, needs token); `replay_walk` (T115) for visual/fidelity work, the ToS-safe own-Desktop path, and when no token is available. Same row shape → same downstream analysis.

**Files touched:** `src/sidecar/backtest_socket.js` (new), `src/tools/replay.js` (`backtest_pull`), `src/cli/commands/replay.js` (`backtest-pull`), `tests/backtest_socket.test.js` (new), `package.json` (`@mathieuc/tradingview` dep), `CLAUDE.md` (decision tree + count 86), `README.md`.

**Spec ref:** task queue T118 (`tasks/done.md`). Remaining Block B: T119 (strategy harness / code-side P&L).

---

### 20. T119 — strategy harness: `backtest_from_signals` + `backtest_run_strategy` ⭐

**The payoff of Block B.** Turns captured series (T115/T118) and Pine strategies into real, queryable backtest numbers — net profit, win rate, expectancy, profit factor, max drawdown, equity curve — so "improve process on back data" has numbers instead of screenshots. Two engines, **one canonical metrics schema** (they're comparable by construction).

- **`backtest_from_signals` (code-side, no browser, no token) — the valuable half.** Takes a `{t, values}` signal series (inline or a JSONL `series_path`) + declarative `rules` and simulates P&L in code, sidestepping Pine's strategy-engine limits (2000-order cap, single-position quirks). Rule grammar: `{side, entry, exit, price_field, qty, fee_per_trade, initial_capital}`; predicates are `{field, op, value?|field2?}` (ops `> < >= <= == != crosses_above crosses_below rising falling truthy falsy`) or `{all|any:[...]}|{not:...}` combinators. One action per bar; open positions force-close at end-of-data (`exit_reason:'end_of_data'`). **Fixture-tested against hand-computed P&L** (`tests/signal_pnl.test.js`) — this is where silent math bugs hide.
- **`backtest_run_strategy` (headless socket, needs `TV_SESSION`).** Loads a Pine `strategy()` over the socket and reads TV's own `study.strategyReport`, normalizing it into the **same** schema (recomputed from the trade list via the shared `metrics.js`), plus TV's native aggregates under `tv_native`. `script_id` = "USER;<hash>" or built-in "STD;…Strategy".
- **Shared metrics core (`src/sidecar/metrics.js`).** `computeTradeMetrics` + `computeEquityCurve` + `maxDrawdown`, pure. Unit conventions: money in account currency; `gross_loss` a positive magnitude; rates (`win_rate`, `max_drawdown_pct`) as fractions 0–1; undefined-for-the-data fields are `null` (not `0`/`Infinity`).

**Two live-verified mapping fixes (the reason the spec demanded a live dump):**
1. **strategyReport compression is zlib-deflate (magic `78 9c`), not ZIP.** The lib's `parseCompressed` feeds the blob to jszip and throws *"Can't find end of central directory"* inside the async study listener — which crashes the MCP process. New `src/sidecar/tv_decompress.js` (`decodeCompressed`, magic-byte sniff → zlib/gzip/raw-inflate, unit-tested) replaces it. Installed at module load in `strategy_report.js` by patching the cached `protocol.js` **before** `study.js` destructures `parseCompressed` — safe because the socket lib is only ever loaded lazily inside the fetch fns, and `tools/replay.js` imports `strategy_report.js` at server startup. On decode failure it returns `{ report: {} }` so the listener degrades gracefully instead of crashing.
2. **Max-drawdown key is `maxStrategyDrawDown{,Percent}` on TV 3.1**, not `maxDrawDown{,Percent}` (the latter is absent — mapping it read `null`). Now prefers the current key with a legacy fallback. Also: strategy trade times come back in **milliseconds** — normalized to seconds to match the `{t}` convention and the `from`/`to` filter; `grossLoss` can be positive (handled via `Math.abs`); `percentProfitable` is a 0–1 fraction (guarded against a >1 percent).

**Validated:** 26 new unit tests (`signal_pnl` 12, `strategy_report` 10, `tv_decompress` 4) + 1 headless CLI e2e, all with injected I/O — no token. **Live smoke** (built-in `STD;Supertrend%Strategy`, NASDAQ:AAPL D, 500 bars): report decoded cleanly, no crash, 338 trades, recomputed net $3.14M / win 37.6% / PF 1.63, `tv_native.max_drawdown` 367,704, trade times in seconds. The token was extracted from the running Desktop via CDP `Network.getCookies` into a gitignored `.env` for the smoke, then deleted — **never committed** (Critical secret per `~/.claude/rules/fork-publishing.md`).

**When to use which:** `backtest_from_signals` for indicator-signal theories (our indicator-heavy setup — the primary path, no token); `backtest_run_strategy` when the theory is already a Pine `strategy()`. Both emit the same schema, so a signal backtest and a strategy backtest are directly comparable.

**Files touched:** `src/sidecar/signal_pnl.js`, `src/sidecar/metrics.js`, `src/sidecar/strategy_report.js`, `src/sidecar/tv_decompress.js` (new); `src/tools/replay.js` (`backtest_from_signals`, `backtest_run_strategy`); `src/cli/commands/replay.js` (`backtest-from-signals`, `backtest-run-strategy`); `tests/signal_pnl.test.js`, `tests/strategy_report.test.js`, `tests/tv_decompress.test.js` (new), `tests/cli.test.js` (+1); `CLAUDE.md`, `README.md`, `tasks/*`.

**Spec ref:** task queue T119 (`tasks/done.md`). Block B complete. Remaining fork work: T113b (replay session recovery, Tier-B), T120 (strategy-tester DOM-scrape fallback, Tier-Q).

---

### 21. T113b (safe subset) + T120 (superseded) — replay teardown + strategy-read close-out

Both closed 2026-07-02 as the final fork cleanup. Neither warranted the deep/risky work its full spec described; the reasons are recorded here so they aren't re-litigated.

**T113b — replay session recovery: shipped the safe subset, documented the rest as a TV limitation.**
- **Live-probed the teardown surface (S5)** on TV Desktop 3.1.0: `_replayApi` proto exposes `destroy`, `goToRealtime`, `stopReplay`, `leaveReplay`; `_replayUIController` has `_updateReplaySessionState` / `_restoreReplaySessionState`; session state lives on the widget collection as `_replayContainer` / `_replaySessionState`.
- **Shipped:** `stop()` now makes a **best-effort `goToRealtime()` call after `stopReplay()`**, try/catch-wrapped so it can never change the stop result or throw — it matches the tool's "return to realtime" contract and cannot regress the normal stop→start→step path (proven by two new `replay.test.js` cases incl. a throwing-teardown case). 50/50 replay tests green.
- **Documented + capped (not fixed):** the ~4-5-cycle replay degradation is a **TV-side session-state accumulation** with no verified clean client-side fix (the prior `_replaySessionState = null` attempt regressed re-use — FORK_NOTES §18; the deep experiment to prove a `leaveReplay`-based reset would require destabilizing multi-cycle runs on a live chart, deliberately not done). Guidance: for long or repeated backtests prefer **`backtest_pull`** (headless, no replay session) over many `replay_walk` cycles; restart TV Desktop to clear degradation. `scroll_back` (backward jumps past the loaded buffer) also remains deferred.
- **Status:** T113b's *safe subset* is DONE; the deep session-recovery + scroll_back remainder stays in `tasks/backlog.md` as a documented TV-limitation item (revisit only if TV changes replay internals).

**T120 — strategy-tester DOM-scrape fallback: closed as superseded, no code.**
- Purpose was a DOM-scrape fallback for `data_get_strategy_results` / `_trades` / `_equity` when the internal API returns empty on TV 3.1+.
- **Superseded by T119.** `backtest_run_strategy` now reads a strategy's full report over the socket (net profit, win rate, trades, equity) **without touching the DOM at all** — strictly more robust than scraping TV's hashed, version-specific Strategy-Tester classnames (`backtestingReport-<hash>`, confirmed live to rot per build). The internal-API browser path T120 patched is also rarely exercised (this fork's primary downstream consumer is indicator-based, not `strategy()`-based).
- **Also confirmed live:** built-in strategies (e.g. "Supertrend Strategy") are **not** locally insertable via `activeChart().createStudy()` — they're server-side pine-facade scripts (`STD;…`), not in the 241-entry internal metainfo repository — so even verifying a DOM scraper requires loading a strategy the hard way. Cost/benefit does not justify a rot-prone scraper.
- **Status:** WON'T-FIX / superseded. Left in `tasks/backlog.md` with this rationale for traceability.

**Net:** the fork's forward queue (T112–T120) is fully resolved — Blocks A + B shipped, T113b safe subset shipped, T120 superseded. Only the explicitly-deferred T113b deep remainder remains, gated on a TV-side change.

---

### 22. T121 — `backtest_from_signals` native per-entry `stop_loss` ⭐

Shipped 2026-07-18. Closes the one modeling gap in the code-side P&L engine: it could not express a **fixed per-entry stop**. The exit-predicate DSL is stateless (`evalPredicate` sees only the current + previous bar — no entry price or bar index), so downstream consumers approximated a stop with a `field2` exit like `{field:"close", op:"<", field2:"stop_level"}` — which **re-reads `stop_level` every bar**, making it a *trailing* stop that re-anchors mid-trade, not the fixed closing-basis stop real risk rules use.

- **Added `rules.stop_loss = { field, basis }`** to `src/sidecar/signal_pnl.js`. The stop level is read **once, from the entry bar's `field`**, and stored on the open position — so it is fixed for the life of the trade. `basis: "close"` (default) exits when the bar **close** breaches the level; `basis: "intrabar"` exits when the bar **low** (long) / **high** (short) breaches it (falling back to close if low/high absent). Fills at `price_field` on the breach bar (a deliberate modeling choice — no assumption of a fill exactly at the stop price), `exit_reason: "stop_loss"`.
- **Priority:** the stop is checked **before** the signal `exit` predicate — a bar that both stops out and signals exit is recorded as `stop_loss` (the protective stop fires first). A non-numeric captured level is **inert** for that trade (no stop exit), so a series without the field behaves exactly as before.
- **Additive + back-compatible.** `rules` was already `.passthrough()`, so the option flowed through untouched; added an explicit, self-documenting `stop_loss` field to the tool schema in `src/tools/replay.js` for discoverability. No behavior change for any existing rule set.
- **TDD:** +6 tests in `tests/signal_pnl.test.js` (closing-basis long, fixed-not-trailing capture, intrabar low-breach, short close-basis, stop-beats-signal priority, inert-when-absent). `signal_pnl.test.js` 18/18 green; `node --check` clean on both touched files.
- **Why now:** a downstream fill-parity backtest needed honest closing-basis stop realism; the `field2` trailing approximation was its last non-native modeling hack. One engine still serves both the paper-ledger and backtest consumers.

---

### 23. T122–T130 — upstream / fork-network catch-up batch (2026-07-18)

After a thorough audit of our fork vs upstream (60 commits ahead of our 2026-04-03 merge base), the wider fork network (~2,100 forks, mostly noise), and the open PRs, we cherry-picked/hand-ported the genuinely-useful, macOS-relevant gap-fills and skipped the rest. All hand-ported (data.js/chart.js/ui.js have diverged — none was a clean `git cherry-pick`). Live-verified on TV Desktop **3.3.0** where CDP allowed.

- **T122 — security** (upstream `72c5c7e`/#177 + `a184e66` audit half). Screenshot filename path-traversal: the legacy `filename` branch in `capture.js` stripped `/\\` but not `..`, so a caller-supplied name could escape `screenshots/`; added `.replace(/\.\./g,'_')` (the deliberate arbitrary-path hatches `path`/`out_dir` from T109 pick B are unchanged). Plus a fresh `npm audit fix` → 0 vulns (was 7: `ws` DoS, `qs` DoS, `ip-address` chain). LIVE: `../../../../tmp/evil` → inert `________tmp_evil`.
- **T123 — 8dp price rounding** (upstream `a184e66`/#77). `getOhlcv` summary + `getPineLines`/`Labels`/`Boxes` rounded prices to 2dp, flattening sub-cent/fractional levels. Replaced the 6 **price** sites with a shared `roundPrice()` at 8dp (percentages/volumes untouched). LIVE on a downstream consumer's chart: custom-indicator levels read exact — `29.8755`, `27.5454`, `55.885` — where 2dp would have flattened them.
- **T124 — strategy-tester read rewrite** (upstream `653c273`/#48/#173/#181). `data_get_strategy_results`/`_trades`/`_equity` used an **inverted** detector (`is_price_study === false`) that excludes every strategy on current builds (strategies have `is_price_study === true`), and read metrics from the wrong shape. Ported shared `FIND_STRATEGY_JS` (detect via `isTVScriptStrategy`/`is_strategy`, prefer the strategy whose `reportData().performance` is computed) + `ensureStrategyTesterReady()` (opens the Strategy Tester so the report computes from a cold panel) + real metric mapping (`performance.all` → net_profit/profit_factor/win-loss, `maxStrategyDrawDown`) + terse-order-key mapping (`b/e/p/q/tp` → side/entry/price/qty/type, most-recent tail). **This fixes the live-chart read tools; the fork's own T119 socket harness (`backtest_run_strategy`) is a separate path.** LIVE on 3.3.0: new path runs with no crash + graceful no-strategy schema on an indicator-only chart; full metric mapping is a faithful port of upstream's 3.1.0-live-verified code (pending a strategy on the chart — built-in strategy add-name resolution is a separate gap).
- **T125 — `data_get_bias_signal`** (PR #340, olaseun28). ⭐ NEW read-only tool for label/box-only Pine indicators (no `plot()`, so `data_get_study_values` sees nothing). Keyword scan of label/table text (bullish/bearish/long/short/buy/sell — high confidence) → sweep→confirmation (CSD/BOS/CHoCH) label-price sequence heuristic (low confidence). Indicator-agnostic. `src/core/bias.js` (pure `findKeywordBias`/`findSequenceBias` + `getBiasSignal` orchestrator on `getPineLabels`/`getPineTables`) + MCP tool + `tv data bias` CLI + `core/index.js` export. The bundled Windows exit-crash fix from that PR was **not** included. +10 pure unit tests. LIVE on a downstream consumer's chart: correctly read **a custom indicator panel → bullish (high conf)** from a `… BULLISH MOM …` label; other label/table studies neutral.
- **T127 — `setVisibleRange` history paging** (upstream `be200a4`/#224). Zoomed only within already-loaded bars (~300), so multi-year ranges clamped. Now pages history via `mainSeries().requestMoreData()` until the earliest loaded bar covers `from`, the feed ends, or a 25-iter guard trips, then `zoomToBarsRange`. LIVE on a daily equity chart: a 2015 request paged **2300 bars (earliest 2017-05-23) → 3016 bars (earliest 2014-07-17, the IPO)** in 2.3s and stopped at feed-end; an already-covered range short-circuits in 0.5s.
- **T128 — `ui_open_panel` close on TV 3.2+** (upstream `d766b10`/#248). `bottomWidgetBar.hideWidget(name)` was removed on newer builds; the typeof-guarded close **silently no-op'd** while reporting `performed:'closed'`. Added `close()`/`hide()` fallbacks. LIVE on 3.3.0: `hideWidget` absent (`hasHideWidget:false`), bottom panel collapses **484px → 38px** via `bwb.close()`.
- **T129 — reliable indicator inputs-on-add** (upstream `d54936a`/#249). `createStudy`'s 4th arg (inputs) is unreliable across builds — studies were created with defaults, so `add … inputs {length:99}` silently no-op'd. After create, re-apply overrides via the study's own `getInputValues`/`setInputValues` (the path `indicator_set_inputs` uses) + read back to report which took; unknown keys → `unknown_inputs`. Layered on top of T108's create (belt-and-suspenders). Mechanism-verified on 3.3.0 (`getInputValues()` present, correct `[{id,value}]` shape); full add+readback e2e pending stable CDP (T108's descriptor-lookup add path was intermittently slow this session).
- **T130 — ESLint `no-undef` guard + CI** (upstream `98c4ee1`+`35f23ad`/#205). The fork has repeatedly shipped "X is not defined" (the branch is named after one) — a static gate catches every one. `eslint.config.mjs` (flat, no-undef + correctness rules; src/ clean, 0 errors) + `lint`/`test:unit:pure` scripts + `.github/workflows/ci.yml` (lint + TV-independent tests on Node 20/22 for push/PR to main + `fixes/draw-api-resolve`). `test:unit:pure` = pine_analyze + signal_pnl + strategy_report + tv_decompress + bias (e2e/cli/sanitization/replay/snapshot need live TV, excluded from CI).

**Evaluated but NOT shipped:**
- **`tv_update` self-updater + the git-pull nag in `tv_health_check`** (upstream `0d85b00`/#335, `d2d3b5c`) — fight the fork's deliberate cherry-pick workflow (the updater would ff-merge our *own* main, not upstream).
- **All MSIX/Windows launch work** — macOS-only shop.
- **Watchlist DOM overhaul (#164/#111), alerts REST (#301), quote_get symbol (#104), wait_for_render (#144), DI refactor (#205 chart.js)** — we already have these, generally via more robust REST impls (T31/T35/T37/T74, T109 pick A, `408dca4`). PR #255's cross-symbol quote bug is our own T35.
- **T126 — `replay_stop` latch fix** (Collinshogo fork, `f1e3ca6c7`). Strong candidate — isolates the `_isReplayStopping` stuck-latch root cause behind the ~4–5-cycle replay degradation — but a +216-line replay rewrite whose `updateReplaySessionState(null)` step is the same session-clearing §18 found regressive; needs a stable-CDP multi-cycle soak, so folded into the **T113b** backlog task as a candidate-implementation reference rather than shipped.

---

### Replay API surface (live probe, TV 3.1.0) — reference for T113/T114/T115/T119

`Object.getOwnPropertyNames(Object.getPrototypeOf(window.TradingViewApi._replayApi))` on TV Desktop 3.1.0 exposes (beyond the already-used methods) several undocumented capabilities worth building on:

- `getReplayDepth()` — available replay range/depth (bound a walk, detect end) → **T115**.
- `isReadyToPlay()` — readiness flag (cleaner start/step gating).
- `goToRealtime()`, `leaveReplay()` — teardown primitives (confirms **T113** stop hardening).
- `replayResolutions()`, `changeReplayResolution()`, `currentReplayResolution()`, `autoReplayResolution()` — resolution control lives directly on `_replayApi` (plus the `_replayUIController` own-prop) → simplifies **T114**.
- `isJumpToBarModeEnabled()`, `toggleJumpToBarMode()` — jump-to-bar navigation mode.
- `selectRandomDate()` — random start (practice/training).
- `getReplaySelectedDate()`, `symbolInfo()`, `currency()`, `replayTimingMode()`, `isReplayToolbarVisible()`.
- `replayStrategyFacade`, `replayStrategyFacadesPerChartModelId` — strategy testing **during replay** → relevant to **T119**.
- Own props: `_replayUIController`, `_replayAvailability`, `_position`, `_realizedPL`, `_currency`, `_symbolInfo`, `_chartWidgetsCollection`.

---

## §24 — `tv replay walk --sections`: CLI/MCP parity (T131, 2026-07-18)

**Symptom.** `replay_walk` as an *MCP tool* has always accepted a `sections` array
(`ohlcv`, `studies`, `pine_labels`, `pine_lines`, `pine_tables`, `pine_boxes`). The
`tv replay walk` **CLI** never exposed it — the handler in
`src/cli/commands/replay.js` simply did not pass the option through — so the CLI was
locked to the default set `['ohlcv','studies','pine_labels','pine_lines']`.

**Why it mattered.** `pine_tables` is not in the default set. Any consumer whose
per-bar state lives in a Pine **table** (status panels, dashboards — a very common
shape) therefore could not capture it from the CLI at all, and captures came back
looking structurally fine but with the panel fields empty. The MCP tool could do it;
the CLI could not. That asymmetry is what made multi-symbol batch capture
un-scriptable — driving N captures through the MCP tool costs ~2 tool calls each,
whereas the CLI is a shell loop.

**Fix.** Added a `--sections` option (comma-separated, parsed to an array, `undefined`
when omitted so the existing default is untouched) and threaded it into the
`replayWalk({...})` call. Purely additive; every existing invocation behaves exactly
as before.

```
tv replay walk --from 2025-12-28 --to 2026-07-17 \
   --sections "ohlcv,pine_tables,pine_lines,pine_labels,pine_boxes" --out cap.jsonl
```

**Verified.** Parity-checked CLI output against the MCP tool on two symbols over the
same window — both produced 138 rows with 15 populated table rows per bar and
identical adapted structure. `node --check` clean.

**Related operational gotcha (not a code bug, worth knowing).** TradingView Desktop
restores its *last tab*, which after a kill during an active replay is often a symbols
page or "New tab". In that state **every** tool — including `tab_new` and
`layout_switch`, which need a chart tab themselves — fails with "No TradingView chart
tab found", a bootstrap deadlock. CDP `/json/new` is rejected by this Electron build
("Could not create new page"). The way out is to take an existing page target and
`Page.navigate` it to a saved chart URL over the CDP websocket. Relevant to anyone
scripting the documented ~4–5-cycle replay restart (see §18 / T113b).

---

## §25 — persistent `.env.local` loader for sidecar secrets (T132, 2026-07-22)

**Symptom.** The headless sidecars — `backtest_pull` (§19) and `backtest_run_strategy`
(§20) — read `TV_SESSION` / `TV_SIGNATURE` from `process.env`, but nothing ever loaded
them. Supplying the token meant exporting the vars into the exact shell/host that
launched the MCP server. For a long-lived server started by an editor or agent host
(not a shell), there was no low-friction, persistent way to provide the session token,
and the §20 workflow resorted to extracting a token into a throwaway `.env` that was
deleted immediately after use.

**Fix.** New `src/load-env.js`, a zero-dependency loader imported as the **first**
statement in `src/server.js` (so the token is present before any sidecar reads
`process.env`). It parses `KEY=VALUE` lines from the repo-root `.env.local` and injects
them into `process.env` **without overriding** vars already set — the real environment
always wins, so an explicit shell export still takes precedence. Blanks and `#` comments
are skipped; `=` inside a value (base64 signature padding) is preserved.

`.env.local` is covered by `.gitignore` (`.env.*`) — the session token stays local and
is never committed (Standard S3). The loader carries **no** secret itself; it is generic
plumbing.

**Verified.** `parseEnv` / `loadEnvFile` split into pure, injectable functions with a
token-free unit suite (`tests/load-env.test.js`, 6 tests, uses a temp fixture + its own
env object — added to `test:unit:pure`). Loader confirmed live: after import,
`process.env` gains the expected keys (checked by key **name** only; values never
echoed).

---

## Open upstream-facing work (optional)

Draft issue reports for the two unreported bugs we patched exist in local development notes. Paste at https://github.com/tradesdontlie/tradingview-mcp/issues/new when you want maintainer attention. Issues:

- `data_get_pine_labels` silently truncates to 50 labels — default cap too low for real indicators
- `watchlist_get` returns `count: 0` when a different sidebar tab is active — TV lazy-renders hidden widgets
- `alert_create` DOM automation is stale — REST endpoint `pricealerts.tradingview.com/create_alert` works instead (this one may be especially valuable to the maintainer)
- `alert_delete` only supports `delete_all`, and even that opens a context menu — REST endpoint `pricealerts.tradingview.com/delete_alerts` supports native bulk delete by ID

---

### 22. Replay: await selectDate (upstream #172) + stop() must not lie

Two changes from a live audit on **TV Desktop 3.3.0 / Chromium 140**.

**a) `start()` now awaits `selectDate()` for real.** The old code was
`await evaluate(rp.selectDate(ts).then(function(){return 'ok';}))`. The `.then()`
wrapper looks like awaiting but isn't: `evaluate()` runs with CDP
`awaitPromise:false`, so the whole chain stayed fire-and-forget, and
`selectFirstAvailableDate()` had no wrapper at all. Both now go through
`evaluateAsync()` (`awaitPromise:true`). This is upstream
tradesdontlie/tradingview-mcp#172, still open there.

⚠️ **This did NOT fix the start/stop cycle degradation** — measured before and
after, identical. Recorded so nobody re-tries it expecting a cure. It is a real
latent bug worth fixing on its own; it is not *this* bug.

**b) `stop()` verifies the stop actually took.** Measured: from the **2nd**
start/stop cycle in one app session, `stopReplay()` becomes a no-op —
`isReplayStarted()` stays true — while `stop()` still returned
`{success:true, action:'replay_stopped'}`.

That silent lie is the dangerous part. In the degraded state `replay_walk`
returns **one bar** with `success:true, truncated:false`. Measured on the same
range: healthy = 11 rows, degraded = 1 row, no error either time. A backtest
built on that produces confident numbers from a single bar and nothing anywhere
says so — the exact class of failure `step()` was hardened against in T112
("fails loud rather than returning stale, which is correct").

`stop()` now polls `isReplayStarted()` after `stopReplay()` and returns
`{success:false, action:'stop_failed', replay_still_started:true}` with recovery
instructions when the stop didn't take. We cannot make TV stop — the session
degradation is a TV-side limitation nobody has solved (this fork's T113b probed
the teardown API and closed it as such; upstream PR #306 loosened its e2e test
to match "the tool's actual (unverified) stop semantics") — but we can refuse
to claim success. Callers get a real signal and can relaunch Desktop, the only
known recovery.

Cadence note for capture scripts: relaunch Desktop **every 2 captures**, not
every 4–5. The older ~4–5 figure was measured on 3.1.0; 3.3.0 degrades sooner.

**Validated:** `tests/replay.test.js` 53/53 (added: selectDate/selectFirstAvailableDate
routed through `evaluateAsync`; `stop()` reports failure when the stop doesn't
take; healthy-stop mocks now model the true→false transition instead of a
constant `true`, which was indistinguishable from the degraded case). Live on a
FRESH Desktop: cycle 1 `success:true` + `isReplayStarted:false` (no false
positive), cycles 2–3 `success:false` + still started — matching ground truth
every time.

---

## §26 — durable Pine ships: layout save, add-then-remove reload, input restore (2026-07-31)

**The problem.** `withSave` reported `final_verification: passed`, a follow-up
graphics read confirmed the new version, and minutes later the chart was running
the OLD version again — under a **fresh entity id**, so it never read as a
revert. Both observations were true. The orchestrator updates the cloud script
and swaps the **live** study instance, but the **chart layout's saved copy still
references the previously-compiled version**, and any page reload, layout
re-sync or app restart re-instantiates from that copy.

This is not cosmetic for anyone driving TradingView from automation: a
supervisor that kills and relaunches the app on a failed health probe hands the
next scheduled read an old indicator, with nothing anywhere saying so.

**Five changes, each from an observed failure.**

1. **`saveLayout()` + a `layout_save` step in `withSave`.** Calls
   `_chartWidgetCollection._saveChartService.saveChartSilently()` and then polls
   `_hasChanges.value()` until it reads `false` — the flag going `true → false`
   is the only proof the save actually flushed. **Auto-save being enabled is not
   sufficient**; it was on and had not flushed in the case above. The step is
   skipped when verification did not pass (never persist a chart you could not
   confirm), and a verified-but-unsaved result returns a `durability_warning`
   field rather than reading as a clean pass. Exposed standalone as
   `chart_save_layout` (MCP) and `tv pine save-layout` (CLI).
   **Do not substitute a blind Ctrl+S** — the save target is sticky to whatever
   last had focus, so with the Pine Editor focused it saves the *script*, which
   is the same hazard that deprecated `pine_save` (§10).

2. **The reload is add-then-remove.** It used to remove every matching study and
   then add. That is not atomic: in one observed ship the remove succeeded and
   every add retry failed, leaving the chart with **no indicator at all** —
   strictly worse than the stale version being replaced. Adding first makes the
   worst case "old version still on the chart", which is visible and
   recoverable. Verification now resolves the study by the **entity id just
   added** rather than by name substring, because a transient second instance
   makes a name match ambiguous.

3. **A version mismatch is terminal, not retried.** New status
   `failed_version_mismatch`. `max_retries` defaults to 2 and each retry is
   another non-atomic chart mutation; a retry cannot change the version string a
   script *declares*, so retrying a mismatch only churns the chart. Observed: a
   source whose version-history comment was bumped while its header and
   `indicator()` title were not produced a two-minute hang with the chart in
   flux. Retries still cover catalog/reload faults, where they genuinely help.

4. **User inputs are snapshotted before the reload and restored after.**
   `remove + add` recreates the study at its **declared defaults**, silently
   discarding anything the operator tuned — and saving the layout afterwards
   makes that loss permanent. `withSave` now captures the inputs first, re-applies
   them to the new instance (`restore_settings`, default true), diffs, and
   **refuses the layout save** on anything still different (`force_layout_save`
   overrides). Two guards matter:
   - **Filtered to `in_<N>`.** A Pine study's input list also carries TV
     internals — `text` (the multi-KB encrypted compiled source), `pineId`,
     `pineVersion`, `pineFeatures` — and **every one of them changes on a normal
     correct ship**. Diffing them would flag every save as a settings loss and
     refuse every layout save, i.e. break the exact thing this protects.
   - **Restore is skipped when the input COUNT changed.** Pine input ids are
     positional, so restoring across a version that added or removed an input
     writes values into the *wrong* inputs — worse than the reset it undoes. On a
     count change nothing is restored, the delta is reported, and the layout save
     is refused.

5. **`refreshCatalog` self-primes the Indicators dialog.** TV builds
   `_studyMarket._dialog._initIndicatorsPromises` on the first dialog **open**,
   so after an app restart the function threw `dialog state not initialized` —
   which sent the descriptor lookup down its bare-title fallback, which
   `createStudy` rejects for user scripts. That chain is how the empty-chart case
   in (2) started. It now clicks `[data-name="open-indicators-dialog"]`, polls
   for the state (≤3s), dispatches Escape via CDP, and retries once, reporting
   `auto_primed`.

**Validated live** on TradingView Desktop 3.3.0: a docs-only version bump shipped
through `withSave` — snapshot 18 inputs → add-then-remove (removed 1) → verify
matched → **2 tuned inputs restored, diff empty** → `layout_save`
`has_changes_before: true → has_changes_after: false`. The app was then killed
and relaunched by its supervisor; the chart came back on the **new** version under
the **same entity id** with both tuned inputs intact. `node --check` + eslint
clean (0 errors).

---

## §27 — `alert_create` gains a `symbol` parameter, and reports what was actually armed (2026-08-02)

**The bug.** `alert_create` had **no `symbol` parameter at all**. `create()` read
the active chart symbol via CDP, put it in the payload, and returned it verbatim
in the response. A caller wanting an alert on a different instrument had no way
to say so — and if it passed one anyway, the MCP layer dropped it silently.

This is the worst shape a wrong answer can take: the call returns `success:true`,
the alert appears correctly in `alert_list`, and it **never fires**. Nothing
downstream can detect it. A downstream consumer hit it twice in two days — once
arming an alert at a price the (wrong) instrument could never reach, once arming
two alerts on a leftover chart symbol. The only mitigation available was "always
call `chart_set_symbol` first", i.e. discipline, and discipline is what failed.

**Measured before fixing, and it refutes the obvious diagnosis.** The endpoint was
**never tied to the chart**. Posting a `create_alert` whose marker names
`NYSE:SW` while the chart sat on `BATS:MSFT` returned `s:ok` and armed on
**`BATS:SW`** — the correct instrument, with TradingView normalizing the venue to
its consolidated US feed server-side. The chart coupling was entirely
self-inflicted by this module reading `mainSeries().symbol()`. So this is
parameter plumbing, not a redesign, and no server-side constraint had to be
worked around.

**What changed:**

1. **`create({ symbol })`** — optional. Omitted, behaviour is byte-identical to
   before (active chart). Provided, it is honoured. A request naming the same
   ticker as the chart short-circuits to the chart's own metadata.

2. **The response reports the instrument TradingView ACTUALLY armed**, parsed back
   out of the marker in its own reply (`r.symbol`), not the one we asked for. The
   old code returned the chart symbol unconditionally, which is precisely why a
   mis-targeted alert looked perfectly correct in the response. New fields:
   `symbol` (armed, authoritative), `requested_symbol`, `chart_symbol`,
   `symbol_source`, `currency_source`.

3. **A mis-target is rolled back, not returned as a success.** A *venue* rewrite
   (`NYSE:SW` → `BATS:SW`) is expected and passes. A different *ticker* means the
   alert is on the wrong instrument, so it is deleted and the call returns
   `success:false` with `armed_symbol` and `rolled_back`. Leaving it armed is the
   exact harm this section exists to remove.

4. **Currency resolution for off-chart symbols** via TradingView's public
   symbol-search, falling back to the chart's currency and **saying so** through
   `currency_source` rather than silently assuming USD.

**Two things worth knowing if you touch this** (both measured 2026-08-02):

- **A bare ticker is genuinely ambiguous, and `is_primary_listing` does not
  disambiguate it.** `SW` resolves across NYSE/USD, EURONEXT/EUR and BX/CHF —
  and **two** of those carry `is_primary_listing: true`. `lookupCurrency`
  therefore returns `null` rather than guessing when a bare symbol has more than
  one primary listing.
- **`BATS` is not in symbol-search at all** — 0 exact results for `BATS:MSFT`,
  though it is what TradingView normalizes US equities to and therefore what
  chart symbols look like. That is why the currency fallback exists and is
  reported instead of being treated as an error.

The T31 message/condition price-parity validator is unchanged and still runs
before the POST.

**Validated live** on TradingView Desktop 3.3.0 with the chart on `BATS:MSFT`:
`alert create --symbol NYSE:SW` → `success:true`, `symbol: BATS:SW`,
`symbol_source: requested`, `currency_source: symbol_search`; confirmed on the
requested instrument via `alert_list`; the no-`symbol` path still armed on
`BATS:MSFT` with `symbol_source: active_chart`. Both test alerts deleted after.
`node --check` + eslint clean (0 errors, only pre-existing warnings), and
`tests/alerts.test.js` covers the venue-rewrite-vs-wrong-ticker distinction that
decides whether an alert is rolled back (10 assertions).
