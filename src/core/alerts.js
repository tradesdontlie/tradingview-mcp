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

const INDICATOR_DEFAULT_EXPIRATION_DAYS = 30;
const INDICATOR_MAX_EXPIRATION_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Create an *indicator* alert that fires on a Pine `alertcondition()` signal.
 *
 * Companion to `create()` — where `create()` produces a price-level alert via
 * the TV alert dialog, this posts directly to TV's REST endpoint with an
 * `alert_cond` condition referencing a saved Pine script's plot index. The
 * intended use is automating strategy-style Pine alerts (BUY/SELL signals
 * piped to a webhook URL) without clicking through the UI for each one.
 *
 * Required arguments (caller must look these up from a saved Pine script):
 *   - pine_id        — e.g. "USER;abc123..." (from `pine_list_scripts`)
 *   - alert_cond_id  — e.g. "plot_12" (Pine plot index of the alertcondition)
 *   - inputs         — input map matching the script's `input.X(...)` order:
 *                      { in_0: ..., in_1: ..., __profile: false, pineFeatures: '...' }
 *   - offsets_by_plot — { plot_0: 0, ..., plot_N-1: 0 } where N = the
 *                       alert_cond_id index
 *
 * Optional:
 *   - pine_version    — saved script version (default "1.0")
 *   - symbol          — TV symbol like "OANDA:USDJPY". Defaults to active chart.
 *   - currency        — currency-id for the symbol marker. Defaults to active chart.
 *   - resolution      — TF like "60", "240", "D". Defaults to active chart.
 *   - message         — alert payload. Supports {{ticker}}, {{close}} placeholders.
 *   - web_hook        — webhook URL TV will POST the message to on fire.
 *   - frequency       — "on_bar_close" (default), "once_per_bar", or "all".
 *   - expiration_days — defaults to 30, capped at 60.
 *   - active          — defaults to true.
 *
 * Determining `alert_cond_id` (gotcha): TV counts Pine plot-emitting calls in
 * source order — `plot()`, `plotshape()`, `bgcolor()`, AND `alertcondition()`.
 * `hline()` is NOT counted. So a script with 10 `plot()` + 2 `plotshape()` +
 * 2 `alertcondition()` (BUY then SELL) yields BUY = `plot_12`, SELL = `plot_13`.
 * Easiest discovery: create one alert manually in the TV UI, then call
 * `alert_list` and read the resulting `alert_cond_id` plus the `inputs` /
 * `offsets_by_plot` shape from the response.
 *
 * CORS note: do NOT add a Content-Type header on the fetch — a custom
 * Content-Type triggers a preflight OPTIONS that pricealerts.tradingview.com
 * rejects. The server happily parses the body without an explicit Content-Type.
 */
export async function createIndicator({
  pine_id,
  pine_version,
  alert_cond_id,
  inputs,
  offsets_by_plot,
  symbol,
  currency,
  resolution,
  message,
  web_hook,
  frequency,
  expiration_days,
  active,
} = {}) {
  if (!pine_id || typeof pine_id !== 'string') {
    return { success: false, error: 'pine_id is required (e.g. "USER;abc123..." from pine_list_scripts)', source: 'rest_api' };
  }
  if (!alert_cond_id || typeof alert_cond_id !== 'string') {
    return { success: false, error: 'alert_cond_id is required (e.g. "plot_12")', source: 'rest_api' };
  }
  if (!inputs || typeof inputs !== 'object') {
    return { success: false, error: 'inputs is required (object matching the script\'s input.X order)', source: 'rest_api' };
  }
  if (!offsets_by_plot || typeof offsets_by_plot !== 'object') {
    return { success: false, error: 'offsets_by_plot is required (e.g. { plot_0: 0, plot_1: 0, ... })', source: 'rest_api' };
  }

  // Resolve symbol / currency / resolution from active chart if not provided.
  let resolvedSymbol = symbol;
  let resolvedCurrency = currency;
  let resolvedResolution = resolution;

  if (!resolvedSymbol || !resolvedCurrency || !resolvedResolution) {
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
      return { success: false, error: 'Could not read active chart symbol: ' + (symbolInfo?.error || 'unknown') + ' — pass symbol/currency/resolution explicitly', source: 'rest_api' };
    }
    resolvedSymbol = resolvedSymbol || symbolInfo.symbol;
    resolvedCurrency = resolvedCurrency || symbolInfo.currency;
    resolvedResolution = resolvedResolution || String(symbolInfo.resolution || '1');
  }

  const symbolMarker = '=' + JSON.stringify({
    symbol: resolvedSymbol,
    adjustment: 'dividends',
    'currency-id': resolvedCurrency,
  });

  const days = Number.isFinite(Number(expiration_days)) && Number(expiration_days) > 0
    ? Math.min(Math.floor(Number(expiration_days)), INDICATOR_MAX_EXPIRATION_DAYS)
    : INDICATOR_DEFAULT_EXPIRATION_DAYS;
  const expiration = new Date(Date.now() + days * MS_PER_DAY).toISOString();

  const payload = {
    symbol: symbolMarker,
    resolution: String(resolvedResolution),
    message: message || '',
    sound_file: null,
    sound_duration: 0,
    popup: false,
    expiration,
    auto_deactivate: false,
    email: false,
    sms_over_email: false,
    mobile_push: false,
    web_hook: web_hook || null,
    name: null,
    conditions: [{
      type: 'alert_cond',
      frequency: frequency || 'on_bar_close',
      alert_cond_id,
      series: [{
        type: 'study',
        study: 'Script@tv-scripting-101',
        offsets_by_plot,
        inputs,
        pine_id,
        pine_version: pine_version || '1.0',
      }],
      resolution: String(resolvedResolution),
    }],
    active: active !== false,
    ignore_warnings: true,
  };

  // CORS-critical: do NOT set a Content-Type header. A custom Content-Type
  // triggers a preflight OPTIONS that pricealerts.tradingview.com rejects.
  // The server happily parses the body without an explicit Content-Type.
  // Embedding the body as a JSON string literal (via JSON.stringify) is the
  // simplest safe way to inject it into the evaluateAsync template.
  const body = JSON.stringify({ payload });
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(body)}
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
      symbol: resolvedSymbol,
      pine_id,
      alert_cond_id,
      resolution: String(resolvedResolution),
      message: payload.message,
      web_hook: payload.web_hook,
      expiration: created.expiration || expiration,
      source: 'rest_api',
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || (response.body ? String(response.body).substring(0, 200) : 'unknown'),
    http_status: response.status,
    hint: 'Common cause: alert_cond_id off-by-one (try plot_N+/-1) or inputs schema mismatch. Create one alert manually in the TV UI and call alert_list to compare.',
    source: 'rest_api',
  };
}
