// Phase 2C.1, Steps 1-6 — IBKR Client Portal Web API HTTP boundary.
// READ-ONLY. No orders/positions/account/trades/portfolio calls (Step 18).
// No credentials are ever stored here — the Client Portal Gateway handles
// its own browser-based login/2FA entirely outside this application; this
// client only issues plain HTTPS requests to an already-authenticated
// local gateway session (or receives an auth-required response, handled
// explicitly, never crashing pricing code).
//
// Uses the CURRENT market-data route (Step 1):
//   GET /iserver/marketdata/snapshot
// NOT the deprecated /md/regsnapshot.
//
// Base URL is configurable via IBKR_API_BASE_URL (Step 2) — defaults to
// https://localhost:5000/v1/api but never hard-codes port 5000 as the
// only option (Mac systems may already use that port for something else).

const DEFAULT_BASE_URL = 'https://localhost:5000/v1/api';

export function resolveBaseUrl(env = process.env) {
  return env.IBKR_API_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] - defaults to resolveBaseUrl()
 * @param {typeof fetch} [opts.fetchImpl] - injectable for testing (Step 32: no live auth needed for tests)
 * @param {number} [opts.timeoutMs] - default 2000ms, keep the probe fast and non-blocking
 */
export function createClientPortalClient({ baseUrl = resolveBaseUrl(), fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  async function request(path, { method = 'GET', query } = {}) {
    const url = new URL(baseUrl.replace(/\/$/, '') + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), { method, signal: controller.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: null, error: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', errorMessage: err.message };
    }
  }

  return {
    baseUrl,

    /** Step 3 — read-only auth/session status probe. */
    async getAuthStatus() {
      return request('/iserver/auth/status');
    },

    /** Step 4 — security definition / stock symbol lookup (read-only). */
    async searchStock(symbol) {
      return request('/iserver/secdef/search', { query: { symbol } });
    },

    /** Step 5 — market-data snapshot for one conid + a list of field ids. */
    async getSnapshot(conid, fields) {
      return request('/iserver/marketdata/snapshot', { query: { conids: String(conid), fields: fields.join(',') } });
    },
  };
}
