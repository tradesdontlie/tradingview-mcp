---
name: codex-tradingview
description: Use when Codex is working inside this repository and needs to inspect or control TradingView through the local CLI wrapper.
---

# Codex TradingView Entry Workflow

Use `node scripts/tv-agent.js` as the default entrypoint.

## Entry workflow

1. Run `node scripts/tv-agent.js status`
2. If disconnected, run `node scripts/tv-agent.js launch --no-kill` first
3. Run `node scripts/tv-agent.js status` again

Workflow: status -> launch --no-kill -> status

## Default command sequences

- Chart snapshot: state -> values -> quote
- Price history: ohlcv --summary
- Price view: quote -> state
- Session check: status -> state
- Pine work: hand off to skills/pine-develop/SKILL.md
- Chart review: hand off to skills/chart-analysis/SKILL.md
- Multi-symbol scanning: hand off to skills/multi-symbol-scan/SKILL.md

## Guardrails

- Prefer small outputs first.
- Use the local wrapper instead of assuming `tv` is on `PATH`.
- Keep TradingView tasks anchored on the status / launch / status flow before deeper analysis.
