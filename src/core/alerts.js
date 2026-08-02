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

/**
 * T31 — Alert message / condition price-parity validator.
 *
 * If an alert `message` cites one or more prices (as $-prefixed tokens), at
 * least one must match the alert's `condition.value` within 0.5% — otherwise
 * the alert is a schema-drift bug: the user reads the message on their phone
 * assuming one level, but the actual trigger is something else. Two such
 * drifts were observed on 2026-04-22 / 23 (TSCO alert 4532985422 msg "$43.20"
 * / cross_up 54.80; RKLB 4535762585 msg "$78.60" / cross_down 84.61).
 *
 * Rules:
 *   - Message with no $-prefixed numeric tokens → pass (not every alert cites
 *     a price, e.g., "AMZN bull setup firing").
 *   - Any cited price within 0.5% of numericPrice → pass. Other numbers
 *     (SL / T1 / T2 context) may differ from condition.value without failing.
 *   - Otherwise → refuse with cited-prices list + actual condition value.
 *
 * Tolerance 0.5% allows cosmetic rounding ($390 vs $390.01) without masking
 * real drift ($43.20 vs 54.80 = 27% gap, far beyond tolerance).
 */
function validateMessageConditionParity(message, numericPrice) {
  if (!message || typeof message !== 'string') return { ok: true };
  if (!isFinite(numericPrice) || numericPrice <= 0) return { ok: true };
  const matches = [...message.matchAll(/\$(\d+(?:\.\d+)?)/g)];
  if (matches.length === 0) return { ok: true };
  const tolerance = 0.005;
  const cited = matches.map(m => Number(m[1])).filter(n => isFinite(n) && n > 0);
  if (cited.length === 0) return { ok: true };
  const match = cited.find(p => Math.abs(p - numericPrice) / numericPrice <= tolerance);
  if (match !== undefined) return { ok: true };
  return {
    ok: false,
    reason: `message cites [${cited.map(p => '$' + p).join(', ')}], none within 0.5% of condition.value $${numericPrice}`,
    cited,
    condition_value: numericPrice,
  };
}

/** Bare ticker from `EXCHANGE:TICKER`. Venue-insensitive comparison helper. */
export function bareSymbol(sym) {
  return String(sym || '').trim().toUpperCase().split(':').pop();
}

/** Parse TV's `symbol` marker (`={"symbol":"BATS:SW",...}`) back to a symbol string. */
export function symbolFromMarker(marker) {
  try { return JSON.parse(String(marker).replace(/^=/, '')).symbol || null; }
  catch { return null; }
}

/**
 * Best-effort currency lookup for a symbol we are NOT charting.
 *
 * Measured 2026-08-02 while building this: a bare ticker is genuinely ambiguous
 * across venues — `SW` resolves to NYSE/USD, EURONEXT/EUR and BX/CHF, and TWO of
 * those carry `is_primary_listing: true`. So an exchange-qualified request is
 * matched on its venue; a bare one only resolves when the primary listing is
 * unique. Returns null rather than guessing.
 *
 * NOTE `BATS` (TV's consolidated US feed, and what every chart symbol here uses)
 * is NOT in symbol-search at all — measured, 0 results for `BATS:MSFT`. That is
 * fine: the caller falls back to the chart currency and REPORTS having done so.
 */
async function lookupCurrency(symbol) {
  const bare = bareSymbol(symbol);
  const venue = String(symbol || '').includes(':')
    ? String(symbol).trim().toUpperCase().split(':')[0] : null;
  if (!bare) return null;
  try {
    const params = new URLSearchParams({
      text: bare, hl: '0', exchange: '', lang: 'en', search_type: '', domain: 'production',
    });
    const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
      headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.symbols) ? data.symbols : []);
    const strip = s => (s || '').replace(/<\/?em>/g, '').toUpperCase();
    const exact = arr.filter(r => strip(r.symbol) === bare);
    if (!exact.length) return null;
    if (venue) {
      const hit = exact.find(r => String(r.prefix || r.exchange).toUpperCase() === venue);
      return hit?.currency_code || null;
    }
    const primary = exact.filter(r => r.is_primary_listing === true);
    return primary.length === 1 ? (primary[0].currency_code || null) : null;
  } catch { return null; }
}

export async function create({ condition, price, message, symbol }) {
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

  // ── Target symbol resolution (T195) ────────────────────────────────────────
  // Before this, `create` ALWAYS armed on the active chart symbol and there was
  // no `symbol` parameter at all — a caller passing one had it dropped by the
  // MCP layer. That bit twice in field use (2026-07-30 an O alert armed on CDE
  // at a price CDE can never reach; 2026-07-31 two alerts armed on the leftover
  // TJX chart). It is the worst kind of failure: the alert reports success,
  // lists correctly, and simply never fires.
  //
  // MEASURED 2026-08-02, and it refutes the "arms on whatever the chart shows"
  // framing: the endpoint was NEVER tied to the chart. Requesting `NYSE:SW`
  // while charting `BATS:MSFT` returned `s:ok` and armed on **BATS:SW** — the
  // correct instrument, with TV normalizing the venue to its consolidated US
  // feed server-side. The chart coupling was entirely self-inflicted: this
  // function read the chart symbol and put it in the payload.
  const requested = symbol ? String(symbol).trim() : null;
  const sameAsChart = requested && bareSymbol(requested) === bareSymbol(symbolInfo.symbol);
  const targetSymbol = (!requested || sameAsChart) ? symbolInfo.symbol : requested;

  // Currency only needs resolving when we're arming off-chart. TV normalizes the
  // venue anyway, so this is belt-and-braces for non-USD instruments — and when
  // it can't be resolved we fall back to the chart's and SAY SO rather than
  // silently assuming USD.
  let currency = symbolInfo.currency;
  let currencySource = 'active_chart';
  if (requested && !sameAsChart) {
    const looked = await lookupCurrency(targetSymbol);
    if (looked) { currency = looked; currencySource = 'symbol_search'; }
    else { currencySource = 'active_chart_fallback'; }
  }

  // TV's create_alert endpoint wants `symbol` as a custom marker string:
  //   "=" + JSON.stringify({ symbol, adjustment, currency-id })
  const symbolMarker = '=' + JSON.stringify({
    symbol: targetSymbol,
    adjustment: 'dividends',
    'currency-id': currency
  });

  const defaultMessage = message || `${targetSymbol.split(':').pop()} ${condition ? String(condition).toLowerCase() : 'crossing'} ${numericPrice}`;
  const condType = normalizeCondition(condition);

  // T31 — refuse the create if the message cites a price that disagrees with the condition value.
  // Prevents the "phone alert says $X, actual trigger is $Y" drift (observed twice in field use).
  const parity = validateMessageConditionParity(defaultMessage, numericPrice);
  if (!parity.ok) {
    return {
      success: false,
      error: 'message-condition price mismatch — ' + parity.reason,
      cited_prices: parity.cited,
      condition_value: parity.condition_value,
      hint: 'Align the price in the `message` field to match the `price` arg, or remove price tokens from the message.',
      source: 'rest_api_prechecked',
    };
  }

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
    const alertId = created.alert_id || null;

    // T195 — report what TV ACTUALLY armed, read back from its own response
    // marker, not what we asked for. The old code returned `symbolInfo.symbol`
    // (the chart's) unconditionally, which is why a mis-targeted alert looked
    // perfectly correct in the response. TV echoes the normalized marker in
    // `r.symbol`; that is the authoritative answer and it costs nothing.
    const armedSymbol = symbolFromMarker(created.symbol) || targetSymbol;

    // A venue rewrite is expected and fine (NYSE:SW -> BATS:SW). A different
    // INSTRUMENT is the failure this task exists to kill, so don't leave it
    // armed — roll it back and fail loudly rather than return a success the
    // caller has no way to distinguish from a real one.
    if (bareSymbol(armedSymbol) !== bareSymbol(targetSymbol)) {
      let rolledBack = false;
      if (alertId != null) {
        try { rolledBack = !!(await deleteAlerts({ alert_id: alertId }))?.success; }
        catch { rolledBack = false; }
      }
      return {
        success: false,
        error: `alert armed on ${armedSymbol} but ${targetSymbol} was requested — mis-targeted alert `
             + (rolledBack ? 'was deleted.' : 'could NOT be deleted; remove it manually.'),
        requested_symbol: targetSymbol,
        armed_symbol: armedSymbol,
        alert_id: alertId,
        rolled_back: rolledBack,
        source: 'rest_api',
      };
    }

    return {
      success: true,
      alert_id: alertId,
      symbol: armedSymbol,
      requested_symbol: requested || symbolInfo.symbol,
      chart_symbol: symbolInfo.symbol,
      symbol_source: (!requested || sameAsChart) ? 'active_chart' : 'requested',
      currency_source: currencySource,
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
