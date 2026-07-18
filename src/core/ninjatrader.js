export function createTradingBridgeClient({
  baseUrl = process.env.NINJATRADER_BRIDGE_URL || 'http://localhost:5555',
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function get(path, query = {}) {
    const search = new URLSearchParams(query).toString();
    const url = `${root}${path}${search ? `?${search}` : ''}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`TradingBridge request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        const detail = payload?.error || payload?.message || response.statusText || 'request failed';
        throw new Error(`TradingBridge HTTP ${response.status}: ${detail}`);
      }
      if (payload?.success === false) {
        throw new Error(payload.error || payload.message || 'TradingBridge request failed');
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    status: () => get('/api/status'),
    connections: () => get('/api/connections'),
    accounts: () => get('/api/accounts'),
    positions: () => get('/api/positions'),
    orders: () => get('/api/orders'),
    bars: ({ instrument, period, value }) => get('/api/bars', { instrument, period, value }),
  };
}
