# PLAN — asat2094/tradingview-mcp

Blueprint for evolving this fork (base = tradesdontlie Node.js + CDP) into a unified MCP server that:
1. Adds API-only tooling ported from `atilaahmettaner/tradingview-mcp` (Python)
2. Extends into an India-focused trading ecosystem (brokers + WS streaming + signal engine + Pine helpers)
3. Stays standalone — single `npm install` / `npx` distribution, no required external SaaS

## Guiding principles

1. **API-first.** Wherever a TradingView REST/JSON endpoint exists, use it. Only fall back to CDP (TV Desktop control) when no API exists (Pine editor, chart drawing, replay UI, multi-pane layout).
2. **Standalone.** Single npm package. Required deps via `package.json`. No external MCP relays *required* (Kite delegate is optional).
3. **Read-only execution by default.** Order placement gated behind explicit user discretion. Signal-first product.
4. **India-focused.** Native support for Upstox, Delta India, CoinDCX. Kite via mcp.kite.trade (free). NSE/BSE equities, Indian crypto spot, Indian crypto F&O.
5. **One commit per feature.** Reviewable diff history. Group A–G + India + streaming + signal + PR.

## Current base

- Lang: Node.js (ES Modules)
- MCP SDK: `@modelcontextprotocol/sdk` ^1.12
- CDP client: `chrome-remote-interface` ^0.33
- Validation: `zod`
- 79 tools across `src/tools/{alerts,batch,capture,chart,data,drawing,health,indicators,pane,pine,replay,tab,ui,watchlist}.js`
- Architecture: `src/tools/<category>.js` registers via `server.tool(...)`; logic in `src/core/<service>.js`
- TV Desktop dependency: required for CDP-based tools

## Target state

```
asat2094/tradingview-mcp
├── src/
│   ├── server.js                MCP entry — registers all tools
│   ├── connection.js            CDP connection management
│   ├── core/                    Logic per service
│   │   ├── (existing CDP services)
│   │   ├── yahoo.js             Yahoo Finance wrapper (yahoo-finance2)
│   │   ├── tv_screener.js       scanner.tradingview.com client (port of tradingview-screener Py)
│   │   ├── tv_ta.js             tradingview_ta endpoint client
│   │   ├── reddit.js            Reddit JSON for sentiment
│   │   ├── rss.js               RSS feed reader (rss-parser)
│   │   ├── indicators_calc.js   Local TA calcs (RSI/SMA/EMA/MACD/BB/ATR/Supertrend/Donchian)
│   │   ├── backtest.js          Bar-by-bar simulator (port of Python bt)
│   │   ├── walk_forward.js      Walk-forward harness
│   │   ├── egx_data.js          EGX sector + index static data
│   │   ├── llm_compose.js       Multi-agent / combined analysis composers
│   │   ├── brokers/
│   │   │   ├── upstox.js        upstox-js-sdk wrapper (read-only)
│   │   │   ├── delta_india.js   Delta India REST + WS (hand-port)
│   │   │   └── coindcx.js       CoinDCX REST + WS (hand-port)
│   │   ├── streaming/
│   │   │   ├── manager.js       WS subscription registry
│   │   │   ├── ring.js          In-mem ring buffer per symbol
│   │   │   └── duck.js          DuckDB persistence (npm:duckdb-async)
│   │   ├── signals/
│   │   │   ├── dsl.js           JSON DSL parser/evaluator
│   │   │   ├── nl2dsl.js        LLM helper for NL → DSL
│   │   │   ├── engine.js        Per-tick evaluator
│   │   │   └── sink.js          jsonl + MCP resource + poll sink
│   │   └── pine_validator.js    Wraps translate_light HTTP endpoint
│   └── tools/                   MCP tool surface
│       ├── (existing tool files)
│       ├── snapshots.js         Group A: Yahoo (6 tools)
│       ├── reference.js         Group B1: static reference
│       ├── news.js              Group B2: RSS news
│       ├── sentiment.js         Group B3: Reddit sentiment
│       ├── tv_ta.js             Group C: per-symbol TA (3)
│       ├── screener.js          Group D: TV screener (8)
│       ├── composed.js          Group E: multi-agent + combined (2)
│       ├── egx.js               Group F: EGX (7)
│       ├── backtest.js          Group G: backtest (3)
│       ├── brokers.js           India brokers (read-only first)
│       ├── stream.js            WS subscribe/poll
│       ├── signal.js            Signal DSL + sink
│       └── pine_dev.js          Pine generator + validator (API-only)
├── tests/                       Unit + smoke
├── PLAN.md                      This file
├── package.json                 Adds: yahoo-finance2, rss-parser, talib-binding or technicalindicators, duckdb-async, upstox-js-sdk, dotenv, ws
└── README.md                    Updated with new tool inventory + setup
```

## Phase 1 — Port 32 atilaahmettaner tools (current branch: feat/atilaahmettaner-tools)

Per-tool commit. Pattern:
```
feat(tools): port <tool_name>

Ports atilaahmettaner/.../<service>.py to JS.
- Tool: src/tools/<file>.js
- Core: src/core/<file>.js
- Test: tests/<tool>.test.js (node --test)
```

### Group A — Yahoo (6)
1. yahoo_price
2. market_snapshot
3. bitcoin_market_pulse
4. stock_extended_hours
5. stock_options_chain
6. stock_options_unusual_activity

Dep: `yahoo-finance2`. Sets the Yahoo-side plumbing.

### Group B — Reference / sentiment / news (3)
7. exchanges_list
8. financial_news (dep: `rss-parser`)
9. market_sentiment (Reddit JSON via built-in fetch)

### Group C — TV TA per-symbol (3)
10. coin_analysis
11. multi_timeframe_analysis
12. volume_confirmation_analysis

Port `tradingview_ta` Py lib to JS module hitting `https://scanner.tradingview.com/{exchange}/scan` with appropriate filter spec. Output mirror.

### Group D — TV screener (8)
13. top_gainers
14. top_losers
15. bollinger_scan
16. rating_filter
17. consecutive_candles_scan
18. advanced_candle_pattern
19. volume_breakout_scanner
20. smart_volume_scanner

Port `tradingview-screener` Py lib to JS (`scanner.tradingview.com` POST with columns/filters/sort).

### Group E — Composed (2)
21. multi_agent_analysis (3-agent prompt; LLM done by Claude — server just composes & formats)
22. combined_analysis (TA + sentiment + news convenience tool)

### Group F — EGX (7)
23. egx_market_overview
24. egx_sector_scan
25. egx_sector_scanner
26. egx_index_analysis
27. egx_stock_screener
28. egx_trade_plan
29. egx_fibonacci_retracement

Port EGX static data (sector lists, index constituents) + screener wrappers.

### Group G — Backtest (3)
30. backtest_strategy (RSI/Bollinger/MACD/EMA cross/Supertrend/Donchian)
31. compare_strategies (rank all 6)
32. walk_forward_backtest_strategy (overfitting detector)

Port Python bar-by-bar simulator to JS using `technicalindicators` or `talib-binding` for indicator calcs.

## Phase 1.5 — Hyperliquid crypto data layer (add-on)

[Hyperliquid](https://api.hyperliquid.xyz/info) — decentralized perps exchange with **public, key-free REST + WebSocket API**. Coverage: BTC, ETH, SOL, ARB + 100+ perps with live tickers, orderbook depth, funding rates, OI, OHLCV.

**Tools to add:**
- `hyperliquid_meta` → list all perps + leverage/margin tables (single call)
- `hyperliquid_ticker(coin)` → mark price, oracle price, funding, OI, day volume
- `hyperliquid_orderbook(coin, n_levels?)` → L2 book snapshot
- `hyperliquid_candles(coin, interval, lookback_hours)` → OHLCV (1m/5m/15m/1h/4h/1d)
- `hyperliquid_funding(coin)` → funding rate history
- `hyperliquid_open_interest_history(coin)` → OI series

Use cases: BTC/ETH perp screener (funding extremes), OI divergence detector, alt regime detection vs spot.

Effort: ~0.5 day (pure REST + WS, no auth).

## Phase 2 — India broker ecosystem

| Broker | Type | Implementation | Status |
|---|---|---|---|
| **Zerodha Kite** | NSE/BSE equities + F&O | Delegate to `mcp.kite.trade` (separate MCP user installs) | Documented in README |
| **Upstox** | NSE/BSE equities + F&O | `upstox-js-sdk` wrapper. OAuth flow. Read-only first. | Code in `src/core/brokers/upstox.js` |
| **Delta Exchange India** | Crypto F&O | Hand-port REST + WS (HMAC API key) | `src/core/brokers/delta_india.js` |
| **CoinDCX** | Indian crypto spot | Hand-port REST + WS (HMAC API key) | `src/core/brokers/coindcx.js` |

**Tools exposed (read-only first):**
- `broker_holdings(broker)` → unified holdings
- `broker_positions(broker)` → unified positions
- `broker_orders(broker, status?)` → order history
- `broker_funds(broker)` → margins / balances
- `broker_ltp(broker, symbol)` → last traded price

**Execution is OUT OF SCOPE for phase 2.** Signal-first. Order placement defer to phase 3 with explicit user gate.

**Secrets:** `.env` file at `~/.tradingview-mcp/.env` with broker keys. Schema-validated on startup via `dotenv` + `zod`.

## Phase 3 — WS streaming + signal engine

### Streaming
- `subscribe_ticker(broker, symbol)` → starts WS in background, returns subscription_id
- `subscribe_orderbook(broker, symbol, depth?)` → orderbook stream
- `subscribe_ohlcv(broker, symbol, timeframe)` → bar stream
- `get_latest_tick(subscription_id)` / `get_recent_ticks(subscription_id, n)` → poll hot ring buffer
- `query_ticks(symbol, from, to)` → DuckDB historical query
- `unsubscribe(subscription_id)`
- `list_subscriptions()`

Hot path: in-mem ring buffer (deque per symbol, last 1000 ticks). Cold path: async batch flush to DuckDB (`~/.tradingview-mcp/ticks.duckdb`). Survives restarts. Fast analytical queries.

### Signal engine
- `signal_register(name, dsl)` → register JSON DSL rule
- `signal_register_nl(name, natural_language)` → LLM helper converts NL → DSL (Claude does it, server validates)
- `signal_list()` / `signal_remove(name)`
- `signal_active()` → list signals fired but not acknowledged
- `signal_ack(signal_id)` → mark consumed

**DSL example:**
```json
{
  "name": "btc_oversold_bounce",
  "symbol": "BTCUSDT",
  "exchange": "delta",
  "timeframe": "15m",
  "conditions": [
    { "indicator": "rsi", "period": 14, "op": "<", "value": 30 },
    { "indicator": "close", "op": ">", "ref": { "indicator": "ema", "period": 50 } }
  ],
  "all_conditions_required": true,
  "cooldown_seconds": 3600
}
```

**Hybrid sink:**
- Append to `~/.tradingview-mcp/signals.jsonl` (audit)
- Expose MCP resource `signal://active` (Claude Code 2025-06+ resource subscription)
- Polling tool `signal_active()` fallback

## Phase 4 — Pine integration (API-only)

Already in develop: `pine_check` (translate_light HTTPS, Guest), `pine_analyze` (offline static analysis), `pine_get/set/save/open/list/compile/smart_compile/get_errors/get_console/new` (UI/CDP-mediated).

**Additions:**
- `pine_generate(nl_prompt)` → LLM generates Pine v5 code from NL description. Output as string. Claude does the LLM work; server provides prompt template + post-processing.
- `pine_validate(source)` → wraps `pine_check`. Pure API.
- `pine_combine_validate(source)` → `pine_analyze` (local) + `pine_check` (API) in one call.

**Out of scope:** Building our own Pine v5 interpreter. Pine execution is TV's job — user opens the script in TV chart for actual backtest.

## Phase 5 — Polish + npm publish

- Update README with full tool inventory (~111 tools end-state)
- Add SETUP_GUIDE for India brokers (.env scaffold per broker)
- Add INDIA_USAGE.md examples (Nifty scan → broker LTP → signal register → notification)
- Bump version to 3.0.0 (semantic break — new tools + new arch surface)
- Publish to npm as `@asat2094/tradingview-mcp` or similar scoped name
- MCP install one-liner: `claude mcp add tradingview --scope local -- npx @asat2094/tradingview-mcp`

## Open questions / risks

| Q/Risk | Mitigation |
|---|---|
| Yahoo Finance API rate limits | yahoo-finance2 has built-in throttle. Cache common quotes 60s. |
| TV scanner endpoint changes shape | Wrap in try/catch; fallback to cached schema; user-visible warning. |
| TV pine-facade rejects Guest user | Build retry with rotating user_name; document workaround. |
| Indian broker SDK gaps (CoinDCX/Delta no official JS SDK) | Hand-port. Reference Python community libs. |
| WS reconnect/backpressure | Exponential backoff, ring buffer drop-oldest, watchdog. |
| Pine compile rate limit on translate_light | 60s cache by source hash. |
| DuckDB single-file lock contention | One writer process. Tools acquire shared read locks. |

## Timeline

| Phase | Tools | Effort (Claude-driven) |
|---|---|---|
| 1: Port 32 atilaahmettaner tools | 32 | ~3 days |
| 2: India brokers (read-only) | 5 unified + per-broker auth | ~1 day |
| 3: WS streaming + signal engine | ~12 | ~1 day |
| 4: Pine helpers | 3 | ~0.5 day |
| 5: Polish + publish | — | ~0.5 day |
| **Total** | **~52 new tools, end-state ~111** | **~6 days** |

## Branch / PR workflow

1. `feat/atilaahmettaner-tools` off `develop` — Phase 1 commits (32)
2. `feat/india-brokers` off above — Phase 2
3. `feat/streaming-signal` off above — Phase 3
4. `feat/pine-api` off above — Phase 4
5. Merge each feature → `develop`
6. Final `develop` → `main` merge after Phase 5

Each feature branch raises its own PR. Reviewable in chunks.
