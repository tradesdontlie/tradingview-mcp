/**
 * Core alert logic.
 *
 * Alerts are created/listed/deleted via TradingView's pricealerts REST API
 * (pricealerts.tradingview.com), called from the page context so the session
 * cookies authenticate the request. This replaces the old DOM-dialog automation,
 * which broke when TradingView changed the alert dialog markup (the price input
 * never got populated → price_set:false → no alert created).
 *
 * Request notes (discovered empirically against TVDesktop 3.2.0 / Chrome 140):
 *  - Content-Type must be a CORS "simple" type (text/plain). A JSON content-type
 *    triggers a cross-subdomain preflight that TradingView rejects ("Failed to fetch").
 *  - Body is wrapped: { payload: { conditions:[...], symbol, resolution, ... } }.
 *  - conditions[].type: "cross" | "cross_up" | "cross_down" | "greater" | "less".
 *  - expiration is REQUIRED (null → no_infinity_expiration_permissions on most
 *    plans) and capped (~88 days observed) → default 60 days.
 */
import { evaluateAsync as _evaluateAsync } from '../connection.js';

// Allow tests to inject a mock evaluateAsync (mirrors the DI pattern in chart.js/data.js).
function _resolve(deps) {
  return { evaluateAsync: deps?.evaluateAsync || _evaluateAsync };
}

// caller condition -> TradingView condition type
const CONDITION_MAP = {
  crossing: 'cross', cross: 'cross',
  crossing_up: 'cross_up', cross_up: 'cross_up', crossup: 'cross_up',
  crossing_down: 'cross_down', cross_down: 'cross_down', crossdown: 'cross_down',
  greater_than: 'greater', greater: 'greater', above: 'greater', gt: 'greater',
  less_than: 'less', less: 'less', below: 'less', lt: 'less',
};
const CONDITION_LABEL = {
  cross: 'crossing', cross_up: 'crossing up', cross_down: 'crossing down',
  greater: 'greater than', less: 'less than',
};

const PRICEALERTS = 'https://pricealerts.tradingview.com';

export async function create({ condition, price, message, resolution = '1', expiration_days = 60, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const type = CONDITION_MAP[String(condition ?? 'crossing').toLowerCase().trim()] || 'cross';
  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) throw new Error('A positive numeric price is required.');

  const result = await evaluateAsync(`
    (async function() {
      var api;
      try { api = window.TradingViewApi._activeChartWidgetWV.value(); } catch (e) { return { error: 'no_active_chart' }; }
      var sym = '';
      try { sym = api.symbol() || ''; } catch (e) {}
      if (!sym) { try { sym = (api.symbolExt() || {}).symbol || ''; } catch (e) {} }
      if (!sym) return { error: 'could_not_resolve_symbol' };
      var cur = 'USD';
      try { var ext = api.symbolExt() || {}; if (ext.currency_code) cur = ext.currency_code; } catch (e) {}

      var serial = '=' + JSON.stringify({ symbol: sym, adjustment: 'splits', 'currency-id': cur });
      var price = ${JSON.stringify(numPrice)};
      var label = ${JSON.stringify(CONDITION_LABEL[type] || 'crossing')};
      var msg = ${JSON.stringify(message || '')} || (sym + ' ' + label + ' ' + price);

      var payload = { payload: {
        conditions: [{ type: ${JSON.stringify(type)}, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: ${JSON.stringify(resolution)} }],
        symbol: serial, resolution: ${JSON.stringify(resolution)}, message: msg,
        sound_file: 'alert/funny/cash-register', sound_duration: 0, popup: true, auto_deactivate: true,
        email: false, sms_over_email: false, mobile_push: true, web_hook: null, name: null,
        expiration: new Date(Date.now() + ${Number(expiration_days)} * 24 * 3600 * 1000).toISOString(),
        active: true, ignore_warnings: true
      }};

      var resp;
      try {
        resp = await fetch('${PRICEALERTS}/create_alert', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }).then(function (r) { return r.json(); });
      } catch (e) { return { error: 'request_failed:' + e.message, symbol: sym }; }
      if (resp.s !== 'ok' || !resp.r || !resp.r.alert_id) {
        return { error: (resp.err && resp.err.code) || resp.errmsg || 'rejected', symbol: sym };
      }
      var alertId = resp.r.alert_id;

      // Verify the alert actually exists with the right symbol + price (fail loudly otherwise)
      var verified = false, vval = null, vsym = null;
      try {
        var list = await fetch('${PRICEALERTS}/list_alerts', { credentials: 'include' }).then(function (r) { return r.json(); });
        var found = (list.r || []).filter(function (a) { return a.alert_id === alertId; })[0];
        if (found) { verified = true; try { vval = found.condition.series[1].value; } catch (e) {} try { vsym = JSON.parse(found.symbol.replace(/^=/, '')).symbol; } catch (e) { vsym = found.symbol; } }
      } catch (e) {}
      return { alert_id: alertId, symbol: sym, price: price, condition: ${JSON.stringify(type)}, message: msg, verified: verified, verified_value: vval, verified_symbol: vsym };
    })()
  `);

  if (result?.error) {
    const code = result.error;
    const hint =
      code === 'no_infinity_expiration_permissions' ? ' — your TradingView plan requires an expiration date' :
      code === 'invalid_request' ? ' — check price and expiration (must be < ~88 days)' :
      code === 'no_active_chart' || code === 'could_not_resolve_symbol' ? ' — set the chart symbol first (chart_set_symbol)' : '';
    return { success: false, error: code + hint, symbol: result.symbol, source: 'rest_api' };
  }
  if (!result?.verified) {
    return { success: false, error: 'alert POST returned ok but was not found on verification', alert_id: result?.alert_id, symbol: result?.symbol, source: 'rest_api' };
  }
  return {
    success: true, alert_id: result.alert_id, symbol: result.verified_symbol || result.symbol,
    condition: result.condition, price: result.verified_value ?? result.price, message: result.message, source: 'rest_api',
  };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('${PRICEALERTS}/list_alerts', { credentials: 'include' })
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

export async function deleteAlerts({ delete_all, alert_id, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  let ids = [];
  if (alert_id != null) ids = Array.isArray(alert_id) ? alert_id.map(Number) : [Number(alert_id)];

  const result = await evaluateAsync(`
    (async function() {
      var ids = ${JSON.stringify(ids)};
      if (${delete_all ? 'true' : 'false'}) {
        try {
          var list = await fetch('${PRICEALERTS}/list_alerts', { credentials: 'include' }).then(function (r) { return r.json(); });
          ids = (list.r || []).map(function (a) { return a.alert_id; });
        } catch (e) { return { error: 'list_failed:' + e.message }; }
      }
      if (!ids.length) return { deleted: 0, ids: [] };
      try {
        var resp = await fetch('${PRICEALERTS}/delete_alerts', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ payload: { alert_ids: ids } }) }).then(function (r) { return r.json(); });
        if (resp.s !== 'ok') return { error: (resp.err && resp.err.code) || resp.errmsg || 'rejected', ids: ids };
        return { deleted: ids.length, ids: ids };
      } catch (e) { return { error: 'request_failed:' + e.message }; }
    })()
  `);

  if (result?.error) return { success: false, error: result.error, source: 'rest_api' };
  return { success: true, deleted: result.deleted, alert_ids: result.ids, source: 'rest_api' };
}
