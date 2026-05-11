/**
 * Core alert logic.
 *
 * create: uses TradingView's internal REST API at pricealerts.tradingview.com/create_alert
 *   (auth via session cookies, same domain used by list_alerts).
 *   Payload structure was reverse-engineered by intercepting the UI's network calls.
 */
import { evaluate, evaluateAsync } from '../connection.js';

const CONDITION_TYPES = {
  // crossing — fires when price touches the level from either direction
  crossing: 'cross',
  cross: 'cross',
  // greater_than / less_than — TV doesn't expose explicit one-sided types via UI,
  // but "cross" fires the first time the threshold is crossed, which is what users want for SL/TP.
  // The direction is implied by current price vs target.
  greater_than: 'cross',
  less_than: 'cross',
  above: 'cross',
  below: 'cross',
};

function defaultExpiration() {
  // 60 days from now (TV UI default is ~30 days, we give more)
  const d = new Date();
  d.setDate(d.getDate() + 60);
  return d.toISOString();
}

export async function create({ condition, price, message, symbol, resolution, expiration }) {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error('price must be a finite number');
  }
  const tvType = CONDITION_TYPES[condition] || 'cross';

  // Resolve current chart symbol/resolution if not fully provided
  let finalSymbol = symbol;
  let finalResolution = resolution;
  if (!finalSymbol || !finalResolution) {
    const chartInfo = await evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
            && window.TradingViewApi._activeChartWidgetWV.value();
          if (!chart) return { error: 'no active chart' };
          var ms = chart._chartWidget.model().mainSeries();
          var sym = (typeof ms.symbol === 'function') ? ms.symbol() : null;
          var res = (typeof ms.interval === 'function') ? ms.interval() : null;
          return { symbol: sym, resolution: res };
        } catch(e) { return { error: e.message }; }
      })()
    `);
    if (chartInfo?.error && !finalSymbol) throw new Error('Could not resolve chart symbol: ' + chartInfo.error);
    finalSymbol = finalSymbol || chartInfo.symbol;
    finalResolution = finalResolution || chartInfo.resolution || '1';
  }
  if (!finalSymbol) throw new Error('No symbol available (chart inactive or invalid)');

  // TV serializes symbol as `={"symbol":"X"}` in alerts (currency-id optional)
  const symbolPayload = '=' + JSON.stringify({ symbol: finalSymbol });

  const defaultMsg = `${finalSymbol} cross ${price}`;
  const payloadBody = {
    payload: {
      symbol: symbolPayload,
      resolution: String(finalResolution),
      message: message || defaultMsg,
      sound_file: null,
      sound_duration: 0,
      popup: true,
      expiration: expiration || defaultExpiration(),
      auto_deactivate: true,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: null,
      conditions: [
        {
          type: tvType,
          frequency: 'on_first_fire',
          series: [
            { type: 'barset' },
            { type: 'value', value: Number(price) },
          ],
          resolution: String(finalResolution),
        },
      ],
      active: true,
      ignore_warnings: true,
    },
  };

  // Use page fetch so it inherits session cookies and auth.
  // IMPORTANT: do NOT set Content-Type — TV's UI doesn't either, and setting it triggers
  // CORS preflight which the pricealerts.tradingview.com endpoint rejects.
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(JSON.stringify(payloadBody))},
    })
      .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (result?.error) throw new Error('Network error: ' + result.error);
  if (result?.status >= 400 || result?.body?.s === 'error') {
    return {
      success: false,
      http_status: result?.status,
      error: result?.body?.errmsg || result?.body?.error || `HTTP ${result?.status}`,
      raw: result?.body,
    };
  }

  return {
    success: true,
    alert_id: result?.body?.r?.alert_id || result?.body?.alert_id,
    symbol: finalSymbol,
    price,
    condition: tvType,
    message: payloadBody.payload.message,
    resolution: finalResolution,
    expiration: payloadBody.payload.expiration,
    source: 'rest_api',
  };
}

export async function list() {
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

async function _deleteByIds(ids) {
  const body = JSON.stringify({ payload: { alert_ids: ids.map(Number) } });
  // No Content-Type header — TV UI doesn't set one, and setting it triggers CORS preflight.
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(body)},
    })
      .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);
  if (result?.error) throw new Error('Network error: ' + result.error);
  if (result?.body?.s === 'error') {
    return { success: false, http_status: result?.status, error: result?.body?.errmsg || 'unknown', raw: result?.body };
  }
  return { success: true, http_status: result?.status, raw: result?.body };
}

export async function deleteAlerts({ delete_all, alert_id }) {
  if (alert_id !== undefined && alert_id !== null && alert_id !== '') {
    const r = await _deleteByIds([alert_id]);
    return { ...r, alert_id, source: 'rest_api' };
  }
  if (delete_all) {
    const listed = await list();
    const ids = (listed.alerts || []).map(a => a.alert_id).filter(Boolean);
    if (ids.length === 0) return { success: true, deleted_count: 0, total: 0, note: 'no alerts to delete', source: 'rest_api' };
    const r = await _deleteByIds(ids);
    return { ...r, deleted_count: r.success ? ids.length : 0, total: ids.length, ids, source: 'rest_api' };
  }
  throw new Error('Must provide either alert_id or delete_all: true.');
}
