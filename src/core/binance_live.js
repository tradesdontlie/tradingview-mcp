/**
 * Binance LIVE (mainnet) REST client — trades with REAL funds.
 * Docs: https://binance-docs.github.io/apidocs/spot/en
 *
 * Kept entirely separate from core/binance.js (testnet) so sandbox and
 * real-money code paths can never be mixed up. Requires env vars
 * BINANCE_API_KEY / BINANCE_API_SECRET for signed endpoints.
 *
 * Safety: placeOrder() requires confirm: true in addition to dry_run: false
 * before it will send a real order — this is a deliberate extra guard against
 * an order firing from a misfired/ambiguous instruction.
 */
import { createHmac } from 'node:crypto';
import https from 'node:https';

const BASE_HOST = 'api.binance.com';

function sign(query, secret) {
  return createHmac('sha256', secret).update(query).digest('hex');
}

// Uses node:https directly (not global fetch/undici) — calling process.exit()
// right after a fetch() resolves crashes Node on Windows with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (libuv handle-close
// race). Plain http.Agent sockets don't hit that race. See core/binance.js.
function request(method, path, { headers = {}, query } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const req = https.request({
      hostname: BASE_HOST,
      path: `${path}${qs}`,
      method,
      agent: false,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Binance API error ${res.statusCode}: ${body?.msg || data}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function publicGet(path, params = {}) {
  return request('GET', path, { query: params });
}

function signedRequest(method, path, params = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET env vars are required for signed endpoints');
  }
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const signature = sign(query, apiSecret);
  return request(method, `${path}?${query}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

function signedGet(path, params = {}) {
  return signedRequest('GET', path, params);
}

export async function accountInfo() {
  const result = await signedGet('/api/v3/account');
  const balances = (result.balances || [])
    .filter(b => Number(b.free) > 0 || Number(b.locked) > 0)
    .map(b => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }));
  return { success: true, account_type: result.accountType, can_trade: result.canTrade, balances };
}

const SIDES = ['BUY', 'SELL'];
const ORDER_TYPES = ['MARKET', 'LIMIT'];

export async function placeOrder({ symbol, side, type = 'MARKET', quantity, price, dry_run = true, confirm = false } = {}) {
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  const sideUpper = String(side || '').toUpperCase();
  if (!SIDES.includes(sideUpper)) throw new Error(`side must be one of: ${SIDES.join(', ')}`);
  const typeUpper = String(type || '').toUpperCase();
  if (!ORDER_TYPES.includes(typeUpper)) throw new Error(`type must be one of: ${ORDER_TYPES.join(', ')}`);
  const qty = requirePositiveFinite(quantity, 'quantity');

  const params = { symbol: symbol.toUpperCase(), side: sideUpper, type: typeUpper, quantity: qty };
  if (typeUpper === 'LIMIT') {
    params.price = requirePositiveFinite(price, 'price');
    params.timeInForce = 'GTC';
  }

  if (dry_run) {
    return { success: true, dry_run: true, would_place: params };
  }

  // Extra guard on top of dry_run: a real-money order requires explicit
  // confirm: true. This prevents a single ambiguous "place it" from ever
  // firing a live trade — the caller must affirmatively opt out of the
  // simulated path AND opt into the real one.
  if (!confirm) {
    throw new Error(
      'Refusing to place a LIVE order with real funds: pass confirm: true explicitly ' +
      '(in addition to dry_run: false) to confirm you intend to risk real money. ' +
      `Order that would be placed: ${JSON.stringify(params)}`
    );
  }

  const result = await signedRequest('POST', '/api/v3/order', params);
  return {
    success: true,
    live: true,
    order_id: result.orderId,
    symbol: result.symbol,
    side: result.side,
    type: result.type,
    status: result.status,
    quantity: Number(result.origQty),
    price: result.price !== undefined ? Number(result.price) : undefined,
    fills: result.fills,
  };
}

export async function cancelOrder({ symbol, order_id } = {}) {
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  if (!order_id) throw new Error('order_id is required');
  const result = await signedRequest('DELETE', '/api/v3/order', {
    symbol: symbol.toUpperCase(),
    orderId: order_id,
  });
  return { success: true, order_id: result.orderId, symbol: result.symbol, status: result.status };
}

export async function getOpenOrders({ symbol } = {}) {
  const params = symbol ? { symbol: symbol.toUpperCase() } : {};
  const result = await signedGet('/api/v3/openOrders', params);
  const orders = result.map(o => ({
    order_id: o.orderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    quantity: Number(o.origQty),
    price: Number(o.price),
    time: o.time,
  }));
  return { success: true, count: orders.length, orders };
}

function requirePositiveFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number, got: ${value}`);
  return n;
}

export async function getKlines({ symbol, interval = '1m', limit = 100 } = {}) {
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  const raw = await publicGet('/api/v3/klines', { symbol: symbol.toUpperCase(), interval, limit });
  const klines = raw.map(k => ({
    open_time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    close_time: k[6],
  }));
  return { success: true, symbol: symbol.toUpperCase(), interval, count: klines.length, klines };
}
