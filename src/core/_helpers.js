/**
 * Shared helpers used across core modules.
 *
 * - findStrategyJS: returns a JS snippet that locates the strategy data source
 *   on the active chart (works for Pine v4/v5/v6 strategies regardless of
 *   is_price_study). The legacy filter `is_price_study === false` misses Pine v6
 *   strategies whose pane is reported as is_price_study=true. We instead detect
 *   the strategy signature: reportData && (ordersData || tradesData).
 *
 * - normaliseLabel: TradingView's icon+text buttons render duplicated textContent
 *   like "Add to chartAdd to chart". This collapses `XX` -> `X` for clean regex.
 *
 * - findDialogJS: locates a modal/dialog by title substring; useful for the
 *   "Save script" dialog that blocks Add-to-chart on unnamed scripts.
 */

export const STRATEGY_FIND_JS = `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (s.reportData && (s.ordersData || s.tradesData)) return s;
    }
    return null;
  })()
`;

export const STRATEGY_NAME_JS = `
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (s.reportData && (s.ordersData || s.tradesData)) {
          try {
            var m = s.metaInfo ? s.metaInfo() : null;
            return (m && (m.description || m.shortDescription)) || (typeof s.title === 'function' ? s.title() : (s.title || null));
          } catch(e) { return null; }
        }
      }
    } catch(e) {}
    return null;
  })()
`;

/** Normalise duplicated icon-label text (e.g. "Add to chartAdd to chart" -> "Add to chart"). */
export function jsNormaliseLabel() {
  return `(function(t){ if(!t) return ''; t = String(t).trim(); var h = Math.floor(t.length/2); if(t.length>0 && t.length%2===0 && t.slice(0,h)===t.slice(h)) return t.slice(0,h); return t; })`;
}

/** JS that, given a button element, returns its normalised visible label. */
export const BUTTON_LABEL_JS = `${jsNormaliseLabel()}`;

/**
 * Convert a Pine-strategy data source's reportData into a plain JS object
 * by calling .value() / unwrapping observables. Returns null if not available.
 */
export const UNWRAP_REPORT_JS = `
  (function(strat) {
    if (!strat || !strat.reportData) return null;
    var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
    if (rd && typeof rd.value === 'function') rd = rd.value();
    if (!rd || typeof rd !== 'object') return null;
    var out = {};
    var keys = Object.keys(rd);
    for (var k = 0; k < keys.length; k++) {
      var v = rd[keys[k]];
      if (v !== null && v !== undefined && typeof v !== 'function') out[keys[k]] = v;
    }
    return out;
  })
`;

/** Return a Set-like object listing which top-level keys to keep on a strategy report. */
export function buildFieldsFilter(fields) {
  if (!fields || (Array.isArray(fields) && fields.length === 0)) return null;
  const list = Array.isArray(fields) ? fields : [fields];
  return new Set(list.map(f => String(f).trim()).filter(Boolean));
}

/**
 * Trim a strategy report object to a high-signal summary suitable for the
 * agent's context budget. Keeps only `performance.all` headline metrics + meta.
 */
export function summariseReport(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;
  const perfAll = metrics.performance && metrics.performance.all ? metrics.performance.all : null;
  const perfRoot = metrics.performance || {};
  const summary = {
    currency: metrics.currency || null,
    period: metrics.settings?.dateRange?.backtest || metrics.settings?.dateRange || null,
  };
  if (perfAll) {
    summary.net_profit = perfAll.netProfit;
    summary.net_profit_pct = perfAll.netProfitPercent;
    summary.total_trades = perfAll.totalTrades;
    summary.winning_trades = perfAll.numberOfWiningTrades;
    summary.losing_trades = perfAll.numberOfLosingTrades;
    summary.percent_profitable = perfAll.percentProfitable;
    summary.profit_factor = perfAll.profitFactor;
    summary.avg_trade = perfAll.avgTrade;
    summary.avg_trade_pct = perfAll.avgTradePercent;
    summary.largest_win = perfAll.largestWinTrade;
    summary.largest_loss = perfAll.largestLosTrade;
    summary.gross_profit = perfAll.grossProfit;
    summary.gross_loss = perfAll.grossLoss;
    summary.commission_paid = perfAll.commissionPaid;
    summary.max_contracts_held = perfAll.maxContractsHeld;
  }
  if (perfRoot) {
    summary.sharpe_ratio = perfRoot.sharpeRatio;
    summary.sortino_ratio = perfRoot.sortinoRatio;
    summary.max_drawdown = perfRoot.maxStrategyDrawDown;
    summary.max_drawdown_pct = perfRoot.maxStrategyDrawDownPercent;
    summary.max_runup = perfRoot.maxStrategyRunUp;
    summary.max_runup_pct = perfRoot.maxStrategyRunUpPercent;
    summary.buy_hold_return = perfRoot.buyHoldReturn;
    summary.buy_hold_return_pct = perfRoot.buyHoldReturnPercent;
    summary.open_pl = perfRoot.openPL;
  }
  return summary;
}

/** Apply a fields filter to a metrics object, preserving only requested top-level keys. */
export function pickFields(metrics, fieldSet) {
  if (!fieldSet) return metrics;
  const out = {};
  for (const k of Object.keys(metrics || {})) {
    if (fieldSet.has(k)) out[k] = metrics[k];
  }
  return out;
}

/** JS snippet that finds an open dialog/modal element. Returns title text + a click-by-text helper. */
export const DIALOG_FIND_JS = `
  (function() {
    var dlg = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog-"], [class*="popupDialog-"]');
    if (!dlg || dlg.offsetParent === null) return null;
    var titleEl = dlg.querySelector('[class*="title"], [class*="header"] span');
    var title = titleEl ? titleEl.textContent.trim() : '';
    var buttons = [];
    dlg.querySelectorAll('button').forEach(function(b) {
      if (b.offsetParent !== null) buttons.push({ text: b.textContent.trim(), disabled: b.disabled || false });
    });
    return { title: title, buttons: buttons };
  })()
`;
