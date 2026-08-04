# Market Research Agent (standalone)

A standalone [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) agent that combines:

- **News** — built-in `WebSearch` / `WebFetch`
- **On-chain / crypto market data** — `mcp-servers/onchain-server.js` (CoinGecko + DefiLlama, no API key required)
- **Live TradingView chart** — the `tradingview-mcp` server in this repo (`../src/server.js`), for reading the chart currently open in TradingView Desktop

## Setup

```bash
cd standalone-agent
npm install
cp .env.example .env
# put your Anthropic API key in .env
```

## Run

```bash
npm start -- "What's the sentiment on ETH right now, and how does that line up with the chart on my screen?"
```

The agent decides on its own which tools to call (news search, on-chain lookups, and/or the TradingView chart tools) based on the prompt. For chart-related questions, TradingView Desktop must be running with CDP enabled (`tv_launch` handles this automatically via the tradingview MCP server).

## Monitoring (scheduled runs)

`monitor.mjs` runs a set of prompts on a cron schedule instead of waiting for a manual call — useful for a background watcher that checks news/on-chain/chart on its own and logs what it finds.

Tasks are defined in [`monitor.config.json`](monitor.config.json):

```json
{
  "tasks": [
    { "name": "crypto-news-watch", "schedule": "0 * * * *", "prompt": "..." },
    { "name": "chart-check", "schedule": "*/15 * * * *", "prompt": "..." }
  ]
}
```

- `schedule` is a standard cron expression (minute hour day month weekday).
- Each task's output is appended to `logs/<name>.md` with a timestamp per run.

Run it with:

```bash
npm run monitor
```

Leave it running (e.g. in a terminal, `tmux`, or as a background process/service) — it stays alive and fires each task on its own schedule. Edit `monitor.config.json` and restart to change what's watched or how often.
