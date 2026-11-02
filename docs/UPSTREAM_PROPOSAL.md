# Permission-managed local bridge proposal

This branch is prepared separately from the full djmad fork. It keeps the upstream local-CDP bridge and all 84 existing MCP tool names. It adds nine generic tools: target_list, target_select, data_load_history, indicator_get_style, indicator_set_style, watchlist_get_sections, watchlist_create_section, watchlist_move_to_section, and strategy_prepare. There are 93 registered tools: 33 Read and 60 Write, each explicitly classified. Existing stdio startup and CLI command names remain available.

## Configuration and operation

Run from the repository root so the administrator and server use the same .env:

```sh
npm ci --ignore-scripts
npm run admin
npm start             # existing stdio behavior
npm run http          # opt-in Streamable HTTP plus activity dashboard
npm run sse           # opt-in legacy SSE plus activity dashboard
```

HTTP defaults to http://127.0.0.1:3333/mcp; legacy SSE uses /sse. The server binds to loopback by default. TV_CDP_HOST/TV_CDP_PORT (with CDP_HOST/CDP_PORT aliases) select the existing Desktop debug endpoint. Node.js >=20.19 is required by the patched runtime and lint dependencies.

The administrator lists tool descriptions and actual parameter schemas. R selects the Read preset, W Read/write, C Custom, Space toggles a tool, Enter shows details, L toggles metadata logging, F edits the screenshot folder, S saves, Q quits. Entering Custom preserves the current effective selection. Invalid paths and failed writes remain visible. Pasted control characters cannot execute administrator shortcuts. Unsaved changes can be discarded.

```dotenv
MCP_PERM_MODE=read
MCP_SCREENSHOT_DIR="D:\TradingView screenshots"
MCP_AUDIT_LOG=false
```

Without settings the compatibility default remains Read/write. Process environment overrides .env. Screenshot paths may be absolute or relative to the project root; empty resets the existing screenshots/ default. Configuration saves preserve unrelated lines and use atomic replacement. Server-owned CDP/batch screenshots read the current setting at each write. TradingView's own screenshot UI controls its own destination. There is no CSV output directory or price-data file export in this proposal.

Optional JSONL logging stores only tool identity, duration, outcome, and salted target hashes. No arguments, source code, account data, market-data results, or error bodies are retained. Files and rotation are bounded and logging failures do not replace tool results. The default .local/audit path is ignored by Git.

## Permission and compatibility boundaries

MCP tools and CLI commands share the catalog. Unknown tools are denied; startup rejects unclassified registration changes. Permission revocation is rechecked after a session's queue and before dispatch; reconnect to expose a newly enabled tool. An operation already executing is not cancelled.

Read means no chart/UI mutation, not a filesystem sandbox. capture_screenshot is classified as Write because it can write PNG files or trigger the native screenshot UI. General JavaScript/UI tools grant broad Desktop actions, so hiding a narrow operation does not prohibit equivalent actions through a separately enabled general automation tool.

All upstream tool names are preserved, including individual pine_* and replay_* actions. There are two deliberate behavioral safety changes:

- quote_get reads only the session-selected active instrument. A supplied symbol must match its full SOURCE:TICKER; a different or bare symbol is rejected. Use the existing chart_set_symbol explicitly when a chart change is authorized.
- Strategy data reads no longer open panels or unhide studies implicitly. The new Write-classified strategy_prepare performs that preparation explicitly.

Boolean inputs accept actual booleans or the explicit words true/false; the prior conversion of the string false to true is corrected, and numeric coercion is rejected.

Existing operations that open UI are classified conservatively as Write even where their names sound like reads: pine_get_source, pine_get_errors, pine_get_console, watchlist_get, indicator_search and capture_screenshot. Offline pine_analyze and existing pine_check remain Read. Their pre-existing network behavior is unchanged.

Each MCP session owns its target and CDP connection. target_select does not activate the UI. Multiple chart targets require an explicit target ID; disappearing targets never fall back to another chart. Per-session calls serialize, other sessions remain independent, and cleanup is bounded. Native tab mutations require a proven visible source chart and shell; ambiguous multiple windows/popouts or pre-existing unowned pickers fail closed. Pass layout in the initial tab_new operation rather than mutating an unowned picker.

History loading is bounded and does not call viewport setters or write market data. The existing OHLCV read tool retains its upstream 500-bar result cap. Pending/no-progress requests are reported as uncertain. Style changes allow only discoverable supported leaves and verify readback/rollback. Watchlist sections use native separator arrays through the selected Desktop context; the remote endpoint has no documented atomic compare-and-swap contract, so external concurrent edits remain a limitation. Unknown writes are never blindly replayed or rolled back.

Replay start accepts date-only UTC, explicit-offset ISO times or separate Unix seconds; stop verifies manager live state. Pine New/Open verifies a fresh bound editor model, cancels unsaved prompts, and guarded save/compile never silently falls back to Save. English UI or private-API changes can fail safely on other builds.

## Scope and provenance

Excluded from this PR branch: IHSG/strategy screeners, universe files, signal algorithms, Excel/report dependencies, news/fundamentals extensions, added Node-side TradingView data clients, market-data CSV exports, OHLCV folder configuration, bulk-export scripts, personal Pine identifiers/configurations, and full-fork operational ledgers. Those features remain in the owner's independent fork. Existing upstream networking (such as symbol search and Pine compile checks) is retained, not expanded by a new data client.

The proposal adapts selected local reliability work from open PRs 528, 543, 539, 538, 534, 548, 549, 537, 519, 491, 555, 522, 526, 506, 434 and 532, plus the window/history/grouping proposals discussed in issues 61, 512 and 410. Original upstream MIT attribution remains unchanged. These references credit source proposals and do not close their PRs or assert their complete implementations were merged.

## Verification boundary

Run npm run test:unit, npm run lint, and npm audit. The unit command discovers all non-e2e test files; existing public compiler API checks remain part of the inherited suite. Local HTTP tests exercise real MCP sessions with injected callbacks, and native adapter tests use fake CDP/page models. They do not establish live account writes or compatibility with every Desktop build.

This isolated worktree passed its own 335-test normal suite, with no failures or skips; lint reports zero errors and five existing unused-variable warnings, and npm audit reports zero known advisories. A subsequent conservative screenshot-classification adjustment passed 18 focused permission/compatibility/HTTP tests. The root will report its independent final run in the pull-request description.

Root then executed scripts/bridge-smoke.js against the actual local TradingView Desktop on the disposable layout named temp. The separate branch passed actual Streamable HTTP initialization, the 93-tool catalog, target_list/select, health, chart_get_state, active quote, a ten-bar OHLCV summary, study values and offline pine_analyze. Final chart identity, studies, drawings and viewport matched the initial read-only snapshot. No result payloads were retained and no files were written. Target selection only bound the requesting MCP session; it did not activate the UI.

No editor opening, Pine save, replay mutation/trade, watchlist write, or account action was exercised in this branch verification. The full fork's earlier broader live checks are not substituted for this separate-branch evidence.

Upstream prefers one focused change per PR; this remains a Draft architecture proposal for discussion of the coherent permission-managed bridge subset and possible incremental adoption.
