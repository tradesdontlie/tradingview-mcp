/**
 * Tests for TradingView native Paper Trading (src/core/paper.js + paper_cdp.js).
 * Offline with mocked CDP evaluation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStatus,
  buildStatus,
  assertPaperContext,
  openPanel,
  connect,
  listAccounts,
  getAccount,
  listPositions,
  listOrders,
  placeOrder,
  cancelOrder,
  modifyOrder,
  closePosition,
  setBrackets,
  switchAccount,
  NATIVE_PAPER_BROKER_ID,
  CONNECT_STATUS,
} from '../src/core/paper.js';
import { PAGE_HELPERS, SUMMARY_IDS, tradingPanelButtonProbe } from '../src/core/paper_cdp.js';

const DISCONNECTED_DEPS = {
  evaluate: async () => { throw new Error('CDP connection failed after 5 attempts'); },
  evaluateAsync: async () => { throw new Error('CDP connection failed after 5 attempts'); },
};

function contextDeps(context, button = { button_found: true, button_active: true }) {
  return {
    evaluate: async (expr) => {
      if (expr.includes('trading-button') || expr.includes('Trading Panel')) return button;
      return { desktop: true, ...context };
    },
    evaluateAsync: async () => ({ ok: true }),
  };
}

/** Route evaluate/evaluateAsync by expression keywords (for read tools). */
function routedDeps({ context = PAPER_CONNECTED, evaluateMap = {}, asyncMap = {} } = {}) {
  return {
    evaluate: async (expr) => {
      if (expr.includes('trading-button') || expr.includes('Trading Panel')) {
        return { button_found: true, button_active: true };
      }
      for (const [needle, value] of Object.entries(evaluateMap)) {
        if (expr.includes(needle)) return typeof value === 'function' ? value(expr) : value;
      }
      return { desktop: true, ...context };
    },
    evaluateAsync: async (expr) => {
      for (const [needle, value] of Object.entries(asyncMap)) {
        if (expr.includes(needle)) return typeof value === 'function' ? value(expr) : value;
      }
      return { ok: true };
    },
  };
}

const PAPER_CONNECTED = {
  session: 'authenticated',
  username: 'tester',
  panel_enabled: true,
  panel_visible: true,
  active_widget: 'paper_trading',
  connect_status: CONNECT_STATUS.CONNECTED,
  broker_id: NATIVE_PAPER_BROKER_ID,
  broker_title: 'Paper Trading',
  account_id: '15372380',
  is_native_paper: true,
  paper_connected: true,
  safe_for_paper_mutation: true,
};

const FOREIGN_BROKER = {
  ...PAPER_CONNECTED,
  broker_id: 'BINANCE',
  is_native_paper: false,
  paper_connected: false,
  safe_for_paper_mutation: false,
};

function runPageHelper(fnName, arg) {
  return new Function('arg', `${PAGE_HELPERS}; return ${fnName}(arg);`)(arg);
}

describe('paper buildStatus / getStatus', () => {
  it('reports Paper connected and mutation-safe when broker id is Paper', async () => {
    const status = await getStatus({ _deps: contextDeps(PAPER_CONNECTED) });
    assert.equal(status.success, true);
    assert.equal(status.desktop_connected, true);
    assert.equal(status.tradingview_session, 'authenticated');
    assert.equal(status.paper_connected, true);
    assert.equal(status.active_provider, 'Paper');
    assert.equal(status.provider_type, 'native_paper');
    assert.equal(status.safe_for_paper_mutation, true);
    assert.equal(status.discovery_status, 'complete');
  });

  it('never allows mutation when another broker is active', async () => {
    const status = await getStatus({ _deps: contextDeps(FOREIGN_BROKER) });
    assert.equal(status.provider_type, 'other_broker');
    assert.equal(status.paper_connected, false);
    assert.equal(status.safe_for_paper_mutation, false);
  });

  it('reports anonymous session honestly', async () => {
    const status = await getStatus({
      _deps: contextDeps({
        session: 'anonymous',
        panel_enabled: false,
        panel_visible: false,
        active_widget: null,
        connect_status: CONNECT_STATUS.DISCONNECTED,
        broker_id: null,
        account_id: null,
        is_native_paper: false,
        paper_connected: false,
        safe_for_paper_mutation: false,
      }, { button_found: false }),
    });
    assert.equal(status.tradingview_session, 'anonymous');
    assert.equal(status.trading_panel_available, false);
    assert.equal(status.safe_for_paper_mutation, false);
  });

  it('reports desktop disconnected without throwing', async () => {
    const status = await getStatus({ _deps: DISCONNECTED_DEPS });
    assert.equal(status.success, true);
    assert.equal(status.desktop_connected, false);
    assert.equal(status.safe_for_paper_mutation, false);
  });

  it('keeps desktop connected but unknown session when readContext fails after probe', async () => {
    let calls = 0;
    const status = await getStatus({
      _deps: {
        evaluate: async (expr) => {
          calls += 1;
          if (expr.includes('trading-button') || expr.includes('Trading Panel')) {
            return { button_found: true, button_active: true };
          }
          throw new Error('readContext CDP timeout');
        },
        evaluateAsync: async () => ({}),
      },
    });
    assert.equal(calls, 2);
    assert.equal(status.desktop_connected, true);
    assert.equal(status.tradingview_session, 'unknown');
    assert.equal(status.paper_connected, false);
    assert.equal(status.active_provider, null);
    assert.equal(status.safe_for_paper_mutation, false);
  });

  it('buildStatus derives provider_type none when disconnected without broker', () => {
    const s = buildStatus({
      desktop: true,
      session: 'authenticated',
      panel_enabled: true,
      panel_visible: false,
      active_widget: null,
      connect_status: CONNECT_STATUS.DISCONNECTED,
      broker_id: null,
      account_id: null,
      safe_for_paper_mutation: false,
    }, { button_found: true, button_active: false });
    assert.equal(s.provider_type, 'none');
    assert.equal(s.trading_panel_open, false);
  });

  it('buildStatus derives provider_type from broker id', () => {
    const s = buildStatus({
      desktop: true,
      session: 'authenticated',
      panel_enabled: true,
      panel_visible: true,
      active_widget: 'paper_trading',
      connect_status: 1,
      broker_id: 'Paper',
      account_id: '1',
      safe_for_paper_mutation: true,
    }, { button_found: true, button_active: true });
    assert.equal(s.provider_type, 'native_paper');
    assert.equal(s.paper_connected, true);
    assert.equal(s.connect_status_label, 'connected');
  });
});

describe('paper assertPaperContext fail-closed', () => {
  it('allows Paper-connected context', async () => {
    const ctx = await assertPaperContext({ _deps: contextDeps(PAPER_CONNECTED) });
    assert.equal(ctx.broker_id, 'Paper');
  });

  it('rejects anonymous session', async () => {
    await assert.rejects(
      () => assertPaperContext({
        _deps: contextDeps({ ...PAPER_CONNECTED, session: 'anonymous', safe_for_paper_mutation: false }),
      }),
      (err) => err.code === 'TRADINGVIEW_AUTH_REQUIRED',
    );
  });

  it('rejects disconnected Paper', async () => {
    await assert.rejects(
      () => assertPaperContext({
        _deps: contextDeps({
          ...PAPER_CONNECTED,
          connect_status: CONNECT_STATUS.DISCONNECTED,
          paper_connected: false,
          safe_for_paper_mutation: false,
        }),
      }),
      (err) => err.code === 'PAPER_NOT_CONNECTED',
    );
  });

  it('rejects non-Paper broker', async () => {
    await assert.rejects(
      () => assertPaperContext({ _deps: contextDeps(FOREIGN_BROKER) }),
      (err) => err.code === 'NOT_PAPER_PROVIDER',
    );
  });

  it('maps CDP failures to CDP_UNAVAILABLE', async () => {
    await assert.rejects(
      () => assertPaperContext({ _deps: DISCONNECTED_DEPS }),
      (err) => err.code === 'CDP_UNAVAILABLE',
    );
  });
});

describe('paper openPanel', () => {
  it('rejects invalid action', async () => {
    await assert.rejects(
      () => openPanel({ action: 'flip', _deps: contextDeps(PAPER_CONNECTED) }),
      /action must be open, close, or toggle/,
    );
  });

  it('opens the paper_trading widget via evaluate', async () => {
    let expr = '';
    const deps = {
      evaluate: async (e) => { expr = e; return { was_open: false, performed: 'opened' }; },
    };
    const res = await openPanel({ action: 'open', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.performed, 'opened');
    assert.match(expr, /showWidget/);
    assert.match(expr, /paper_trading/);
  });

  it('surfaces bottomWidgetBar errors', async () => {
    await assert.rejects(
      () => openPanel({
        _deps: { evaluate: async () => ({ error: 'bottomWidgetBar not available' }) },
      }),
      /bottomWidgetBar not available/,
    );
  });
});

describe('paper connect', () => {
  it('rejects anonymous session', async () => {
    await assert.rejects(
      () => connect({
        _deps: contextDeps({ ...PAPER_CONNECTED, session: 'anonymous', paper_connected: false }),
      }),
      (err) => err.code === 'TRADINGVIEW_AUTH_REQUIRED',
    );
  });

  it('returns already when Paper is connected', async () => {
    const res = await connect({ _deps: contextDeps(PAPER_CONNECTED) });
    assert.equal(res.already, true);
    assert.equal(res.broker_id, 'Paper');
  });

  it('selects broker Paper when disconnected', async () => {
    let asyncExpr = '';
    const deps = routedDeps({
      context: {
        ...PAPER_CONNECTED,
        paper_connected: false,
        connect_status: CONNECT_STATUS.DISCONNECTED,
        broker_id: null,
        safe_for_paper_mutation: false,
      },
      asyncMap: {
        selectBroker: (expr) => {
          asyncExpr = expr;
          return { broker_id: 'Paper', connect_status: CONNECT_STATUS.CONNECTED };
        },
      },
    });
    const res = await connect({ _deps: deps });
    assert.equal(res.connected, true);
    assert.match(asyncExpr, /selectBroker/);
    assert.match(asyncExpr, /"Paper"/);
  });

  it('fails closed if selectBroker activates a non-Paper broker', async () => {
    const deps = routedDeps({
      context: {
        ...PAPER_CONNECTED,
        paper_connected: false,
        connect_status: CONNECT_STATUS.DISCONNECTED,
        broker_id: null,
      },
      asyncMap: {
        selectBroker: { broker_id: 'BINANCE', connect_status: CONNECT_STATUS.CONNECTED },
      },
    });
    await assert.rejects(() => connect({ _deps: deps }), (err) => err.code === 'NOT_PAPER_PROVIDER');
  });
});

describe('paper read tools', () => {
  it('listAccounts returns mapped accounts after guard', async () => {
    const deps = routedDeps({
      asyncMap: {
        accountsMetainfo: [
          { id: '15372380', name: 'tester', title: 'Paper Trading', type: 'demo', currency: 'USD', is_active: true },
        ],
      },
    });
    // evaluateAsync returns the array directly from the expression result
    deps.evaluateAsync = async () => ([
      { id: '15372380', name: 'tester', title: 'Paper Trading', type: 'demo', currency: 'USD', is_active: true },
    ]);
    const res = await listAccounts({ _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.accounts[0].id, '15372380');
  });

  it('getAccount returns the account payload', async () => {
    const account = {
      id: '15372380', name: 'tester', title: 'Paper Trading', type: 'demo', currency: 'USD',
      balance: 100000, equity: 99000, realized_pnl: 0, unrealized_pnl: -1000,
      margin_used: 9000, available_funds: 90000, orders_margin: 0, margin_buffer: 90,
    };
    const deps = routedDeps({ asyncMap: { currentAccount: account } });
    deps.evaluateAsync = async () => account;
    const res = await getAccount({ _deps: deps });
    assert.equal(res.account.balance, 100000);
    assert.equal(res.account.currency, 'USD');
  });

  it('getAccount CDP script prefers meta.currency when positions are empty', async () => {
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => {
        expr = e;
        return {
          id: '15372380', name: 'tester', title: 'Paper Trading', type: 'demo', currency: 'USD',
          balance: 100000, equity: 100000, realized_pnl: 0, unrealized_pnl: 0,
          margin_used: 0, available_funds: 100000, orders_margin: 0, margin_buffer: 0,
        };
      },
    };
    await getAccount({ _deps: deps });
    assert.match(expr, /currency = meta\.currency/);
    assert.match(expr, /accountCurrency/);
  });

  it('listPositions maps evaluate result and count', async () => {
    const positions = [{ id: 'BINANCE:BTCUSDT', symbol: 'BINANCE:BTCUSDT', side: 'sell', qty: 1 }];
    let calls = 0;
    const deps = {
      evaluate: async (expr) => {
        calls += 1;
        if (expr.includes('trading-button')) return { button_found: true, button_active: true };
        // Match the listPositions body, not PAGE_HELPERS' function definitions.
        if (expr.includes('list.map(tvScalarizePosition)')) return positions;
        return { desktop: true, ...PAPER_CONNECTED };
      },
      evaluateAsync: async () => ({}),
    };
    const res = await listPositions({ _deps: deps });
    assert.equal(res.count, 1);
    assert.equal(res.positions[0].symbol, 'BINANCE:BTCUSDT');
    assert.ok(calls >= 2);
  });

  it('listPositions surfaces page errors', async () => {
    const deps = {
      evaluate: async (expr) => {
        if (expr.includes('list.map(tvScalarizePosition)')) return { error: 'boom' };
        return { desktop: true, ...PAPER_CONNECTED };
      },
      evaluateAsync: async () => ({}),
    };
    await assert.rejects(() => listPositions({ _deps: deps }), /boom/);
  });

  it('listOrders returns active orders by default', async () => {
    const orders = [{ id: '1', symbol: 'X', side: 'buy', type: 'limit', status: 'working' }];
    const deps = {
      evaluate: async (expr) => {
        if (expr.includes('list.map(tvScalarizeOrder)')) return orders;
        return { desktop: true, ...PAPER_CONNECTED };
      },
      evaluateAsync: async () => orders,
    };
    const res = await listOrders({ _deps: deps });
    assert.equal(res.history, false);
    assert.equal(res.count, 1);
  });

  it('listOrders history uses evaluateAsync', async () => {
    let usedAsync = false;
    const orders = [{ id: '9', status: 'filled' }];
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (expr) => {
        usedAsync = expr.includes('ordersHistory');
        return orders;
      },
    };
    const res = await listOrders({ history: true, _deps: deps });
    assert.equal(res.history, true);
    assert.equal(res.count, 1);
    assert.equal(usedAsync, true);
  });

  it('read tools reject non-Paper broker', async () => {
    const deps = contextDeps(FOREIGN_BROKER);
    await assert.rejects(() => listAccounts({ _deps: deps }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    await assert.rejects(() => getAccount({ _deps: deps }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    await assert.rejects(() => listPositions({ _deps: deps }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    await assert.rejects(() => listOrders({ _deps: deps }), (e) => e.code === 'NOT_PAPER_PROVIDER');
  });
});

describe('paper placeOrder guard + validation', () => {
  it('refuses placeOrder when broker is not Paper', async () => {
    await assert.rejects(
      () => placeOrder({ side: 'buy', type: 'market', qty: 1, _deps: contextDeps(FOREIGN_BROKER) }),
      (err) => err.code === 'NOT_PAPER_PROVIDER',
    );
  });

  it('validates side, qty, price, and stop_price', async () => {
    const deps = contextDeps(PAPER_CONNECTED);
    await assert.rejects(() => placeOrder({ side: 'hold', qty: 1, _deps: deps }), /side must be buy or sell/);
    await assert.rejects(() => placeOrder({ side: 'buy', qty: -1, _deps: deps }), /qty must be positive/);
    await assert.rejects(() => placeOrder({ side: 'buy', type: 'limit', qty: 1, _deps: deps }), /price is required/);
    await assert.rejects(() => placeOrder({ side: 'buy', type: 'stop', qty: 1, _deps: deps }), /stop_price is required/);
    await assert.rejects(() => placeOrder({ side: 'buy', type: 'bogus', qty: 1, _deps: deps }), /type must be market/);
  });

  it('places a market order through evaluateAsync when Paper is active', async () => {
    let asyncExpr = null;
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (expr) => {
        asyncExpr = expr;
        return { result: { order_id: '99' } };
      },
    };
    const res = await placeOrder({ side: 'buy', type: 'market', qty: 0.01, symbol: 'BINANCE:BTCUSDT', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.action, 'place_order');
    assert.match(asyncExpr, /placeOrder/);
    assert.match(asyncExpr, /tvRequirePaperBroker/);
    assert.match(asyncExpr, /BINANCE:BTCUSDT/);
  });

  it('embeds limit/stop/bracket fields in the CDP payload', async () => {
    let asyncExpr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (expr) => { asyncExpr = expr; return { result: true }; },
    };
    await placeOrder({
      side: 'sell', type: 'stop_limit', qty: 2, symbol: 'X',
      price: 10, stop_price: 11, take_profit: 9, stop_loss: 12, _deps: deps,
    });
    assert.match(asyncExpr, /limitPrice = 10/);
    assert.match(asyncExpr, /stopPrice = 11/);
    assert.match(asyncExpr, /takeProfit = 9/);
    assert.match(asyncExpr, /stopLoss = 12/);
  });

  it('embeds TIF duration and validates GTD datetime', async () => {
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (expr) => ({ result: true, expr }),
    };
    await assert.rejects(
      () => placeOrder({ side: 'buy', qty: 1, symbol: 'X', tif: 'GTD', _deps: deps }),
      /duration_datetime is required/,
    );
    await assert.rejects(
      () => placeOrder({ side: 'buy', qty: 1, symbol: 'X', tif: 'YEAR', _deps: deps }),
      /tif must be DAY/,
    );
    let asyncExpr = '';
    deps.evaluateAsync = async (expr) => { asyncExpr = expr; return { result: true }; };
    const res = await placeOrder({
      side: 'buy', qty: 1, symbol: 'X', tif: 'WEEK', _deps: deps,
    });
    assert.equal(res.tif, 'WEEK');
    assert.match(asyncExpr, /"type":"WEEK"/);
    await placeOrder({
      side: 'buy', qty: 1, symbol: 'X', tif: 'GTD', duration_datetime: 1786653569000, _deps: deps,
    });
    assert.match(asyncExpr, /"type":"GTD"/);
    assert.match(asyncExpr, /1786653569000/);
  });

  it('surfaces page-side placeOrder errors', async () => {
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async () => ({ error: 'symbol required (chart symbol unavailable)' }),
    };
    await assert.rejects(
      () => placeOrder({ side: 'buy', qty: 1, _deps: deps }),
      /symbol required/,
    );
  });
});

describe('paper mutation tools', () => {
  const foreign = contextDeps(FOREIGN_BROKER);

  it('cancelOrder rejects missing id and non-Paper broker', async () => {
    await assert.rejects(() => cancelOrder({ _deps: contextDeps(PAPER_CONNECTED) }), /order_id required/);
    await assert.rejects(() => cancelOrder({ order_id: '1', _deps: foreign }), (e) => e.code === 'NOT_PAPER_PROVIDER');
  });

  it('cancelOrder calls evaluateAsync only after Paper guard passes', async () => {
    let called = false;
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async () => { called = true; return { ok: true }; },
    };
    const res = await cancelOrder({ order_id: '42', _deps: deps });
    assert.equal(res.cancelled, true);
    assert.equal(called, true);
  });

  it('cancelOrder/closePosition/setBrackets treat Promise<void> as success', async () => {
    // Page-side maps void → ok: (undefined !== false) === true; host treats missing/undefined ok as success.
    const voidOk = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (expr) => {
        assert.match(expr, /!== false/);
        return { ok: true };
      },
    };
    assert.equal((await cancelOrder({ order_id: '1', _deps: voidOk })).cancelled, true);
    assert.equal((await closePosition({ symbol: 'X', _deps: voidOk })).closed, true);
    assert.equal((await setBrackets({ symbol: 'X', clear: true, _deps: voidOk })).updated, true);

    const explicitFail = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async () => ({ ok: false }),
    };
    assert.equal((await cancelOrder({ order_id: '1', _deps: explicitFail })).cancelled, false);
  });

  it('modifyOrder requires id, rejects foreign broker, and succeeds on Paper', async () => {
    await assert.rejects(() => modifyOrder({ _deps: contextDeps(PAPER_CONNECTED) }), /order_id required/);
    await assert.rejects(() => modifyOrder({ order_id: '1', _deps: foreign }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => { expr = e; return { ok: true }; },
    };
    const res = await modifyOrder({ order_id: '7', qty: 2, price: 100, _deps: deps });
    assert.equal(res.modified, true);
    assert.match(expr, /modifyOrder/);
    assert.match(expr, /qty = 2/);
    assert.match(expr, /tvRequirePaperBroker/);
    // Fallback lookup must align with paper_list_orders (OrdersService.activeOrders).
    assert.match(expr, /activeOrders/);
    assert.match(expr, /_ordersService/);
    assert.doesNotMatch(expr, /await ab\.orders\(\)/);
  });

  it('closePosition requires id and supports partial qty', async () => {
    await assert.rejects(() => closePosition({ _deps: contextDeps(PAPER_CONNECTED) }), /position_id or symbol required/);
    await assert.rejects(() => closePosition({ symbol: 'X', _deps: foreign }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => { expr = e; return { ok: true }; },
    };
    const res = await closePosition({ symbol: 'BINANCE:BTCUSDT', qty: 0.5, _deps: deps });
    assert.equal(res.closed, true);
    assert.equal(res.qty, 0.5);
    assert.match(expr, /closePosition/);
    assert.match(expr, /0\.5/);
  });

  it('setBrackets requires levels and updates via editPositionBrackets', async () => {
    await assert.rejects(
      () => setBrackets({ symbol: 'X', _deps: contextDeps(PAPER_CONNECTED) }),
      /stop_loss or take_profit required/,
    );
    await assert.rejects(
      () => setBrackets({ symbol: 'X', stop_loss: 1, _deps: foreign }),
      (e) => e.code === 'NOT_PAPER_PROVIDER',
    );
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => { expr = e; return { ok: true }; },
    };
    const res = await setBrackets({ position_id: 'BINANCE:BTCUSDT', stop_loss: 70000, take_profit: 60000, _deps: deps });
    assert.equal(res.updated, true);
    assert.deepEqual(res.brackets, { stopLoss: 70000, takeProfit: 60000 });
    assert.match(expr, /editPositionBrackets/);
  });

  it('setBrackets clear removes SL/TP', async () => {
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => { expr = e; return { ok: true }; },
    };
    const res = await setBrackets({ symbol: 'BINANCE:BTCUSDT', clear: true, _deps: deps });
    assert.equal(res.action, 'clear_brackets');
    assert.deepEqual(res.brackets, { stopLoss: null, takeProfit: null });
    assert.match(expr, /null/);
  });

  it('switchAccount requires id and calls setCurrentAccount', async () => {
    await assert.rejects(() => switchAccount({ _deps: contextDeps(PAPER_CONNECTED) }), /account_id required/);
    await assert.rejects(() => switchAccount({ account_id: '1', _deps: foreign }), (e) => e.code === 'NOT_PAPER_PROVIDER');
    let expr = '';
    const deps = {
      evaluate: async () => ({ desktop: true, ...PAPER_CONNECTED }),
      evaluateAsync: async (e) => { expr = e; return { account_id: '15372380' }; },
    };
    const res = await switchAccount({ account_id: '15372380', _deps: deps });
    assert.equal(res.account_id, '15372380');
    assert.match(expr, /setCurrentAccount/);
  });
});

describe('paper_cdp PAGE_HELPERS serializers', () => {
  it('tvScalarizePosition maps Capture-2 position fields', () => {
    const out = runPageHelper('tvScalarizePosition', {
      id: 'BINANCE:BTCUSDT',
      symbol: 'BINANCE:BTCUSDT',
      side: -1,
      qty: 1.55,
      avgPrice: 64466.51,
      lastPrice: 65000,
      marketValue: 100,
      pl: -1,
      supportBrackets: true,
      supportStopLoss: true,
      supportTrailingStop: false,
      stopLoss: 70000,
      takeProfit: 60000,
      extra: {
        pl: -785,
        plPercent: -0.7,
        accountCurrency: 'USD',
        leverage: '10:1',
        usedMargin: 9900,
      },
    });
    assert.equal(out.side, 'sell');
    assert.equal(out.unrealized_pnl, -785);
    assert.equal(out.currency, 'USD');
    assert.equal(out.leverage, '10:1');
    assert.equal(out.stop_loss, 70000);
    assert.equal(out.support_trailing_stop, false);
  });

  it('tvScalarizeOrder maps type/status enums', () => {
    const out = runPageHelper('tvScalarizeOrder', {
      id: 3382363357,
      symbol: 'BINANCE:BTCUSDT',
      side: 1,
      type: 1,
      status: 6,
      qty: 0.001,
      limitPrice: 1000,
      extra: { accountCurrency: 'USD', leverage: '10:1', usedMargin: 0.1 },
    });
    assert.equal(out.id, '3382363357');
    assert.equal(out.side, 'buy');
    assert.equal(out.type, 'limit');
    assert.equal(out.status, 'working');
    assert.equal(out.limit_price, 1000);
  });

  it('tvBrokerId reads _brokerMetainfo.id', () => {
    assert.equal(runPageHelper('tvBrokerId', { _brokerMetainfo: { id: 'Paper' } }), 'Paper');
    assert.equal(runPageHelper('tvBrokerId', null), null);
  });

  it('tvRequirePaperBroker fails closed for non-Paper brokers', () => {
    assert.equal(runPageHelper('tvRequirePaperBroker', { _brokerMetainfo: { id: 'Paper' } }), null);
    const denied = runPageHelper('tvRequirePaperBroker', { _brokerMetainfo: { id: 'BINANCE' } });
    assert.match(denied.error, /not native Paper/);
    assert.match(runPageHelper('tvRequirePaperBroker', null).error, /got null/);
  });

  it('tvWv unwraps WatchedValue-like objects', () => {
    assert.equal(runPageHelper('tvWv', { value: () => 3 }), 3);
    assert.equal(runPageHelper('tvWv', { value: 7 }), 7);
    assert.equal(runPageHelper('tvWv', 5), 5);
  });

  it('keeps SUMMARY_IDS aligned with Capture-2 account fields', () => {
    assert.deepEqual(SUMMARY_IDS, [
      'balance', 'equity', 'realized_pnl', 'unrealized_pnl',
      'margin_used', 'available_funds', 'orders_margin', 'margin_buffer',
    ]);
  });

  it('tradingPanelButtonProbe targets trading-button selectors', () => {
    const probe = tradingPanelButtonProbe();
    assert.match(probe, /trading-button/);
    assert.match(probe, /Trading Panel/);
  });
});

describe('paper constants', () => {
  it('exports the Capture-2 stable broker id', () => {
    assert.equal(NATIVE_PAPER_BROKER_ID, 'Paper');
  });
});
