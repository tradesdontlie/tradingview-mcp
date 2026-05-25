// Hyperliquid public API client (no key, no auth).
// Decentralized perps exchange. Coverage: BTC, ETH, SOL, 100+ coins.
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/

const BASE = 'https://api.hyperliquid.xyz/info';
const TIMEOUT_MS = 10_000;

async function post(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function meta() {
  return post({ type: 'meta' });
}

export async function metaAndAssetCtxs() {
  // Returns [meta, asset_ctxs] — asset_ctxs has live ticker fields per perp.
  return post({ type: 'metaAndAssetCtxs' });
}

export async function l2Snapshot({ coin, nLevels }) {
  const r = await post({ type: 'l2Book', coin });
  if (!r || !Array.isArray(r.levels)) return r;
  if (nLevels) {
    return {
      coin,
      time: r.time,
      bids: (r.levels[0] || []).slice(0, nLevels),
      asks: (r.levels[1] || []).slice(0, nLevels),
    };
  }
  return r;
}

export async function candleSnapshot({ coin, interval, startTime, endTime }) {
  const intervalMs = {
    '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000,
    '1h': 60 * 60_000, '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000,
  }[interval] || 60 * 60_000;
  const end = endTime || Date.now();
  const start = startTime || (end - 100 * intervalMs);
  return post({
    type: 'candleSnapshot',
    req: { coin, interval, startTime: start, endTime: end },
  });
}

export async function fundingHistory({ coin, startTime, endTime }) {
  const end = endTime || Date.now();
  const start = startTime || (end - 7 * 24 * 60 * 60_000);
  return post({ type: 'fundingHistory', coin, startTime: start, endTime: end });
}

// Pull live ticker derived from metaAndAssetCtxs.
export async function getTicker(coin) {
  const r = await metaAndAssetCtxs();
  if (!Array.isArray(r) || r.length < 2) return { coin, error: 'unexpected response' };
  const [m, ctxs] = r;
  const universe = m?.universe || [];
  const idx = universe.findIndex(u => u.name === coin);
  if (idx < 0) return { coin, error: `coin ${coin} not in universe` };
  const ctx = ctxs[idx] || {};
  return {
    coin,
    mark_price: (ctx.markPx != null ? Number(ctx.markPx) : null),
    oracle_price: (ctx.oraclePx != null ? Number(ctx.oraclePx) : null),
    funding: (ctx.funding != null ? Number(ctx.funding) : null),
    open_interest: (ctx.openInterest != null ? Number(ctx.openInterest) : null),
    day_volume: (ctx.dayNtlVlm != null ? Number(ctx.dayNtlVlm) : null),
    prev_day_px: (ctx.prevDayPx != null ? Number(ctx.prevDayPx) : null),
    impact_pxs: ctx.impactPxs,
    timestamp: new Date().toISOString(),
  };
}
