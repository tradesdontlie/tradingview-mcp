<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# Git Workflow — Fork-Based Contribution

This repo uses a **fork-and-PR** model. There are two remotes:

| Remote | URL | Role |
|---|---|---|
| `origin` | `tradesdontlie/tradingview-mcp` | Upstream. **Read-only for this account** — `git push origin` returns `403 Permission denied`. |
| `fork` | `SAK1337/tradingview-mcp` | Your writable fork. **All pushes go here.** |

When committing/pushing/opening a PR:
1. Branch off `main` (never commit directly to `main`).
2. Push to the fork: `git push -u fork <branch>` (a bare `git push` may try `origin` and 403 — always name `fork`).
3. Open the PR against upstream with an explicit cross-repo head:
   `gh pr create --repo tradesdontlie/tradingview-mcp --base main --head SAK1337:<branch> ...`
4. **Merging is NOT possible from this account** — `gh pr merge` returns
   `SAK1337 does not have the correct permissions to execute MergePullRequest`. An upstream maintainer
   (write access to `tradesdontlie`) merges the PR via the GitHub UI; the repo uses merge commits
   (see history, e.g. "Merge pull request #3 from SAK1337/…").

# TradingView MCP — Claude Instructions

78 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs
5. `data_get_pine_graphics` → all four of the above in ONE CDP round-trip (one `model.dataSources()` scan). **Preferred for the full "Analyze my chart" / report pass**; use the per-type tools only for targeted reads.

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "crossing_up", "crossing_down" — the only operators the live TradingView alert dialog offers for a price alert; the condition is applied + read back, not echoed)
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## Running Reports

This repo has a prompt-driven report pipeline. Each symbol has its own prompt file with the exact workflow for generating a styled HTML + PDF technical analysis report from the live chart state.

### Available report prompts

Located in `Prompts/`:

| Prompt | Symbol | Timeframe | Indicator suite |
|---|---|---|---|
| `Prompts/SOLUSDT.txt` | BINANCE:SOLUSDT | 1W | 30W SMA + MarketCipher_A/B + Prophesier v5.20 + v6.10 + Prophet (HA) |
| `Prompts/ETHUSDT.txt` | BINANCE:ETHUSDT | 1D | 4 MAs (20 EMA + 30 + 50 + 200 SMA) + same proprietary stack as SOL (HA) |
| `Prompts/HYPEUSDC.txt` | COINBASE:HYPEUSDC.P | 1D | 3 MAs (10 EMA + 30 + 40 SMA) + MarketCipher_A/B + Prophet + Prophesier v6.10 only (HA) |
| `Prompts/BTCUSDT.txt` | BINANCE:BTCUSDT | 1D | 3 custom SMAs (50/100/200) + Sibyl + MarketCipher_B + Prophesier v6.00 (regular candles, **not** HA) |

Each prompt is self-contained and reflects that chart's specific indicator layout. The differences matter — Prophesier v6.00 (on BTC) lacks the multi-timeframe RSI table that v6.10 (on SOL/ETH/HYPE) emits, so the BTC report omits that section.

### How to run a report

1. **Tell Claude** to "run the SOL report" / "generate today's HYPE report" / "update the BTC report" etc. Claude reads the matching prompt from `Prompts/<SYMBOL>.txt` and follows it.
2. The prompt's Section 2 is idempotent — if the chart layout already matches what the prompt expects, setup is skipped and only data gathering runs.
3. **Today's date** comes from the session date context (don't pass it explicitly — Claude uses the system date).

### Report pipeline overview

Every prompt follows the same 8-step pipeline:

1. **Verify CDP connection** (`node src/bin.js cli status`). If broken, use the `launch-tradingview` skill.
2. **Inspect chart state** — if it matches the prompt's expected indicator/timeframe/chart-type set, skip step 3.
3. **Set up the chart** (only if needed) — add missing built-in MAs. **Do not programmatically re-add commercial studies** (MarketCipher, Prophesier, Prophet, Sibyl) — they hold the user's hand-tuned settings.
4. **Gather data** — quote, OHLCV summary, indicator values, Prophesier v6.10 MTF RSI table (if present), pine labels/lines/boxes, user drawings. Send `node src/bin.js cli ui keyboard --key Escape` first to dismiss any MarketCipher alert dialogs that may have popped open.
5. **Zoom + screenshot** — each prompt specifies a different zoom range (30 days for SOL daily, 30 weeks for SOL weekly, 60 days for HYPE, 120 days for BTC, 120 days for ETH).
6. **Build the HTML report** — uses a placeholder `__CHART_B64__` for the embedded screenshot to keep the 300+ KB base64 out of LLM context. Inject via PowerShell:
   ```powershell
   $tpl = [IO.File]::ReadAllText('.report_template.html')
   $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('<screenshot.png>'))
   [IO.File]::WriteAllText('Reports\<SYMBOL>1D-<date>.html', $tpl.Replace('__CHART_B64__',$b64), [Text.UTF8Encoding]::new($false))
   ```
   Then delete the template.
7. **Generate the PDF** via `python scripts/html_to_pdf.py Reports/<SYMBOL>1D-<date>.html` (or invoke the `html-to-pdf` skill).
8. **Report results** with the file paths and sizes. By convention, also open the PDF: `Invoke-Item 'Reports\<file>.pdf'`.

### Report filename convention

`Reports/<SYMBOL><TIMEFRAME>-<YYYY-MM-DD>.html` (and `.pdf` next to it). Examples:
- `Reports/SOLUSDT1W-2026-05-20.html` (weekly SOL)
- `Reports/BTCUSDT1D-2026-05-20.html` (daily BTC)
- `Reports/ETHUSDT1D-2026-05-21.html` (daily ETH)

A daily run overwrites the same-date file. A new day creates a new file; old reports stay as historical record.

### Snapshot-only refresh (no narrative changes)

When the user says "redo the chart snapshot" or "refresh the picture" and the numbers haven't changed meaningfully, use a targeted base64 swap instead of rebuilding the whole template:

```powershell
$html = [IO.File]::ReadAllText('Reports\<SYMBOL>1D-<date>.html')
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('<new>.png'))
$new = [regex]::Replace($html, '(data:image/png;base64,)[A-Za-z0-9+/=]+', "`$1$b64")
[IO.File]::WriteAllText('Reports\<SYMBOL>1D-<date>.html', $new, [Text.UTF8Encoding]::new($false))
```

Then re-run `html_to_pdf.py` to regenerate the PDF.

### Adding a new report symbol

To add a new symbol (e.g., `LINKUSDT.txt`):
1. Switch the chart to the symbol (`node src/bin.js cli symbol "BINANCE:LINKUSDT"`) and let the user verify their preferred indicator/MA setup.
2. Run `state`, `draw list`, `values`, and `data tables` to capture the actual indicator suite.
3. Copy the closest existing prompt (HYPE for daily-HA, BTC for daily-regular-candles, SOL for weekly) and adapt:
   - Update symbol, timeframe, chart type expectations
   - Update the studies list in Section 2 with the actual entity names
   - Note any unique/missing indicators in a "differences from SOL/HYPE" callout
   - Update Section 5's zoom window if the symbol's bar density warrants it
4. Add the new prompt to the table at the top of this section.

### Cross-chart indicator persistence

TradingView keeps indicator state per chart tab, not per symbol. The SOL and ETH charts in this repo share a tab — adding MAs on one is visible on the other. The BTC and HYPE charts each have their own tab. When in doubt, run `state` after switching symbols and check whether the indicator list matches the prompt's expectations; if not, the user may need to use a separate chart tab for that symbol.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tradingview-mcp** (1500 symbols, 2795 relationships, 123 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tradingview-mcp/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tradingview-mcp/clusters` | All functional areas |
| `gitnexus://repo/tradingview-mcp/processes` | All execution flows |
| `gitnexus://repo/tradingview-mcp/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
