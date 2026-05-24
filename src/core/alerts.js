/**
 * Core alert logic.
 *
 * create() and list() use TradingView's internal pricealerts.tradingview.com REST API
 * (same backend the desktop UI uses). Discovered by intercepting the network call from
 * the "Create alert" dialog. The DOM-fallback path that earlier shipped here never
 * matched the real alert dialog selectors and silently no-op'd.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const CREATE_URL = 'https://pricealerts.tradingview.com/create_alert';
const LIST_URL = 'https://pricealerts.tradingview.com/list_alerts';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

/**
 * Build the alert payload shape the pricealerts service expects. Shape was reverse-engineered
 * by hooking fetch in the page context and triggering the native Create-alert dialog.
 */
function buildPayload({ symbol, price, message, resolution, frequency, expirationDays }) {
  const symbolWrapped = '=' + JSON.stringify({
    adjustment: 'splits',
    'currency-id': 'USD',
    session: 'extended',
    symbol,
  });
  return {
    payload: {
      conditions: [{
        type: 'cross',
        frequency,
        series: [{ type: 'barset' }, { type: 'value', value: price }],
        resolution,
      }],
      symbol: symbolWrapped,
      resolution,
      message: message || `${symbol} crossing ${price}`,
      sound_file: 'alert/fired',
      sound_duration: 0,
      popup: true,
      auto_deactivate: true,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: null,
      expiration: new Date(Date.now() + expirationDays * 86400 * 1000).toISOString(),
      active: true,
      ignore_warnings: true,
    },
  };
}

export async function create({ condition, price, message, symbol, resolution, frequency, expiration_days, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);

  const priceNum = requireFinite(price, 'price');
  const expDays = expiration_days != null ? requireFinite(expiration_days, 'expiration_days') : 30;
  const freq = frequency || 'on_first_fire';

  let sym = symbol;
  let res = resolution;
  if (!sym || !res) {
    const state = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          return { symbol: chart.symbol(), resolution: chart.resolution() };
        } catch(e) { return { error: e.message }; }
      })()
    `);
    if (state?.error || !state?.symbol) throw new Error('Cannot read current chart symbol/resolution: ' + (state?.error || 'unknown'));
    sym = sym || state.symbol;
    res = res || state.resolution || '1';
  }

  // Note: `condition` is accepted for backwards compat but the underlying API uses
  // type:cross + cross_interval which fires on any crossing in either direction.
  void condition;

  const payload = buildPayload({ symbol: sym, price: priceNum, message, resolution: res, frequency: freq, expirationDays: expDays });

  const result = await evaluateAsync(`
    fetch(${safeString(CREATE_URL)}, {
      method: 'POST',
      credentials: 'include',
      body: ${safeString(JSON.stringify(payload))}
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (result?.error) {
    return { success: false, source: 'internal_api', error: result.error, price: priceNum, symbol: sym };
  }

  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch {}
  const ok = parsed?.s === 'ok';

  return {
    success: ok,
    source: 'internal_api',
    symbol: sym,
    resolution: res,
    price: priceNum,
    condition: 'crossing',
    message: message || `${sym} crossing ${price}`,
    expiration_days: expDays,
    alert_id: parsed?.r?.id || null,
    error: ok ? null : (parsed?.errmsg || result.body?.slice(0, 200)),
  };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const result = await evaluateAsync(`
    fetch(${safeString(LIST_URL)}, { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
