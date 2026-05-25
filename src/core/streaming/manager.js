// WS subscription manager. Pluggable per-source adapter.
//   hyperliquid  — public, trades stream by coin
//   delta_india  — public, v2/ticker stream for India perps + futures
//   (upstox + coindcx adapters deferred — different auth + protocols)

import { WebSocket } from 'ws';
import { RingBuffer } from './ring.js';

const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const DELTA_INDIA_WS = 'wss://socket.india.delta.exchange';

const subs = new Map(); // sub_id -> { source, coin, ring, ws, started_at }
let nextId = 1;

function makeId(prefix) {
  return `${prefix}_${(nextId++).toString(36)}`;
}

// Hyperliquid trades subscribe ── sends { method: 'subscribe', subscription:{ type:'trades', coin } }
function hyperliquidSubscribe({ coin }) {
  const sub_id = makeId('hl');
  const ring = new RingBuffer(2000);
  const ws = new WebSocket(HL_WS);
  let alive = false;

  ws.on('open', () => {
    alive = true;
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'trades' && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          ring.push({
            ts: t.time,
            price: Number(t.px),
            size: Number(t.sz),
            side: t.side,
            tid: t.tid,
          });
        }
      }
    } catch { /* skip bad frames */ }
  });
  ws.on('close', () => { alive = false; });
  ws.on('error', () => { alive = false; });

  const entry = {
    source: 'hyperliquid',
    coin,
    ring,
    ws,
    started_at: new Date().toISOString(),
    get alive() { return alive; },
  };
  subs.set(sub_id, entry);
  return { sub_id, source: 'hyperliquid', coin };
}

// Delta India: public ticker channel (no auth) for market data. Subscribes
// to v2/ticker.{symbol}. Symbol examples: BTCUSD, ETHUSD perps, BTC_FUT.
function deltaIndiaSubscribe({ coin: symbol }) {
  const sub_id = makeId('di');
  const ring = new RingBuffer(2000);
  const ws = new WebSocket(DELTA_INDIA_WS);
  let alive = false;

  ws.on('open', () => {
    alive = true;
    ws.send(JSON.stringify({
      type: 'subscribe',
      payload: {
        channels: [{ name: 'v2/ticker', symbols: [symbol] }],
      },
    }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // v2/ticker frames carry mark_price + close + high/low + funding etc.
      if (msg.type === 'v2/ticker' && msg.symbol === symbol) {
        ring.push({
          ts: msg.timestamp,
          price: Number(msg.mark_price ?? msg.close),
          mark: Number(msg.mark_price),
          close: Number(msg.close),
          high: Number(msg.high),
          low: Number(msg.low),
          volume: Number(msg.volume),
          funding_rate: Number(msg.mark_basis ?? 0),
        });
      }
    } catch { /* skip bad frames */ }
  });
  ws.on('close', () => { alive = false; });
  ws.on('error', () => { alive = false; });

  const entry = {
    source: 'delta_india',
    coin: symbol,
    ring,
    ws,
    started_at: new Date().toISOString(),
    get alive() { return alive; },
  };
  subs.set(sub_id, entry);
  return { sub_id, source: 'delta_india', coin: symbol };
}

export function subscribe({ source, coin }) {
  if (source === 'hyperliquid') return hyperliquidSubscribe({ coin });
  if (source === 'delta_india') return deltaIndiaSubscribe({ coin });
  throw new Error(`unknown source ${source}. supported: hyperliquid, delta_india`);
}

export function unsubscribe(sub_id) {
  const e = subs.get(sub_id);
  if (!e) return { sub_id, found: false };
  try { e.ws?.close(); } catch {}
  subs.delete(sub_id);
  return { sub_id, found: true };
}

export function list() {
  return Array.from(subs.entries()).map(([id, e]) => ({
    sub_id: id,
    source: e.source,
    coin: e.coin,
    started_at: e.started_at,
    alive: e.alive,
    buffer_size: e.ring.size(),
  }));
}

export function latest(sub_id) {
  const e = subs.get(sub_id);
  if (!e) return { sub_id, error: 'not found' };
  return { sub_id, coin: e.coin, latest: e.ring.latest() };
}

export function recent(sub_id, n = 20) {
  const e = subs.get(sub_id);
  if (!e) return { sub_id, error: 'not found' };
  return { sub_id, coin: e.coin, ticks: e.ring.recent(n) };
}

export function getRing(sub_id) {
  const e = subs.get(sub_id);
  return e ? e.ring : null;
}
