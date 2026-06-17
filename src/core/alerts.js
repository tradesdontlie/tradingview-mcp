/**
 * Core alert logic.
 *
 * Alerts are managed through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com), reusing the desktop app's logged-in
 * session via `credentials: 'include'`. This is far more reliable than driving
 * the alert dialog through the DOM: the dialog's price field is a React
 * controlled input that ignores synthetic value assignments (so DOM-set prices
 * silently revert to the prefilled current price), and the "Create alert"
 * button's aria-label casing varies between TradingView Desktop builds.
 *
 * REST notes:
 * - Use Content-Type 'text/plain' to avoid a CORS preflight the endpoint rejects.
 * - create_alert  body: {"payload": { ...alert spec... }}
 * - delete_alerts body: {"payload": {"alert_ids": [id, ...]}}
 */
import { evaluate, evaluateAsync } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// Map friendly condition names to TradingView alert condition types.
const CONDITION_TYPES = {
  cross: 'cross', crossing: 'cross',
  cross_up: 'cross_up', crossing_up: 'cross_up',
  cross_down: 'cross_down', crossing_down: 'cross_down',
  greater: 'greater', greater_than: 'greater', above: 'greater',
  less: 'less', less_than: 'less', below: 'less',
};

async function getChartContext() {
  const r = await evaluate(`
    (function() {
      try { var c = ${CHART_API}; return { symbol: c.symbol(), resolution: String(c.resolution()) }; }
      catch (e) { return { symbol: null, resolution: null, error: e.message }; }
    })()
  `);
  return r || {};
}

// POST a text/plain JSON body to a pricealerts endpoint and return the parsed response.
async function postAlertApi(endpoint, bodyObj) {
  const bodyStr = JSON.stringify(bodyObj);
  return await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/${endpoint}', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${JSON.stringify(bodyStr)}
    })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { s: 'error', errmsg: e.message }; })
  `);
}

export async function create({ condition, price, message, symbol, resolution }) {
  const value = Number(price);
  if (!Number.isFinite(value)) throw new Error('price must be a finite number');

  const type = CONDITION_TYPES[String(condition || 'cross').toLowerCase()] || 'cross';

  const ctx = await getChartContext();
  const sym = symbol || ctx.symbol;
  if (!sym) throw new Error(`Could not determine chart symbol (${ctx.error || 'no active chart'}); pass symbol explicitly.`);
  const res = String(resolution || ctx.resolution || '1');

  const msg = message || `${sym} ${condition || 'crossing'} ${value}`;
  const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const payload = {
    payload: {
      conditions: [{
        type,
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value }],
        resolution: res,
      }],
      symbol: `=${JSON.stringify({ symbol: sym })}`,
      resolution: res,
      message: msg,
      sound_file: null,
      sound_duration: 0,
      popup: true,
      auto_deactivate: true,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: null,
      expiration,
      active: true,
      ignore_warnings: true,
    },
  };

  const result = await postAlertApi('create_alert', payload);
  if (!result || result.s !== 'ok') {
    const err = (result && (result.errmsg || (result.err && JSON.stringify(result.err)))) || 'create failed';
    return { success: false, price: value, condition: type, symbol: sym, message: msg, error: err, source: 'rest_api' };
  }
  const a = result.r || {};
  return {
    success: true,
    alert_id: a.alert_id,
    symbol: sym,
    price: value,
    condition: type,
    resolution: res,
    message: msg,
    active: a.active,
    expiration: a.expiration,
    source: 'rest_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            var price = null;
            try { (a.condition.series || []).forEach(function(s) { if (s && s.value != null) price = s.value; }); } catch(e) {}
            return {
              alert_id: a.alert_id,
              symbol: sym,
              price: price,
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
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'rest_api', alerts: result?.alerts || [], error: result?.error };
}

/**
 * Delete alerts via the REST API.
 * Pass one of: delete_all (bool), alert_id (number), alert_ids (number[]),
 * or price (number — deletes every alert whose level matches).
 */
export async function deleteAlerts({ delete_all, alert_id, alert_ids, price }) {
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);

  if (delete_all || price != null) {
    const listed = await list();
    const alerts = listed.alerts || [];
    if (delete_all) {
      ids = ids.concat(alerts.map(a => a.alert_id));
    } else {
      const target = Number(price);
      ids = ids.concat(
        alerts.filter(a => Number(a.price) === target).map(a => a.alert_id)
      );
    }
  }

  ids = [...new Set(ids.map(Number).filter(n => Number.isFinite(n)))];
  if (!ids.length) {
    return { success: true, deleted: 0, alert_ids: [], note: 'no matching alerts to delete', source: 'rest_api' };
  }

  const result = await postAlertApi('delete_alerts', { payload: { alert_ids: ids } });
  const ok = !!result && result.s === 'ok';
  return {
    success: ok,
    deleted: ok ? ids.length : 0,
    alert_ids: ids,
    error: ok ? undefined : ((result && (result.errmsg || (result.err && JSON.stringify(result.err)))) || 'delete failed'),
    source: 'rest_api',
  };
}
