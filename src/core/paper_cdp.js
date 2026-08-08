/**
 * CDP page-side helpers for native Paper Trading.
 *
 * Keeps injected browser strings and DOM probes out of the use-case module
 * (src/core/paper.js) so policy code stays focused on Paper-only rules.
 */
import { RIGHT_RAIL_PANEL_SELECTORS } from './ui.js';

/** Account summary field order aligned with accountsMetainfo.summaryRow (Capture 2). */
export const SUMMARY_IDS = [
  'balance',
  'equity',
  'realized_pnl',
  'unrealized_pnl',
  'margin_used',
  'available_funds',
  'orders_margin',
  'margin_buffer',
];

/**
 * Shared page-side helpers injected into CDP expressions.
 * Tested via new Function in tests/paper.test.js (same pattern as paper_discovery).
 */
export const PAGE_HELPERS = `
  function tvWv(x) {
    if (x == null || typeof x !== 'object') return x;
    if (typeof x.value === 'function') return x.value();
    if ('value' in x) return x.value;
    return x;
  }
  function tvTrading() {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return null;
    var ctrl = bwb._widgetControllers && bwb._widgetControllers.get('paper_trading');
    return ctrl && ctrl._trading || null;
  }
  function tvBroker(t) {
    if (!t || !t.activeBroker) return null;
    return tvWv(t.activeBroker());
  }
  function tvBrokerId(ab) {
    if (!ab) return null;
    try {
      if (ab._brokerMetainfo && ab._brokerMetainfo.id != null) return String(ab._brokerMetainfo.id);
    } catch (e) {}
    return null;
  }
  /** Page-side fail-closed guard for mutations (stable id "Paper"). */
  function tvRequirePaperBroker(ab) {
    var id = tvBrokerId(ab);
    if (id !== 'Paper') {
      return { error: 'Active broker is not native Paper Trading (got ' + (id || 'null') + '). Refusing mutation.' };
    }
    return null;
  }
  function tvScalarizePosition(p) {
    if (!p || typeof p !== 'object') return null;
    var extra = p.extra || {};
    return {
      id: p.id != null ? String(p.id) : null,
      symbol: p.symbol != null ? String(p.symbol) : null,
      side: p.side === 1 ? 'buy' : (p.side === -1 ? 'sell' : p.side),
      qty: typeof p.qty === 'number' ? p.qty : null,
      avg_price: typeof p.avgPrice === 'number' ? p.avgPrice : null,
      last_price: typeof p.lastPrice === 'number' ? p.lastPrice : null,
      market_value: typeof p.marketValue === 'number' ? p.marketValue : null,
      unrealized_pnl: typeof (extra.pl != null ? extra.pl : p.pl) === 'number' ? (extra.pl != null ? extra.pl : p.pl) : null,
      unrealized_pnl_percent: typeof extra.plPercent === 'number' ? extra.plPercent : null,
      currency: extra.accountCurrency || null,
      leverage: extra.leverage || null,
      margin_used: typeof extra.usedMargin === 'number' ? extra.usedMargin : null,
      support_brackets: !!p.supportBrackets,
      support_stop_loss: !!p.supportStopLoss,
      support_trailing_stop: !!p.supportTrailingStop,
      stop_loss: p.stopLoss == null ? null : p.stopLoss,
      take_profit: p.takeProfit == null ? null : p.takeProfit,
    };
  }
  function tvScalarizeOrder(o) {
    if (!o || typeof o !== 'object') return null;
    var statusMap = { 1: 'canceled', 2: 'filled', 3: 'inactive', 4: 'placing', 5: 'rejected', 6: 'working' };
    var typeMap = { 1: 'limit', 2: 'market', 3: 'stop', 4: 'stop_limit' };
    var extra = o.extra || {};
    return {
      id: o.id != null ? String(o.id) : null,
      symbol: o.symbol != null ? String(o.symbol) : null,
      side: o.side === 1 ? 'buy' : (o.side === -1 ? 'sell' : o.side),
      type: typeMap[o.type] || o.type,
      status: statusMap[o.status] || o.status,
      qty: typeof o.qty === 'number' ? o.qty : null,
      limit_price: typeof o.limitPrice === 'number' ? o.limitPrice : null,
      stop_price: typeof o.stopPrice === 'number' ? o.stopPrice : null,
      avg_price: typeof o.avgPrice === 'number' ? o.avgPrice : null,
      take_profit: o.takeProfit == null ? null : o.takeProfit,
      stop_loss: o.stopLoss == null ? null : o.stopLoss,
      currency: extra.accountCurrency || null,
      leverage: extra.leverage || null,
      margin_used: typeof extra.usedMargin === 'number' ? extra.usedMargin : null,
    };
  }
`;

/** Observational probe for the Trading Panel toggle button (no clicks). */
export function tradingPanelButtonProbe() {
  const { dataNames, ariaLabels } = RIGHT_RAIL_PANEL_SELECTORS.trading;
  return `
    (function() {
      var dataNames = ${JSON.stringify(dataNames)};
      var ariaLabels = ${JSON.stringify(ariaLabels)};
      var btn = null;
      for (var d = 0; d < dataNames.length && !btn; d++) btn = document.querySelector('[data-name="' + dataNames[d] + '"]');
      for (var a = 0; a < ariaLabels.length && !btn; a++) btn = document.querySelector('[aria-label="' + ariaLabels[a] + '"]');
      if (!btn) return { button_found: false };
      var classes = btn.classList.toString();
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.contains('isActive')
        || classes.indexOf('active') !== -1
        || classes.indexOf('Active') !== -1;
      return { button_found: true, button_active: isActive };
    })()
  `;
}
