/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

/**
 * Map user-friendly condition names to TV's internal condition types.
 * TV uses these under the hood:
 *   cross       — triggers on any cross (up OR down)
 *   cross_up    — triggers only when price crosses upward through the level
 *   cross_down  — triggers only when price crosses downward through the level
 */
function normalizeCondition(condition) {
  if (!condition) return 'cross';
  const c = String(condition).toLowerCase().trim();
  if (c === 'cross' || c === 'crossing') return 'cross';
  if (c === 'greater_than' || c === 'above' || c === 'cross_above' || c === 'cross_up') return 'cross_up';
  if (c === 'less_than' || c === 'below' || c === 'cross_below' || c === 'cross_down') return 'cross_down';
  return 'cross'; // permissive fallback
}

export async function create({ condition, price, message }) {
  if (price == null || isNaN(Number(price))) {
    return { success: false, error: 'price is required and must be a number', source: 'rest_api' };
  }
  const numericPrice = Number(price);

  // Read the active chart's symbol directly from TV's internal API.
  // Falls back to whatever `chart_get_state` would return.
  const symbolInfo = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var model = chart.model();
        var sym = model.mainSeries().symbol();
        var info = model.mainSeries().symbolInfo ? model.mainSeries().symbolInfo() : null;
        return {
          symbol: sym,
          currency: (info && info.currency_code) || 'USD',
          resolution: model.mainSeries().properties().interval.value() || '1'
        };
      } catch(e) { return { error: e.message }; }
    })()
  `);

  if (!symbolInfo || symbolInfo.error || !symbolInfo.symbol) {
    return { success: false, error: 'Could not read active chart symbol: ' + (symbolInfo?.error || 'unknown'), source: 'rest_api' };
  }

  // TV's create_alert endpoint wants `symbol` as a custom marker string:
  //   "=" + JSON.stringify({ symbol, adjustment, currency-id })
  const symbolMarker = '=' + JSON.stringify({
    symbol: symbolInfo.symbol,
    adjustment: 'dividends',
    'currency-id': symbolInfo.currency
  });

  const defaultMessage = message || `${symbolInfo.symbol.split(':').pop()} ${condition ? String(condition).toLowerCase() : 'crossing'} ${numericPrice}`;
  const condType = normalizeCondition(condition);

  // Default expiration: 30 days from now, matches TV's UI default
  const expiration = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

  const payload = {
    symbol: symbolMarker,
    resolution: String(symbolInfo.resolution || '1'),
    message: defaultMessage,
    sound_file: null,
    sound_duration: 0,
    popup: true,
    expiration,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: null,
    conditions: [{
      type: condType,
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: numericPrice }],
      resolution: String(symbolInfo.resolution || '1')
    }],
    active: true,
    ignore_warnings: true
  };

  // Use evaluateAsync (awaits the fetch promise). NOTE: do NOT set Content-Type.
  // TV's own create_alert request has no Content-Type header, relying on the browser's
  // default for string bodies — a custom Content-Type triggers a CORS preflight that the
  // server rejects, which was the root cause of the DOM-fallback era failures.
  const body = JSON.stringify({ payload });
  const escapedBody = body.replace(/[\\`$]/g, '\\$&');
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: \`${escapedBody}\`
    }).then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (!response || response.error) {
    return { success: false, error: response?.error || 'no response', source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch (e) { /* not JSON */ }

  if (parsed?.s === 'ok' && parsed?.r) {
    const created = parsed.r;
    return {
      success: true,
      alert_id: created.alert_id || null,
      symbol: symbolInfo.symbol,
      price: numericPrice,
      condition: condType,
      message: defaultMessage,
      expiration: created.expiration || expiration,
      source: 'rest_api'
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || response.body?.substring(0, 200) || 'unknown',
    http_status: response.status,
    source: 'rest_api'
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

/**
 * Delete one or more alerts via TV's internal REST API
 *   POST https://pricealerts.tradingview.com/delete_alerts
 *   Body: {"payload":{"alert_ids":[id1, id2, ...]}}
 *   Headers: none (custom Content-Type triggers CORS preflight; send as plain string body)
 *
 * Accepts:
 *   - { alert_id: 12345 }       — delete a single alert
 *   - { alert_ids: [1, 2, 3] }  — delete multiple in one call (TV supports bulk natively)
 *   - { delete_all: true }      — list() first, then delete every id
 */
export async function deleteAlerts({ alert_id, alert_ids, delete_all } = {}) {
  let ids = [];

  if (delete_all) {
    const listed = await list();
    ids = (listed?.alerts || []).map(a => a.alert_id).filter(x => x != null);
    if (ids.length === 0) {
      return { success: true, deleted_count: 0, note: 'No alerts to delete', source: 'rest_api' };
    }
  } else if (Array.isArray(alert_ids) && alert_ids.length > 0) {
    ids = alert_ids.map(Number).filter(x => !isNaN(x));
  } else if (alert_id != null) {
    const n = Number(alert_id);
    if (isNaN(n)) throw new Error('alert_id must be a number');
    ids = [n];
  } else {
    throw new Error('Pass one of: alert_id (number), alert_ids (array), or delete_all: true');
  }

  const body = JSON.stringify({ payload: { alert_ids: ids } });
  const escapedBody = body.replace(/[\\`$]/g, '\\$&');
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      body: \`${escapedBody}\`
    }).then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (!response || response.error) {
    return { success: false, error: response?.error || 'no response', attempted_ids: ids, source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch(e) { /* not JSON */ }

  if (parsed?.s === 'ok') {
    return {
      success: true,
      deleted_count: ids.length,
      deleted_ids: ids,
      source: 'rest_api'
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || (response.body ? String(response.body).substring(0, 200) : 'unknown'),
    http_status: response.status,
    attempted_ids: ids,
    source: 'rest_api'
  };
}
