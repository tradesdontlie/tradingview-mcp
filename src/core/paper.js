/**
 * TradingView native Paper Trading.
 *
 * Supports only the native Paper broker (stable id "Paper"). All mutations
 * fail closed unless the active broker metainfo id is exactly that value.
 * Evidence: docs/PAPER_TRADING_DISCOVERY.md (Capture 2, Desktop 3.3.0).
 *
 * CDP injection strings live in paper_cdp.js (adapter). This module owns
 * Paper-only policy: status, guard, and tool orchestration.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { PAGE_HELPERS, SUMMARY_IDS, tradingPanelButtonProbe } from './paper_cdp.js';

/** Stable internal id of TradingView's native Paper Trading provider. */
export const NATIVE_PAPER_BROKER_ID = 'Paper';

export const CONNECT_STATUS = {
  CONNECTED: 1,
  CONNECTING: 2,
  DISCONNECTED: 3,
  ERROR: 4,
};

export const ORDER_TYPE = {
  limit: 1,
  market: 2,
  stop: 3,
  stop_limit: 4,
};

export const SIDE = {
  buy: 1,
  sell: -1,
};

/** Paper broker duration values from Capture 2 metainfo.durations. */
export const ORDER_TIF = {
  DAY: 'DAY',
  WEEK: 'WEEK',
  MONTH: 'MONTH',
  GTD: 'GTD',
};

export const CONNECT_STATUS_LABEL = {
  [CONNECT_STATUS.CONNECTED]: 'connected',
  [CONNECT_STATUS.CONNECTING]: 'connecting',
  [CONNECT_STATUS.DISCONNECTED]: 'disconnected',
  [CONNECT_STATUS.ERROR]: 'error',
};

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

/**
 * Snapshot of session/broker/panel state used by status and mutation guard.
 * Never mutates.
 */
export async function readContext({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var u = window.user || {};
      var username = typeof u.username === 'string' ? u.username : null;
      var hasId = !!u.id;
      var isGuest = !hasId || !username || username === 'Guest';
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      var panelEnabled = false;
      var panelVisible = false;
      var activeWidget = null;
      if (bwb) {
        try { panelEnabled = !!bwb.isWidgetEnabled('paper_trading'); } catch (e) {}
        try { panelVisible = !!tvWv(bwb.isVisible()); } catch (e) {}
        try { activeWidget = tvWv(bwb.activeWidgetName()) || null; } catch (e) {}
      }
      var t = tvTrading();
      var connectStatus = null;
      var brokerId = null;
      var brokerTitle = null;
      var accountId = null;
      if (t) {
        try { connectStatus = tvWv(t.connectStatus && t.connectStatus()); } catch (e) {}
        var ab = tvBroker(t);
        brokerId = tvBrokerId(ab);
        try { brokerTitle = ab && ab._brokerMetainfo && ab._brokerMetainfo.title || null; } catch (e) {}
        try {
          var rawAcc = t._account;
          if (typeof rawAcc === 'string' || typeof rawAcc === 'number') accountId = String(rawAcc);
        } catch (e) {}
      }
      var isPaper = brokerId === ${safeString(NATIVE_PAPER_BROKER_ID)};
      var connected = connectStatus === ${CONNECT_STATUS.CONNECTED};
      return {
        desktop: true,
        session: isGuest ? 'anonymous' : 'authenticated',
        username: isGuest ? null : username,
        panel_enabled: panelEnabled,
        panel_visible: panelVisible,
        active_widget: activeWidget,
        connect_status: connectStatus == null ? null : Number(connectStatus),
        broker_id: brokerId,
        broker_title: brokerTitle,
        account_id: accountId,
        is_native_paper: isPaper,
        paper_connected: connected && isPaper,
        safe_for_paper_mutation: !isGuest && connected && isPaper,
      };
    })()
  `);
}

export function buildStatus(context, panelButton) {
  const desktopConnected = !!context?.desktop;
  const session = context?.session || 'unknown';
  const connectStatus = context?.connect_status ?? null;
  const brokerId = context?.broker_id ?? null;
  const isPaper = brokerId === NATIVE_PAPER_BROKER_ID;
  const paperConnected = connectStatus === CONNECT_STATUS.CONNECTED && isPaper;
  const panelFromApi = context?.panel_enabled;
  const panelOpen = context?.panel_visible && context?.active_widget === 'paper_trading'
    ? true
    : (panelButton?.button_found ? !!panelButton.button_active : (context?.panel_visible ?? null));

  return {
    success: true,
    desktop_connected: desktopConnected,
    trading_panel_available: desktopConnected
      ? (panelFromApi != null ? !!panelFromApi : !!panelButton?.button_found)
      : null,
    trading_panel_open: desktopConnected ? panelOpen : null,
    tradingview_session: session,
    paper_available: desktopConnected ? (session === 'authenticated' && !!panelFromApi) : null,
    paper_connected: desktopConnected ? (paperConnected || false) : null,
    active_provider: brokerId,
    provider_type: !brokerId ? (connectStatus === CONNECT_STATUS.DISCONNECTED ? 'none' : 'unknown')
      : (isPaper ? 'native_paper' : 'other_broker'),
    active_account_id: context?.account_id ?? null,
    connect_status: connectStatus,
    connect_status_label: connectStatus == null ? null : (CONNECT_STATUS_LABEL[connectStatus] || 'unknown'),
    safe_for_paper_mutation: !!context?.safe_for_paper_mutation,
    discovery_status: 'complete',
  };
}

export async function getStatus({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  let panelButton = null;
  try {
    panelButton = await evaluate(tradingPanelButtonProbe());
  } catch {
    // CDP unreachable — desktop not connected.
    return {
      success: true,
      desktop_connected: false,
      trading_panel_available: null,
      trading_panel_open: null,
      tradingview_session: 'unknown',
      paper_available: null,
      paper_connected: null,
      active_provider: null,
      provider_type: 'unknown',
      active_account_id: null,
      connect_status: null,
      connect_status_label: null,
      safe_for_paper_mutation: false,
      discovery_status: 'complete',
    };
  }

  let context = null;
  try {
    context = await readContext({ _deps });
  } catch {
    // Probe succeeded so Desktop is up, but session/broker read failed.
    // Report connected desktop with unknown trading facts rather than a healthy Paper session.
    return buildStatus({
      desktop: true,
      session: 'unknown',
      panel_enabled: null,
      panel_visible: null,
      active_widget: null,
      connect_status: null,
      broker_id: null,
      account_id: null,
      safe_for_paper_mutation: false,
    }, panelButton);
  }
  return buildStatus({ ...context, desktop: true }, panelButton);
}

/**
 * Fail-closed guard for mutations. Throws with typed codes.
 */
export async function assertPaperContext({ _deps } = {}) {
  let context;
  try {
    context = await readContext({ _deps });
  } catch (err) {
    const e = new Error(`CDP unavailable: ${err.message}`);
    e.code = 'CDP_UNAVAILABLE';
    throw e;
  }
  if (!context || context.session === 'anonymous') {
    const e = new Error('TradingView login required for Paper Trading');
    e.code = 'TRADINGVIEW_AUTH_REQUIRED';
    throw e;
  }
  if (context.connect_status !== CONNECT_STATUS.CONNECTED) {
    const e = new Error(`Paper Trading not connected (connect_status=${context.connect_status})`);
    e.code = 'PAPER_NOT_CONNECTED';
    throw e;
  }
  if (context.broker_id !== NATIVE_PAPER_BROKER_ID) {
    const e = new Error(
      `Active broker is not native Paper Trading (got ${context.broker_id || 'null'}). Refusing mutation.`,
    );
    e.code = 'NOT_PAPER_PROVIDER';
    throw e;
  }
  return context;
}

export async function openPanel({ action = 'open', _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const act = action || 'open';
  if (!['open', 'close', 'toggle'].includes(act)) {
    throw new Error('action must be open, close, or toggle');
  }
  const result = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return { error: 'bottomWidgetBar not available' };
      var action = ${safeString(act)};
      var wasOpen = false;
      try {
        wasOpen = !!tvWv(bwb.isVisible()) && tvWv(bwb.activeWidgetName()) === 'paper_trading';
      } catch (e) {}
      var performed = 'none';
      if (action === 'open' || (action === 'toggle' && !wasOpen)) {
        if (typeof bwb.showWidget === 'function') bwb.showWidget('paper_trading');
        else if (typeof bwb.activateWidget === 'function') bwb.activateWidget('paper_trading');
        performed = 'opened';
      } else if (action === 'close' || (action === 'toggle' && wasOpen)) {
        if (typeof bwb.hideWidget === 'function') bwb.hideWidget('paper_trading');
        else if (typeof bwb.close === 'function') bwb.close();
        else if (typeof bwb.hide === 'function') bwb.hide();
        performed = 'closed';
      }
      return { was_open: wasOpen, performed: performed };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, panel: 'paper_trading', action: act, was_open: !!result?.was_open, performed: result?.performed || 'unknown' };
}

export async function connect({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  // Auth required, but broker may be disconnected — don't use assertPaperContext.
  const context = await readContext({ _deps });
  if (!context || context.session === 'anonymous') {
    const e = new Error('TradingView login required for Paper Trading');
    e.code = 'TRADINGVIEW_AUTH_REQUIRED';
    throw e;
  }
  if (context.paper_connected) {
    return { success: true, connected: true, broker_id: NATIVE_PAPER_BROKER_ID, already: true };
  }
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var t = tvTrading();
      if (!t || typeof t.selectBroker !== 'function') return { error: 'selectBroker unavailable' };
      await t.selectBroker(${safeString(NATIVE_PAPER_BROKER_ID)});
      var ab = tvBroker(t);
      var id = tvBrokerId(ab);
      var cs = tvWv(t.connectStatus && t.connectStatus());
      return { broker_id: id, connect_status: cs == null ? null : Number(cs) };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.broker_id !== NATIVE_PAPER_BROKER_ID) {
    const e = new Error(`Failed to connect native Paper Trading (active=${result?.broker_id || 'null'})`);
    e.code = 'NOT_PAPER_PROVIDER';
    throw e;
  }
  return {
    success: true,
    connected: result.connect_status === CONNECT_STATUS.CONNECTED,
    broker_id: result.broker_id,
    connect_status: result.connect_status,
  };
}

export async function listAccounts({ _deps } = {}) {
  await assertPaperContext({ _deps });
  const { evaluateAsync } = _resolve(_deps);
  const accounts = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var list = await ab.accountsMetainfo();
      var current = await ab.currentAccount();
      return (list || []).map(function(a) {
        return {
          id: a.id != null ? String(a.id) : null,
          name: a.name || null,
          title: a.title || null,
          type: a.type || null,
          currency: a.currency || null,
          is_active: String(a.id) === String(current),
        };
      });
    })()
  `);
  return { success: true, accounts: accounts || [] };
}

export async function switchAccount({ account_id, _deps } = {}) {
  await assertPaperContext({ _deps });
  if (!account_id) throw new Error('account_id required');
  const { evaluateAsync } = _resolve(_deps);
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var id = ${safeString(String(account_id))};
      var list = await ab.accountsMetainfo();
      var known = (list || []).some(function(a) { return String(a.id) === id; });
      if (!known) return { error: 'account not found: ' + id };
      if (typeof ab.setCurrentAccount !== 'function') return { error: 'setCurrentAccount unavailable' };
      await ab.setCurrentAccount(id);
      var current = await ab.currentAccount();
      return { account_id: current != null ? String(current) : null };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, action: 'switch_account', account_id: result?.account_id || String(account_id) };
}

export async function getAccount({ _deps } = {}) {
  await assertPaperContext({ _deps });
  const { evaluateAsync } = _resolve(_deps);
  const account = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var t = tvTrading();
      var ab = tvBroker(t);
      var id = await ab.currentAccount();
      var type = null;
      try { type = await ab.currentAccountType(); } catch (e) {}
      var metas = await ab.accountsMetainfo();
      var meta = (metas || []).find(function(a) { return String(a.id) === String(id); }) || {};
      var ami = await ab.accountManagerInfo();
      var summary = ami && ami.summary || [];
      var ids = ${JSON.stringify(SUMMARY_IDS)};
      var values = {};
      for (var i = 0; i < summary.length && i < ids.length; i++) {
        var s = summary[i];
        var v = null;
        try {
          if (s.wValue && typeof s.wValue.value === 'function') v = s.wValue.value();
          else if (s.wValue && '_value' in s.wValue) v = s.wValue._value;
          else if (typeof s.getValue === 'function') v = s.getValue();
        } catch (e) {}
        values[ids[i]] = typeof v === 'number' ? v : null;
      }
      var currency = meta.currency || null;
      try {
        var pos = await ab.positions();
        if (pos && pos[0] && pos[0].extra && pos[0].extra.accountCurrency) {
          currency = pos[0].extra.accountCurrency;
        }
      } catch (e) {}
      return {
        id: id != null ? String(id) : null,
        name: meta.name || null,
        title: meta.title || 'Paper Trading',
        type: type || meta.type || null,
        currency: currency,
        balance: values.balance,
        equity: values.equity,
        realized_pnl: values.realized_pnl,
        unrealized_pnl: values.unrealized_pnl,
        margin_used: values.margin_used,
        available_funds: values.available_funds,
        orders_margin: values.orders_margin,
        margin_buffer: values.margin_buffer,
      };
    })()
  `);
  return { success: true, account };
}

export async function listPositions({ _deps } = {}) {
  await assertPaperContext({ _deps });
  const { evaluate } = _resolve(_deps);
  const positions = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var t = tvTrading();
      var ps = t && t._positionService;
      var list = [];
      try { list = tvWv(ps.positions && ps.positions()) || []; } catch (e) { return { error: e.message }; }
      if (!Array.isArray(list)) list = [];
      return list.map(tvScalarizePosition);
    })()
  `);
  if (positions?.error) throw new Error(positions.error);
  return { success: true, count: (positions || []).length, positions: positions || [] };
}

export async function listOrders({ history = false, _deps } = {}) {
  await assertPaperContext({ _deps });
  const { evaluate, evaluateAsync } = _resolve(_deps);
  if (history) {
    const orders = await evaluateAsync(`
      (async function() {
        ${PAGE_HELPERS}
        var ab = tvBroker(tvTrading());
        var list = await ab.ordersHistory();
        if (!Array.isArray(list)) list = [];
        return list.slice(0, 50).map(tvScalarizeOrder);
      })()
    `);
    return { success: true, history: true, count: (orders || []).length, orders: orders || [] };
  }
  const orders = await evaluate(`
    (function() {
      ${PAGE_HELPERS}
      var t = tvTrading();
      var os = t && t._ordersService;
      var list = [];
      try { list = tvWv(os.activeOrders && os.activeOrders()) || []; } catch (e) { return { error: e.message }; }
      if (!Array.isArray(list)) list = [];
      return list.map(tvScalarizeOrder);
    })()
  `);
  if (orders?.error) throw new Error(orders.error);
  return { success: true, history: false, count: (orders || []).length, orders: orders || [] };
}

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buy' || s === 'long' || s === '1') return SIDE.buy;
  if (s === 'sell' || s === 'short' || s === '-1') return SIDE.sell;
  throw new Error('side must be buy or sell');
}

function normalizeOrderType(type) {
  const t = String(type || 'market').toLowerCase().replace(/-/g, '_');
  if (!(t in ORDER_TYPE)) {
    throw new Error('type must be market, limit, stop, or stop_limit');
  }
  return ORDER_TYPE[t];
}

function normalizeTif(tif, durationDatetime) {
  if (tif == null || tif === '') return null;
  const value = String(tif).toUpperCase();
  if (!(value in ORDER_TIF)) {
    throw new Error('tif must be DAY, WEEK, MONTH, or GTD');
  }
  const duration = { type: value };
  if (value === 'GTD') {
    if (durationDatetime == null || durationDatetime === '') {
      throw new Error('duration_datetime is required when tif is GTD (ISO date or unix ms)');
    }
    let ms = Number(durationDatetime);
    if (!Number.isFinite(ms)) {
      ms = new Date(durationDatetime).getTime();
    }
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid duration_datetime: ${durationDatetime}`);
    }
    duration.datetime = ms;
  }
  return duration;
}

export async function placeOrder({
  side, type = 'market', qty, symbol, price, stop_price, take_profit, stop_loss,
  tif, duration_datetime, _deps,
} = {}) {
  await assertPaperContext({ _deps });
  const sideNum = normalizeSide(side);
  const typeNum = normalizeOrderType(type);
  const quantity = requireFinite(qty, 'qty');
  if (quantity <= 0) throw new Error('qty must be positive');
  if ((typeNum === ORDER_TYPE.limit || typeNum === ORDER_TYPE.stop_limit) && price == null) {
    throw new Error('price is required for limit / stop_limit orders');
  }
  if ((typeNum === ORDER_TYPE.stop || typeNum === ORDER_TYPE.stop_limit) && stop_price == null) {
    throw new Error('stop_price is required for stop / stop_limit orders');
  }
  const duration = normalizeTif(tif, duration_datetime);

  const { evaluateAsync } = _resolve(_deps);
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var deny = tvRequirePaperBroker(ab);
      if (deny) return deny;
      var order = {
        symbol: ${symbol != null ? safeString(symbol) : 'null'},
        side: ${sideNum},
        type: ${typeNum},
        qty: ${quantity},
      };
      if (!order.symbol) {
        try {
          var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV &&
            tvWv(window.TradingViewApi._activeChartWidgetWV);
          order.symbol = chart && chart.symbol ? chart.symbol() : null;
        } catch (e) {}
      }
      if (!order.symbol) return { error: 'symbol required (chart symbol unavailable)' };
      ${price != null ? `order.limitPrice = ${requireFinite(price, 'price')};` : ''}
      ${stop_price != null ? `order.stopPrice = ${requireFinite(stop_price, 'stop_price')};` : ''}
      ${take_profit != null ? `order.takeProfit = ${requireFinite(take_profit, 'take_profit')};` : ''}
      ${stop_loss != null ? `order.stopLoss = ${requireFinite(stop_loss, 'stop_loss')};` : ''}
      ${duration ? `order.duration = ${JSON.stringify(duration)};` : ''}
      var res = await ab.placeOrder(order);
      return { result: res == null ? null : (typeof res === 'object' ? {
        order_id: res.orderId != null ? String(res.orderId) : (res.id != null ? String(res.id) : null),
        keys: Object.keys(res).slice(0, 20),
      } : res) };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    action: 'place_order',
    side: sideNum === SIDE.buy ? 'buy' : 'sell',
    type: String(type).toLowerCase(),
    tif: duration?.type || null,
    result: result?.result ?? null,
  };
}

export async function cancelOrder({ order_id, _deps } = {}) {
  await assertPaperContext({ _deps });
  if (!order_id) throw new Error('order_id required');
  const { evaluateAsync } = _resolve(_deps);
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var deny = tvRequirePaperBroker(ab);
      if (deny) return deny;
      // Broker API success is often Promise<void>; only explicit false is failure.
      var res = await ab.cancelOrder(${safeString(String(order_id))});
      return { ok: res !== false };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, action: 'cancel_order', order_id: String(order_id), cancelled: result?.ok !== false };
}

export async function modifyOrder({ order_id, qty, price, stop_price, _deps } = {}) {
  await assertPaperContext({ _deps });
  if (!order_id) throw new Error('order_id required');
  const { evaluateAsync } = _resolve(_deps);
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var deny = tvRequirePaperBroker(ab);
      if (deny) return deny;
      var existing = null;
      var oid = ${safeString(String(order_id))};
      try { existing = await ab.orderById(oid); } catch (e) {}
      // Same non-history source as paper_list_orders (OrdersService.activeOrders).
      if (!existing) {
        try {
          var t = tvTrading();
          var os = t && t._ordersService;
          var active = tvWv(os && os.activeOrders && os.activeOrders()) || [];
          existing = (active || []).find(function(o) { return String(o.id) === oid; }) || null;
        } catch (e) {}
      }
      if (!existing) return { error: 'order not found: ' + oid };
      var order = Object.assign({}, existing);
      ${qty != null ? `order.qty = ${requireFinite(qty, 'qty')};` : ''}
      ${price != null ? `order.limitPrice = ${requireFinite(price, 'price')};` : ''}
      ${stop_price != null ? `order.stopPrice = ${requireFinite(stop_price, 'stop_price')};` : ''}
      var res = await ab.modifyOrder(order);
      return { ok: res !== false, result: res == null ? null : true };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, action: 'modify_order', order_id: String(order_id), modified: result?.ok !== false };
}

export async function closePosition({ position_id, symbol, qty, _deps } = {}) {
  await assertPaperContext({ _deps });
  const id = position_id || symbol;
  if (!id) throw new Error('position_id or symbol required');
  const { evaluateAsync } = _resolve(_deps);
  const amount = qty != null ? requireFinite(qty, 'qty') : null;
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var deny = tvRequirePaperBroker(ab);
      if (deny) return deny;
      var pid = ${safeString(String(id))};
      var amount = ${amount == null ? 'undefined' : String(amount)};
      // Broker API success is often Promise<void>; only explicit false is failure.
      var res = await ab.closePosition(pid, amount);
      return { ok: res !== false };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    action: 'close_position',
    position_id: String(id),
    qty: amount,
    closed: result?.ok !== false,
  };
}

export async function setBrackets({ position_id, symbol, stop_loss, take_profit, clear = false, _deps } = {}) {
  await assertPaperContext({ _deps });
  const id = position_id || symbol;
  if (!id) throw new Error('position_id or symbol required');
  const { evaluateAsync } = _resolve(_deps);
  let brackets;
  if (clear) {
    brackets = { stopLoss: null, takeProfit: null };
  } else {
    if (stop_loss == null && take_profit == null) {
      throw new Error('stop_loss or take_profit required (or pass clear: true)');
    }
    brackets = {};
    if (stop_loss != null) brackets.stopLoss = requireFinite(stop_loss, 'stop_loss');
    if (take_profit != null) brackets.takeProfit = requireFinite(take_profit, 'take_profit');
  }
  const result = await evaluateAsync(`
    (async function() {
      ${PAGE_HELPERS}
      var ab = tvBroker(tvTrading());
      var deny = tvRequirePaperBroker(ab);
      if (deny) return deny;
      // Broker API success is often Promise<void>; only explicit false is failure.
      var res = await ab.editPositionBrackets(${safeString(String(id))}, ${JSON.stringify(brackets)});
      return { ok: res !== false };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    action: clear ? 'clear_brackets' : 'set_brackets',
    position_id: String(id),
    brackets,
    updated: result?.ok !== false,
  };
}
