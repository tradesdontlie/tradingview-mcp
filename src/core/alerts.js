/**
 * Core alert logic.
 *
 * create(), list(), and deleteAlerts() all hit TradingView's internal
 * pricealerts.tradingview.com REST API — the same backend the desktop UI uses.
 * Endpoint shapes were reverse-engineered by hooking window.fetch in the page
 * context and triggering the native dialog / list / delete flows. The
 * DOM-fallback path that earlier shipped here never matched the real alert
 * dialog's selectors and silently no-op'd.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const CREATE_URL = 'https://pricealerts.tradingview.com/create_alert';
const LIST_URL = 'https://pricealerts.tradingview.com/list_alerts';
const DELETE_URL = 'https://pricealerts.tradingview.com/delete_alerts';
const MAX_EXPIRATION_DAYS = 60; // TradingView's hard cap; requests beyond this are rejected.

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

/**
 * Build the alert payload shape the pricealerts service expects. Shape was
 * reverse-engineered by hooking fetch in the page context and triggering the
 * native Create-alert dialog. Three non-obvious bits:
 *   - The whole thing is wrapped in { payload: { ... } }.
 *   - `conditions` is plural and an array, even for a single condition.
 *   - The `symbol` field is "=" + JSON.stringify({adjustment, currency-id,
 *     session, symbol}). A plain "BATS:RDDT" is rejected with invalid_request.
 */
export function buildPayload({ symbol, price, message, resolution, frequency, expirationDays }) {
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

async function _readChartContext(evaluate) {
  const state = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        return { symbol: chart.symbol(), resolution: chart.resolution() };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (state?.error || !state?.symbol) {
    throw new Error('Cannot read current chart symbol/resolution: ' + (state?.error || 'unknown'));
  }
  return state;
}

/**
 * The pricealerts endpoint must receive the body as a plain string with NO
 * Content-Type header. Setting application/json triggers a CORS preflight that
 * the service rejects ("Failed to fetch"). Treating the body as text/plain
 * keeps it a "simple request" and skips preflight entirely.
 */
function _fetchNoPreflight(url, bodyJson) {
  return `
    fetch(${safeString(url)}, {
      method: 'POST',
      credentials: 'include',
      body: ${safeString(bodyJson)}
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `;
}

function _parseRestResponse(result) {
  if (result?.error) return { ok: false, error: result.error, parsed: null };
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch {}
  return {
    ok: parsed?.s === 'ok',
    error: parsed?.s === 'ok' ? null : (parsed?.errmsg || result.body?.slice(0, 200) || 'unknown'),
    err_code: parsed?.err?.code || null,
    parsed,
  };
}

export async function create({ condition, price, message, symbol, resolution, frequency, expiration_days, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);

  const priceNum = requireFinite(price, 'price');
  let expDays = expiration_days != null ? requireFinite(expiration_days, 'expiration_days') : 30;
  if (expDays > MAX_EXPIRATION_DAYS) expDays = MAX_EXPIRATION_DAYS;
  if (expDays < 1) expDays = 1;
  const freq = frequency || 'on_first_fire';

  let sym = symbol;
  let res = resolution;
  if (!sym || !res) {
    const state = await _readChartContext(evaluate);
    sym = sym || state.symbol;
    res = res || state.resolution || '1';
  }

  // `condition` is accepted for backwards compat but the underlying API uses
  // type:cross + cross_interval which fires on any crossing in either direction.
  void condition;

  const payload = buildPayload({ symbol: sym, price: priceNum, message, resolution: res, frequency: freq, expirationDays: expDays });
  const result = await evaluateAsync(_fetchNoPreflight(CREATE_URL, JSON.stringify(payload)));
  const { ok, error, err_code, parsed } = _parseRestResponse(result);

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
    error,
    err_code,
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

/**
 * Bulk delete via POST /delete_alerts with { payload: { alert_ids: [...] } }.
 * The service tolerates unknown ids in the array (still returns s:ok) — verify
 * via list() if you need confirmation that a specific id was actually present.
 *
 * delete_all: true → call list() first, then bulk delete every returned id.
 */
export async function deleteAlerts({ alert_id, alert_ids, delete_all, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);

  let ids = [];
  if (Array.isArray(alert_ids)) ids = alert_ids.slice();
  if (alert_id != null) ids.push(alert_id);

  if (delete_all) {
    const listed = await list({ _deps });
    ids = (listed.alerts || []).map(a => a.alert_id);
    if (ids.length === 0) {
      return { success: true, source: 'internal_api', deleted_count: 0, requested_ids: [], note: 'No alerts to delete.' };
    }
  }

  if (ids.length === 0) {
    throw new Error('deleteAlerts requires alert_id, alert_ids, or delete_all=true');
  }

  const normalized = ids.map(id => {
    const n = Number(id);
    if (!Number.isFinite(n)) throw new Error(`alert_id must be a finite number, got: ${id}`);
    return n;
  });

  const body = JSON.stringify({ payload: { alert_ids: normalized } });
  const result = await evaluateAsync(_fetchNoPreflight(DELETE_URL, body));
  const { ok, error, err_code, parsed } = _parseRestResponse(result);

  return {
    success: ok,
    source: 'internal_api',
    deleted_count: ok ? normalized.length : 0,
    requested_ids: normalized,
    raw: parsed,
    error,
    err_code,
  };
}
