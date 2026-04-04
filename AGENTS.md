# Codex TradingView Guidance

When working in this repository on TradingView tasks:

1. Read `skills/codex-tradingview/SKILL.md` first.
2. Use `node scripts/tv-agent.js` as the default entrypoint instead of assuming `tv` is on `PATH`.
3. Start with `node scripts/tv-agent.js status`.
4. If TradingView is not connected, run `node scripts/tv-agent.js launch`.
5. Re-run `node scripts/tv-agent.js status` after launch.
