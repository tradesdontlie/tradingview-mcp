/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  return evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
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
              has_webhook: !!a.web_hook,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list();
    ids = (listed.alerts || []).map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return { success: false, source: 'internal_api', error: delete_all ? 'No alerts to delete.' : 'Provide delete_all: true or an alert_id to delete.' };
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        return { ok: data.s === 'ok', status: x.status, response: (x.responseText || '').slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (result && result.ok) {
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  }
  return { success: false, source: 'internal_api', alert_ids: ids, error: (result && (result.error || result.response)) || 'delete failed' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhook for an existing alert (alert_set_webhook). Sends a TradingView alert to your own webhook endpoint when it
// fires. The URL is read from the TV_ALERT_WEBHOOK_URL environment variable of the MCP process, never from a tool
// argument, and it is never returned or logged: results carry only the host. Only https URLs are accepted.
// Inactive alerts are refused, because re-saving one would re-arm it.
// ---------------------------------------------------------------------------------------------------------------------
const WEBHOOK_FIELDS = ['conditions', 'symbol', 'resolution', 'message', 'sound_file', 'sound_duration', 'popup',
  'auto_deactivate', 'email', 'sms_over_email', 'mobile_push', 'name', 'notification_schedule'];

export async function setWebhook({ alert_id } = {}) {
  const id = Number(alert_id);
  if (!Number.isInteger(id) || id <= 0) {
    return { success: false, source: 'internal_api', error: 'alert_id must be a positive integer (from alert_list)' };
  }
  const raw = process.env.TV_ALERT_WEBHOOK_URL || '';
  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || url.protocol !== 'https:') {
    return { success: false, source: 'internal_api', error: 'set TV_ALERT_WEBHOOK_URL (an https URL) in the MCP environment' };
  }

  const result = await evaluateAsync(`
    (async function() {
      try {
        var ID = ${id}, HOOK = ${safeString(raw)}, F = ${JSON.stringify(WEBHOOK_FIELDS)};
        var d = await (await fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })).json();
        if (d.s !== 'ok') return { ok: false, why: 'could not list alerts' };
        var a = (d.r || []).find(function(x) { return x.alert_id === ID; });
        if (!a) return { ok: false, why: 'no such alert' };
        if (!a.active) return { ok: false, why: 'alert is not active: saving it would re-arm it' };
        if (a.web_hook === HOOK) return { ok: true, already: true };
        var p = {};
        F.forEach(function(k) { if (k in a && a[k] !== undefined) p[k] = a[k]; });
        if (a.expiration_policy) p.expiration_policy = a.expiration_policy; else p.expiration = a.expiration;
        p.web_hook = HOOK; p.active = true; p.ignore_warnings = true; p.alert_id = ID;
        var u = new URL('https://pricealerts.tradingview.com/modify_restart_alert');
        u.searchParams.set('log_username', (window.user && window.user.username) || '');
        var j = await (await fetch(u.toString(), { method: 'POST', credentials: 'include', body: JSON.stringify({ payload: p }) })).json();
        if (j.s !== 'ok') return { ok: false, why: 'TradingView refused: ' + ((j.err && j.err.code) || j.errmsg || 'unknown') };
        return { ok: true, already: false };
      } catch (e) { return { ok: false, why: 'page error: ' + (e && e.name) }; }
    })()
  `);
  if (!result?.ok) return { success: false, source: 'internal_api', alert_id: id, error: result?.why || 'unknown' };
  return { success: true, source: 'internal_api', alert_id: id, webhook_host: url.host, already_set: !!result.already };
}
