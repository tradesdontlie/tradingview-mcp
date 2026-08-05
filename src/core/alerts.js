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

/**
 * Read recently fired / triggered alerts (the Alerts panel "Log").
 *
 * Two layers, both authenticated via the desktop app's session cookies:
 *   1. Best-effort: the pricealerts fired-events endpoint (richer per-fire
 *      history). Its exact path is not officially documented, so this is
 *      opportunistic — a failure never breaks the tool.
 *   2. Reliable fallback: derive the log from list_alerts (a proven endpoint) —
 *      every alert carrying a last_fire_time is a fired alert, most-recent first.
 * The `source` field reports which layer produced the result.
 */
export async function getLog({ limit, _deps } = {}) {
  const evalAsync = _deps?.evaluateAsync || evaluateAsync;
  const cap = Math.max(1, Math.min(Number(limit) || 20, 100));

  const result = await evalAsync(`
    (async function() {
      var out = { fires: null, derived: [], error: null };

      function unwrapSym(s) {
        try { if (s && String(s).charAt(0) === '=') return JSON.parse(String(s).replace(/^=/, '')).symbol || s; } catch (e) {}
        return s;
      }

      // Proven endpoint: current alerts (used for the derived log + a symbol map).
      var alerts = [];
      try {
        var la = await fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' }).then(function(r){ return r.json(); });
        if (la && la.s === 'ok' && Array.isArray(la.r)) alerts = la.r;
      } catch (e) {}
      var symById = {};
      alerts.forEach(function(a){ symById[a.alert_id] = unwrapSym(a.symbol); });

      out.derived = alerts
        .filter(function(a){ return a.last_fire_time != null; })
        .map(function(a){
          var t = a.last_fire_time;
          return {
            alert_id: a.alert_id,
            time: (t != null) ? t : null,
            time_iso: (t != null) ? new Date(t * 1000).toISOString() : null,
            symbol: unwrapSym(a.symbol),
            message: a.message || '',
            active: a.active,
          };
        })
        .sort(function(x, y){ return (y.time || 0) - (x.time || 0); });

      // Best-effort: the fired-events endpoint (full per-fire history).
      try {
        var resp = await fetch('https://pricealerts.tradingview.com/list_fires?limit=' + ${JSON.stringify(cap)}, { credentials: 'include' });
        var data = await resp.json();
        if (data && data.s === 'ok' && Array.isArray(data.r)) {
          out.fires = data.r.map(function(f){
            var sym = unwrapSym(f.symbol || symById[f.alert_id] || '');
            var t = (f.fire_time != null) ? f.fire_time : (f.time != null ? f.time : f.bar_time);
            return {
              fire_id: (f.fire_id != null) ? f.fire_id : null,
              alert_id: (f.alert_id != null) ? f.alert_id : null,
              time: (t != null) ? t : null,
              time_iso: (t != null) ? new Date(t * 1000).toISOString() : null,
              symbol: sym,
              message: f.desc || f.message || f.name || '',
            };
          });
        } else {
          out.error = (data && data.errmsg) || ('HTTP ' + resp.status);
        }
      } catch (e) { out.error = e.message; }

      return out;
    })()
  `);

  // The in-page code leaves fires === null when the feed genuinely failed and
  // sets it to an array (possibly empty) when it responded. An empty array is a
  // valid "zero fires" answer, so accept it here rather than falling through to
  // the derived log and falsely reporting the feed as unavailable.
  if (result && Array.isArray(result.fires)) {
    const fires = result.fires.slice(0, cap);
    return { success: true, source: 'internal_api_fires', fired_count: fires.length, fires };
  }
  const derived = (result && result.derived) || [];
  return {
    success: true,
    source: 'internal_api_list',
    note: 'Derived from list_alerts last-fire times (fired-events endpoint unavailable' + (result && result.error ? ': ' + result.error : '') + ').',
    fired_count: Math.min(derived.length, cap),
    fires: derived.slice(0, cap),
  };
}
