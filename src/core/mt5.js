/**
 * Core MT5 (MetaTrader 5) trading logic.
 * Talks to a local Python bridge (scripts/mt5_bridge.py) that wraps the
 * MetaTrader5 package. That bridge must be running on the same machine as
 * the MT5 terminal — see SETUP_GUIDE.md.
 *
 * This module can place, modify, and close real orders. It works against
 * whatever account the bridge is logged into (demo or live) — the bridge
 * reports which on /account via `is_demo`. Callers that care about the
 * distinction should check getAccount().is_demo before trading.
 */
import { mt5Get as _mt5Get, mt5Post as _mt5Post } from '../mt5/client.js';

function _resolve(deps) {
  return {
    mt5Get: deps?.mt5Get || _mt5Get,
    mt5Post: deps?.mt5Post || _mt5Post,
  };
}

function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

function requireSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('symbol is required');
  return symbol.trim();
}

export async function health({ _deps } = {}) {
  const { mt5Get } = _resolve(_deps);
  const res = await mt5Get('/health');
  return { success: true, connected: !!res.connected, terminal: res.terminal ?? null };
}

export async function getAccount({ _deps } = {}) {
  const { mt5Get } = _resolve(_deps);
  const res = await mt5Get('/account');
  const a = res.account;
  return {
    success: true,
    login: a.login,
    server: a.server,
    currency: a.currency,
    balance: a.balance,
    equity: a.equity,
    margin: a.margin,
    margin_free: a.margin_free,
    margin_level: a.margin_level,
    leverage: a.leverage,
    is_demo: !!a.is_demo,
  };
}

export async function getPositions({ symbol, _deps } = {}) {
  const { mt5Get } = _resolve(_deps);
  const qs = symbol ? `?symbol=${encodeURIComponent(requireSymbol(symbol))}` : '';
  const res = await mt5Get(`/positions${qs}`);
  return { success: true, count: res.positions.length, positions: res.positions };
}

export async function getQuote({ symbol, _deps }) {
  const { mt5Get } = _resolve(_deps);
  const sym = requireSymbol(symbol);
  const res = await mt5Get(`/quote?symbol=${encodeURIComponent(sym)}`);
  return { success: true, symbol: sym, ...res.quote };
}

/**
 * Places a live market order against whatever account the bridge is
 * logged into. `confirm: true` is mandatory — this is real order
 * execution (demo or live depending on bridge login), not a chart drawing.
 */
export async function placeOrder({ symbol, side, volume, sl, tp, comment, confirm, _deps }) {
  if (confirm !== true) {
    throw new Error('confirm must be true to place a real MT5 order. This executes against a live account (demo or real) — set confirm: true to proceed.');
  }
  const sym = requireSymbol(symbol);
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be "buy" or "sell"');
  const vol = requireFinite(volume, 'volume');
  if (vol <= 0) throw new Error('volume must be > 0');

  const body = { symbol: sym, side, volume: vol };
  if (sl !== undefined && sl !== null) body.sl = requireFinite(sl, 'sl');
  if (tp !== undefined && tp !== null) body.tp = requireFinite(tp, 'tp');
  if (comment) body.comment = String(comment).slice(0, 31);

  const { mt5Post } = _resolve(_deps);
  const res = await mt5Post('/order', body);
  return { success: true, order: res.result };
}

export async function closeOrder({ ticket, volume, confirm, _deps }) {
  if (confirm !== true) {
    throw new Error('confirm must be true to close a real MT5 position. Set confirm: true to proceed.');
  }
  const t = requireFinite(ticket, 'ticket');
  const body = { ticket: t };
  if (volume !== undefined && volume !== null) body.volume = requireFinite(volume, 'volume');

  const { mt5Post } = _resolve(_deps);
  const res = await mt5Post('/order/close', body);
  return { success: true, result: res.result };
}

export async function modifyOrder({ ticket, sl, tp, _deps }) {
  const t = requireFinite(ticket, 'ticket');
  if (sl === undefined && tp === undefined) throw new Error('at least one of sl or tp is required');
  const body = { ticket: t };
  if (sl !== undefined && sl !== null) body.sl = requireFinite(sl, 'sl');
  if (tp !== undefined && tp !== null) body.tp = requireFinite(tp, 'tp');

  const { mt5Post } = _resolve(_deps);
  const res = await mt5Post('/order/modify', body);
  return { success: true, result: res.result };
}
