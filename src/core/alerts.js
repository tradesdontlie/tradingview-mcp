/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
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

// ---- pricealerts REST helpers ----------------------------------------------
// Endpoints validated live 2026-07-04 by capturing TradingView's own requests:
//   POST https://pricealerts.tradingview.com/create_alert?log_username=<user>
//     body: JSON.stringify({ payload: { conditions:[...], symbol, resolution,
//           message, sound_file, sound_duration, popup, auto_deactivate, email,
//           sms_over_email, mobile_push, web_hook, name, expiration, active,
//           ignore_warnings } })  — NO Content-Type header (avoids CORS preflight;
//           sync XHR and application/json both FAIL from page context).
//   POST .../delete_alerts  body: { payload: { alert_ids: [id, ...] } }
// The create response `r` is the POST-WRITE alert object — trust it over a
// follow-up list_alerts, which can serve stale values right after a write.
// NOTE: the create response reports active:false momentarily; the alert shows
// active:true in list_alerts within seconds (verified live) — not a failure.
// modify_restart_alert exists but its payload format is unproven; price changes
// are implemented as delete + recreate instead (alert_id changes by design).

function symbolSpec(symbol) {
  return '=' + JSON.stringify({ adjustment: 'splits', 'currency-id': 'USD', symbol: String(symbol).toUpperCase() });
}

async function restPost(path, payload) {
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/${path}?log_username='
        + encodeURIComponent((window.user && window.user.username) || ''), {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ payload: ${JSON.stringify(payload)} })
    })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { s: 'fetch_error', errmsg: e.message }; })
  `);
  return result;
}

/** Summarize an alert object WITHOUT echoing the full message — webhook alert
 *  messages carry a shared secret that must never appear in tool output. */
function summarize(raw) {
  if (!raw) return null;
  const cond = raw.condition || (raw.conditions && raw.conditions[0]) || {};
  const valueSeries = (cond.series || []).find(s => s.type === 'value');
  return {
    alert_id: raw.alert_id,
    symbol: raw.symbol,
    trigger_value: valueSeries ? valueSeries.value : null,
    frequency: cond.frequency,
    web_hook: raw.web_hook || null,
    once_only: !!raw.auto_deactivate,
    expiration: raw.expiration || 'open-ended',
    active: raw.active,
    message_length: raw.message ? String(raw.message).length : 0,
  };
}

/**
 * Create a price-crossing alert with a webhook in ONE call — no dialog.
 * message may be passed directly, or read from the system clipboard in page
 * context (message_from_clipboard) so secret-bearing payloads never transit
 * tool parameters.
 */
export async function createWebhook({ symbol, price, message, message_from_clipboard, webhook_url, once_only = true, popup = true }) {
  const value = Number(price);
  if (!Number.isFinite(value)) throw new Error(`price must be a finite number, got: ${price}`);
  if (!message && !message_from_clipboard) throw new Error('Provide message or set message_from_clipboard: true');

  let msg = message;
  if (message_from_clipboard) {
    // clipboard.readText() throws "Document is not focused" unless the
    // TradingView window is frontmost — bring it forward first
    try { const c = await getClient(); await c.Page.bringToFront(); } catch {}
    msg = await evaluateAsync(`navigator.clipboard.readText().catch(function(e) { return '__CLIP_ERR__' + e.message; })`);
    if (typeof msg !== 'string' || msg.startsWith('__CLIP_ERR__') || !msg.trim()) {
      throw new Error(`Clipboard read failed or empty: ${String(msg).replace('__CLIP_ERR__', '')}`);
    }
  }

  const payload = {
    conditions: [{
      type: 'cross',
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value }],
      resolution: '1',
    }],
    symbol: symbolSpec(symbol),
    resolution: '1',
    message: msg,
    sound_file: null,
    sound_duration: 0,
    popup: !!popup,
    auto_deactivate: !!once_only,
    email: false,
    sms_over_email: false,
    mobile_push: false,
    web_hook: webhook_url || null,
    name: null,
    expiration: null,
    active: true,
    ignore_warnings: true,
  };

  const resp = await restPost('create_alert', payload);
  if (resp?.s !== 'ok') {
    return { success: false, error: resp?.errmsg || 'create_alert returned an error', source: 'rest_api' };
  }
  return { success: true, source: 'rest_api', alert: summarize(resp.r) };
}

/** Change the trigger price of an existing alert: fetch raw → delete → recreate
 *  with the new value. Returns the NEW alert (alert_id changes by design). */
export async function modifyPrice({ alert_id, price }) {
  const value = Number(price);
  if (!Number.isFinite(value)) throw new Error(`price must be a finite number, got: ${price}`);

  const raw = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var a = (d.r || []).find(function(x) { return String(x.alert_id) === ${safeString(String(alert_id))}; });
        return a || null;
      })
      .catch(function(e) { return { __err: e.message }; })
  `);
  if (!raw) throw new Error(`Alert ${alert_id} not found`);
  if (raw.__err) throw new Error(`list_alerts failed: ${raw.__err}`);
  if (raw.type !== 'price') throw new Error(`Alert ${alert_id} is type '${raw.type}' — only price alerts supported`);

  const cond = raw.condition || (raw.conditions && raw.conditions[0]);
  const payload = {
    conditions: [{
      type: cond.type,
      frequency: cond.frequency,
      series: [{ type: 'barset' }, { type: 'value', value }],
      resolution: cond.resolution || raw.resolution || '1',
    }],
    symbol: raw.symbol,
    resolution: raw.resolution || '1',
    message: raw.message,
    sound_file: raw.sound_file || null,
    sound_duration: raw.sound_duration || 0,
    popup: !!raw.popup,
    auto_deactivate: !!raw.auto_deactivate,
    email: !!raw.email,
    sms_over_email: !!raw.sms_over_email,
    mobile_push: !!raw.mobile_push,
    web_hook: raw.web_hook || null,
    name: raw.name || null,
    expiration: raw.expiration || null,
    active: true,
    ignore_warnings: true,
  };

  const created = await restPost('create_alert', payload);
  if (created?.s !== 'ok') {
    return { success: false, error: `recreate failed (${created?.errmsg || 'error'}) — original alert ${alert_id} left untouched`, source: 'rest_api' };
  }
  const del = await restPost('delete_alerts', { alert_ids: [Number(alert_id)] });
  return {
    success: true,
    source: 'rest_api',
    old_alert_id: Number(alert_id),
    old_deleted: del?.s === 'ok',
    alert: summarize(created.r),
  };
}

/** Delete ONE alert by id (unlike deleteAlerts/delete_all which nukes everything). */
export async function deleteOne({ alert_id }) {
  const resp = await restPost('delete_alerts', { alert_ids: [Number(alert_id)] });
  if (resp?.s !== 'ok') {
    return { success: false, error: resp?.errmsg || 'delete_alerts returned an error', source: 'rest_api' };
  }
  const stillThere = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(d) { return (d.r || []).some(function(x) { return String(x.alert_id) === ${safeString(String(alert_id))}; }); })
      .catch(function() { return null; })
  `);
  return { success: true, source: 'rest_api', alert_id: Number(alert_id), verified_gone: stillThere === false };
}

export async function deleteAlerts({ delete_all }) {
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
