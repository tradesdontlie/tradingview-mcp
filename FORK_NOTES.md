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

## Open upstream-facing work (optional)

Draft issue reports for the two unreported bugs we patched exist in local development notes. Paste at https://github.com/tradesdontlie/tradingview-mcp/issues/new when you want maintainer attention. Issues:

- `data_get_pine_labels` silently truncates to 50 labels — default cap too low for real indicators
- `watchlist_get` returns `count: 0` when a different sidebar tab is active — TV lazy-renders hidden widgets
- `alert_create` DOM automation is stale — REST endpoint `pricealerts.tradingview.com/create_alert` works instead (this one may be especially valuable to the maintainer)
- `alert_delete` only supports `delete_all`, and even that opens a context menu — REST endpoint `pricealerts.tradingview.com/delete_alerts` supports native bulk delete by ID
