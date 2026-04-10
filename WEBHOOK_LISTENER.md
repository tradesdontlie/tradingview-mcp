# TradingView Webhook Listener

This repo now includes a small local-only webhook listener for TradingView alerts.
It is paper-trade only. It never connects to a broker, never places real orders, and only writes local files.

## What It Writes

- Append-only event queue:
  - `market/paper_trades/webhook_queue.jsonl`
- Per-session journal snapshots:
  - `market/paper_trades/webhook_journals/YYYY-MM-DD_SYMBOL_TRADEKEY.json`

Each webhook is stored as a raw event in the queue. If the payload includes a recognizable index symbol and mode is `journal` or `both`, the listener also updates a snapshot journal for the session.

## Run It

From the repo root:

```bash
python3 scripts/tradingview_webhook_listener.py --port 8787 --mode both
```

If you want a secret check, set:

```bash
export TV_WEBHOOK_SECRET='your-shared-secret'
python3 scripts/tradingview_webhook_listener.py --port 8787 --mode both
```

## TradingView Setup

Point your alert webhook URL to:

```text
http://127.0.0.1:8787/webhook
```

The listener also accepts `POST /alert`.

## Payload Format

The listener accepts:

- JSON bodies
- `key=value` form bodies
- simple `key: value` alert text

Useful fields:

- `symbol`, `ticker`, or `trading_symbol`
- `strategy` or `study`
- `event_type` / `event`
- `signal` / `action`
- `direction`
- `entry_price`
- `exit_price`
- `price`
- `timestamp`
- `session`
- `trade_id` or `signal_id`
- `secret`, `token`, or `webhook_secret`

## Example JSON

```json
{
  "secret": "your-shared-secret",
  "symbol": "NIFTY",
  "strategy": "index_midday_momentum",
  "event_type": "entry",
  "direction": "LONG",
  "entry_price": 23830.25,
  "timestamp": "2026-04-10T13:00:00+05:30",
  "session": "2026-04-10",
  "trade_id": "nifty-2026-04-10-01"
}
```

## Notes

- `queue` mode only appends raw events.
- `journal` mode only updates the session snapshot.
- `both` does both, which is the safest default for later processing.
- If the payload is missing a clear index symbol, the event still lands in the queue but no journal snapshot is created.
