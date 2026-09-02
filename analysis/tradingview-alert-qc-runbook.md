# TradingView Alert QC runbook

This monitor is a read-only evidence collector. It exports the authenticated TradingView Desktop Alerts Log as CSV, preserves the raw file, records source firing time separately from import time, reconciles a frozen expected configuration against a fresh alert inventory, and writes a deterministic report plus reviewer-only proposals. It does not create, delete, edit, rotate, or reconfigure alerts or charts, and it does not use a public webhook.

## Installed code and command

- Retained code location: `/Users/odin/.codex/worktrees/5082/Tradingview`
- Daily command: `/opt/homebrew/bin/node /Users/odin/.codex/worktrees/5082/Tradingview/analysis/run-tradingview-alert-qc.mjs`
- Frozen expected configuration: `/Users/odin/.codex/worktrees/5082/Tradingview/analysis/tradingview-alert-qc-expected.json`
- Private QC home: `/Users/odin/.codex/tradingview-alert-qc`
- Private raw CSVs: `/Users/odin/.codex/tradingview-alert-qc/raw`
- Private occurrence ledger and collection state: `/Users/odin/.codex/tradingview-alert-qc/runtime`
- Private daily JSON and Markdown reports: `/Users/odin/.codex/tradingview-alert-qc/reports`
- Reviewer-only Obsidian proposal list: `/Users/odin/projects/omega/wiki/codebases/tradingview-mcp/investment-attention-alert-qc-improvements.md`

The runtime creates one writer lock under the private QC home. The scheduled task is the sole intended recurring writer. A missing or held lock fails closed; it never overwrites another run.

## Evidence boundaries

The CSV `Time` field is the source firing time. The collector's `imported_at` is separate. Stable occurrence IDs deduplicate exact overlap/re-imports while retaining the same alert ID at different source times as genuine repeated firings. One CSV row remains one notification; semicolon-separated `FIRED:` blocks are counted separately as signal blocks.

The export path and six-column schema are proven against the currently authenticated open TradingView Desktop session. Retention horizon, pagination/completeness, and restart recovery are not yet proven, so every report marks history completeness as `unproven`. `last_fired` from the alert inventory is metadata only and is never treated as firing history.

The expected file is frozen and is never rebuilt from a live observation. It contains the reviewed 34-alert baseline (4 SMA/Fib, 24 RSI, and 6 Cup pilots); each RSI row retains semantic inputs through `in_52`, including scanner slots `in_23..in_52`. The reviewed mapping covers 33 unique non-empty feed symbols on each of the D and W timeframes, with no duplicate or extra mapping and no alert rollout performed. Script ID/version and input identity are compared when visible. Missing deployed source hash or definition proof remains `unverified`; expected hashes are never substituted as observed hashes.

An RSI miss sample is classified only when the optional `/Users/odin/.codex/tradingview-alert-qc/runtime/independent-rsi-reference.json` is explicitly marked independent and verified and matches source, input, and route identity. No chart rotation or four-canary weekly gate is part of this daily monitor.

## Scheduled execution

The planner-accepted standalone Codex automation is `daily-tradingview-alert-quality-check` (ACTIVE). It runs daily, including weekends, at 09:00 Europe/Rome with model `gpt-5.6-sol` and reasoning `medium`, using the saved Tradingview project only as context. Each run calls the retained worktree command above once and leaves the saved checkout untouched. It stays quiet for unchanged results and known evidence limits and notifies only for new or materially changed actionable findings, collection failures, or a required decision.

## Workspace boundaries

This worktree is the retained implementation location. The saved project `/Users/odin/projects/Tradingview` was dirty with unrelated user changes and was not edited. The live release worktree `/Users/odin/.codex/worktrees/ac77/Tradingview` and its existing `com.viktor.tradingview.investment-attention` 15-minute LaunchAgent were preserved. Historical runtime files and the prior monitoring loop remain separate.

The automation was created only after review of the first real report. Its persisted settings are recorded in `/Users/odin/.codex/automations/daily-tradingview-alert-quality-check/automation.toml`; the existing 15-minute LaunchAgent remains separate and unchanged.
