// CoinDCX read-only client. HMAC-SHA256 signed POSTs for private endpoints.
// Docs: https://docs.coindcx.com/

import crypto from 'node:crypto';
import { get, requireKeys } from '../secrets.js';

const TIMEOUT_MS = 15_000;

function baseUrl() {
  return get('COINDCX_BASE_URL') || 'https://api.coindcx.com';
}

async function withTimeout(fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fn(ctrl.signal); } finally { clearTimeout(timer); }
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function signedPost(path, extra = {}) {
  const { COINDCX_API_KEY, COINDCX_API_SECRET } = requireKeys([
    'COINDCX_API_KEY', 'COINDCX_API_SECRET',
  ]);
  const body = { timestamp: Date.now(), ...extra };
  const payload = JSON.stringify(body);
  const signature = sign(COINDCX_API_SECRET, payload);
  return withTimeout(async (signal) => {
    const r = await fetch(new URL(path, baseUrl()), {
      method: 'POST',
      headers: {
        'X-AUTH-APIKEY': COINDCX_API_KEY,
        'X-AUTH-SIGNATURE': signature,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: payload,
      signal,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch {}
      throw new Error(`CoinDCX ${r.status}: ${detail.slice(0, 200)}`);
    }
    return r.json();
  });
}

async function publicGet(path) {
  return withTimeout(async (signal) => {
    const r = await fetch(new URL(path, baseUrl()), { signal });
    if (!r.ok) throw new Error(`CoinDCX ${r.status}`);
    return r.json();
  });
}

export async function markets() { return publicGet('/exchange/v1/markets_details'); }
export async function tickers() { return publicGet('/exchange/ticker'); }
export async function userInfo() { return signedPost('/exchange/v1/users/info'); }
export async function balances() { return signedPost('/exchange/v1/users/balances'); }
export async function activeOrders() { return signedPost('/exchange/v1/orders/active_orders'); }
export async function tradeHistory({ limit = 50 } = {}) {
  return signedPost('/exchange/v1/orders/trade_history', { limit });
}

export function configured() {
  return Boolean(get('COINDCX_API_KEY') && get('COINDCX_API_SECRET'));
}
