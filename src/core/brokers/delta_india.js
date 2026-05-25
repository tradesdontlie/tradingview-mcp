// Delta Exchange India read-only client.
// HMAC-SHA256 signed requests. Docs: https://docs.delta.exchange/

import crypto from 'node:crypto';
import { get, requireKeys } from '../secrets.js';

function baseUrl() {
  return get('DELTA_INDIA_BASE_URL') || 'https://api.india.delta.exchange';
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function signedGet(pathAndQuery) {
  const { DELTA_INDIA_API_KEY, DELTA_INDIA_API_SECRET } = requireKeys([
    'DELTA_INDIA_API_KEY', 'DELTA_INDIA_API_SECRET',
  ]);
  const ts = Math.floor(Date.now() / 1000).toString();
  // signature_data = method + timestamp + requestPath + queryString + body
  // queryString must NOT include the leading '?' per Delta India v2 spec.
  const url = new URL(pathAndQuery, baseUrl());
  const requestPath = url.pathname;
  const queryString = url.search ? url.search.slice(1) : '';
  const payload = 'GET' + ts + requestPath + queryString + '';
  const signature = sign(DELTA_INDIA_API_SECRET, payload);

  const r = await fetch(url.toString(), {
    headers: {
      'api-key': DELTA_INDIA_API_KEY,
      timestamp: ts,
      signature,
      Accept: 'application/json',
    },
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch {}
    throw new Error(`Delta India ${r.status}: ${detail.slice(0, 200)}`);
  }
  return r.json();
}

async function publicGet(pathAndQuery) {
  const r = await fetch(new URL(pathAndQuery, baseUrl()));
  if (!r.ok) throw new Error(`Delta India ${r.status}`);
  return r.json();
}

export async function products() { return publicGet('/v2/products'); }
export async function tickers() { return publicGet('/v2/tickers'); }
export async function ticker(symbol) { return publicGet(`/v2/tickers/${encodeURIComponent(symbol)}`); }
export async function walletBalances() { return signedGet('/v2/wallet/balances'); }
export async function openPositions() { return signedGet('/v2/positions'); }
export async function orderHistory({ state = 'open', limit = 50 } = {}) {
  return signedGet(`/v2/orders/history?state=${encodeURIComponent(state)}&page_size=${limit}`);
}

export function configured() {
  return Boolean(get('DELTA_INDIA_API_KEY') && get('DELTA_INDIA_API_SECRET'));
}
