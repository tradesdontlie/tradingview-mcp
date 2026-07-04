/**
 * Binance USD-M Futures Testnet REST client.
 * Testnet: https://testnet.binancefuture.com  (sandbox — fake funds, same API shape as mainnet)
 *
 * Credentials are SEPARATE from spot testnet — register at testnet.binancefuture.com
 * and set: BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET
 */
import { createHmac } from 'node:crypto';
import https from 'node:https';

const BASE_HOST = 'testnet.binancefuture.com';

function sign(query, secret) {
  return createHmac('sha256', secret).update(query).digest('hex');
}

// Same https transport pattern as binance.js — avoids libuv handle-close race
// on Windows when process.exit() follows a fetch() resolve.
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
          reject(new Error(`Binance Futures API error ${res.statusCode}: ${body?.msg || data}`));
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
  const apiKey = process.env.BINANCE_FUTURES_TESTNET_KEY;
  const apiSecret = process.env.BINANCE_FUTURES_TESTNET_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET env vars are required');
  }
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const signature = sign(query, apiSecret);
  return request(method, `${path}?${query}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

function requirePositiveFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number, got: ${value}`);
  return n;
}

export async function getKlines({ symbol, interval = '1m', limit = 100 } = {}) {
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  const raw = await publicGet('/fapi/v1/klines', { symbol: symbol.toUpperCase(), interval, limit });
  const klines = raw.map(k => ({
    open_time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    close_time: k[6],
    taker_buy_volume: Number(k[9]),
  }));
  return { success: true, symbol: symbol.toUpperCase(), interval, count: klines.length, klines };
}

export async function accountInfo() {
  const result = await signedRequest('GET', '/fapi/v2/account');
  const balances = (result.assets || [])
    .filter(a => Number(a.walletBalance) > 0)
    .map(a => ({ asset: a.asset, free: Number(a.availableBalance), wallet: Number(a.walletBalance) }));
  return { success: true, account_type: 'futures', can_trade: result.canTrade, balances };
}

export async function getPositions(symbol) {
  const params = symbol ? { symbol: symbol.toUpperCase() } : {};
  const result = await signedRequest('GET', '/fapi/v2/positionRisk', params);
  const positions = result
    .filter(p => Number(p.positionAmt) !== 0)
    .map(p => ({
      symbol: p.symbol,
      side: Number(p.positionAmt) > 0 ? 'long' : 'short',
      quantity: Math.abs(Number(p.positionAmt)),
      entry_price: Number(p.entryPrice),
      unrealized_pnl: Number(p.unRealizedProfit),
      leverage: Number(p.leverage),
      margin_type: p.marginType,
    }));
  return { success: true, positions };
}

export async function setLeverage({ symbol, leverage } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const lev = requirePositiveFinite(leverage, 'leverage');
  const result = await signedRequest('POST', '/fapi/v1/leverage', { symbol: symbol.toUpperCase(), leverage: lev });
  return { success: true, symbol: result.symbol, leverage: result.leverage };
}

export async function setMarginType({ symbol, marginType = 'ISOLATED' } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const type = String(marginType).toUpperCase();
  if (!['ISOLATED', 'CROSSED'].includes(type)) throw new Error('marginType must be ISOLATED or CROSSED');
  try {
    await signedRequest('POST', '/fapi/v1/marginType', { symbol: symbol.toUpperCase(), marginType: type });
    return { success: true };
  } catch (err) {
    // -4046: already set to this margin type — not an error
    if (err.message.includes('-4046') || err.message.includes('No need to change')) return { success: true };
    throw err;
  }
}

const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'];

// As of 2025-12-09, Binance migrated conditional order types (STOP_MARKET,
// TAKE_PROFIT_MARKET, etc.) to the Algo Order service — /fapi/v1/order rejects
// them with -4120 STOP_ORDER_SWITCH_ALGO. These must go to /fapi/v1/algoOrder
// instead, with stopPrice renamed to triggerPrice and algoType: 'CONDITIONAL'.
const CONDITIONAL_ORDER_TYPES = ['STOP_MARKET', 'TAKE_PROFIT_MARKET'];

export async function placeOrder({ symbol, side, type = 'MARKET', quantity, price, stopPrice, closePosition = false } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sideUpper = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(sideUpper)) throw new Error('side must be BUY or SELL');
  const typeUpper = String(type || '').toUpperCase();
  if (!ORDER_TYPES.includes(typeUpper)) throw new Error(`type must be one of: ${ORDER_TYPES.join(', ')}`);

  if (CONDITIONAL_ORDER_TYPES.includes(typeUpper)) {
    const params = { algoType: 'CONDITIONAL', symbol: symbol.toUpperCase(), side: sideUpper, type: typeUpper };
    if (closePosition) {
      params.closePosition = 'true';
    } else {
      params.quantity = requirePositiveFinite(quantity, 'quantity');
    }
    params.triggerPrice = requirePositiveFinite(stopPrice, 'stopPrice');

    const result = await signedRequest('POST', '/fapi/v1/algoOrder', params);
    return {
      success: true,
      order_id: result.algoId,
      symbol: result.symbol,
      side: result.side,
      type: result.orderType,
      status: result.algoStatus,
      quantity: closePosition ? null : Number(result.origQty),
      price: undefined,
      stop_price: result.triggerPrice ? Number(result.triggerPrice) : undefined,
      close_position: result.closePosition === 'true',
    };
  }

  const params = { symbol: symbol.toUpperCase(), side: sideUpper, type: typeUpper };

  if (closePosition) {
    params.closePosition = 'true';
  } else {
    params.quantity = requirePositiveFinite(quantity, 'quantity');
  }

  if (typeUpper === 'LIMIT') {
    params.price = requirePositiveFinite(price, 'price');
    params.timeInForce = 'GTC';
  }

  const result = await signedRequest('POST', '/fapi/v1/order', params);
  return {
    success: true,
    order_id: result.orderId,
    symbol: result.symbol,
    side: result.side,
    type: result.type,
    status: result.status,
    quantity: closePosition ? null : Number(result.origQty),
    price: result.price !== undefined ? Number(result.price) : undefined,
    stop_price: result.stopPrice ? Number(result.stopPrice) : undefined,
    close_position: result.closePosition === 'true',
  };
}

export async function cancelOrder({ symbol, order_id } = {}) {
  if (!symbol) throw new Error('symbol is required');
  if (!order_id) throw new Error('order_id is required');
  const result = await signedRequest('DELETE', '/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    orderId: order_id,
  });
  return { success: true, order_id: result.orderId, symbol: result.symbol, status: result.status };
}

export async function getOpenOrders({ symbol } = {}) {
  const params = symbol ? { symbol: symbol.toUpperCase() } : {};
  const result = await signedRequest('GET', '/fapi/v1/openOrders', params);
  const orders = result.map(o => ({
    order_id: o.orderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    quantity: Number(o.origQty),
    price: Number(o.price),
    stop_price: Number(o.stopPrice),
    time: o.time,
  }));
  return { success: true, count: orders.length, orders };
}
