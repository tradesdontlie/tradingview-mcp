// Upstox (NSE/BSE equities + F&O) read-only client.
// Uses Upstox API v2 REST. OAuth access token required (UPSTOX_ACCESS_TOKEN).
// Tokens are short-lived — refresh via Upstox login URL daily ~9am IST.

import { get, requireKeys } from '../secrets.js';

const BASE = 'https://api.upstox.com/v2';

const TIMEOUT_MS = 15_000;

async function authed(path) {
  const { UPSTOX_ACCESS_TOKEN } = requireKeys(['UPSTOX_ACCESS_TOKEN']);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch {}
      throw new Error(`Upstox ${r.status}: ${detail.slice(0, 200)}`);
    }
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function holdings() { return authed('/portfolio/long-term-holdings'); }
export async function positions() { return authed('/portfolio/short-term-positions'); }
export async function orders() { return authed('/order/retrieve-all'); }
export async function funds() { return authed('/user/get-funds-and-margin'); }

export async function ltp(instrumentKey) {
  // instrumentKey example: NSE_EQ|INE002A01018 (Reliance)
  return authed(`/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`);
}

export function configured() {
  return Boolean(get('UPSTOX_ACCESS_TOKEN'));
}
