/**
 * Core alert logic.
 *
 * TradingView Desktop's "Create alert" dialog (current versions, post-2025) is
 * a single popup whose body is one form, but several rows act as buttons that
 * navigate the dialog into a sub-view (e.g. Message, Notifications,
 * Expiration). A sub-view shows a localised editor plus "Back / Cancel /
 * Apply" buttons; clicking Apply returns to the main view (with Cancel /
 * Create buttons).
 *
 * The walker therefore:
 *   1. Opens the dialog (aria-label is lowercase "Create alert").
 *   2. Sets the trigger price on the main view's single text <input>.
 *   3. For each sub-view it needs to touch (Notifications for webhook URL,
 *      Message for the alert body, Expiration for expiry):
 *        a. Click the corresponding row.
 *        b. Wait for the sub-view to render.
 *        c. Apply edits.
 *        d. Click "Apply" to return to the main view.
 *   4. Clicks "Create" on the main view.
 *
 * The `condition` argument is best-effort: TV's modern dialog renders the
 * condition operator as an inline dropdown in a portal, which is brittle to
 * automate. If we can't find the menu item, we surface that in the response
 * but still create the alert (TV's default of "Crossing" is what most
 * threshold alerts want anyway).
 *
 * Deletion has two paths:
 *   - delete_all: opens the alerts side panel + contextmenu (still needs a
 *     manual confirm — TV has no scriptable bulk delete).
 *   - name / alert_id: looks up matching alerts via the pricealerts REST API
 *     and calls remove_alert?alert_id=… for each.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const NATIVE_INPUT_SETTER = `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`;
const NATIVE_TEXTAREA_SETTER = `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set`;
const DIALOG_SELECTOR = `[class*="dialog-"][class*="popup-"]`;

function canonicalCondition(condition) {
  if (!condition) return null;
  const c = String(condition).toLowerCase().trim();
  if (c === 'crossing' || c === 'cross') return 'Crossing';
  if (c === 'crossing_up' || c === 'crossing up' || c === 'cross_up') return 'Crossing Up';
  if (c === 'crossing_down' || c === 'crossing down' || c === 'cross_down') return 'Crossing Down';
  if (c === 'greater_than' || c === 'greater than' || c === '>' || c === 'gt') return 'Greater Than';
  if (c === 'less_than' || c === 'less than' || c === '<' || c === 'lt') return 'Less Than';
  if (c === 'entering channel' || c === 'entering_channel') return 'Entering Channel';
  if (c === 'exiting channel' || c === 'exiting_channel') return 'Exiting Channel';
  return condition;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickButtonInDialogByText(predicate) {
  return evaluate(`
    (function() {
      var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
      if (!dialog) return false;
      var btns = dialog.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        if (${predicate}) { btns[i].click(); return t; }
      }
      return false;
    })()
  `);
}

async function applySubView() {
  // Click the "Apply" button in the current sub-view to commit edits and
  // return to the main view. Falls back to "Back" if Apply is missing.
  const clicked = await clickButtonInDialogByText(`t === 'Apply'`);
  if (clicked) return clicked;
  return clickButtonInDialogByText(`t === 'Back'`);
}

export async function create({ condition, price, message, webhook_url, expiration_minutes }) {
  // 0. Preflight — if a leftover alert dialog is open from a previous run, drop
  //    out of any sub-view and close it before we open a fresh one. Sub-view
  //    Cancel returns to the main view; the second Cancel actually closes.
  for (let pass = 0; pass < 3; pass++) {
    const stillOpen = await evaluate(`!!document.querySelector(${safeString(DIALOG_SELECTOR)})`);
    if (!stillOpen) break;
    await evaluate(`
      (function() {
        var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
        if (!dialog) return;
        var btns = dialog.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (/^Cancel$/i.test((btns[i].textContent || '').trim())) { btns[i].click(); return; }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      })()
    `);
    await sleep(400);
  }

  // 1. Open the Create Alert dialog. Real aria-label is lowercase "Create alert".
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('button[aria-label="Create alert"]')
        || document.querySelector('[aria-label="Create alert"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    // Fallback: Alt+A keyboard shortcut.
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await sleep(1200);

  // Note: the trigger price is set in step 7, AFTER all sub-view navigation.
  // Empirically, opening any sub-view (Notifications / Message / Expiration)
  // and clicking Apply re-renders the main view, which re-binds the price
  // input to TV's "current price" default and discards any value we wrote
  // earlier. Setting price last is the only reliable order.

  // 3. Condition — best-effort. The condition operator is an inline dropdown
  //    in a portal; clicking the row opens a popover with options like
  //    Crossing / Crossing Up / Greater Than / etc. We try to match the
  //    requested option but don't fail the create if we can't.
  let conditionSet = false;
  let conditionApplied = canonicalCondition(condition);
  if (conditionApplied) {
    const conditionRowOpened = await clickButtonInDialogByText(
      `(t === 'Crossing' || t === 'Crossing Up' || t === 'Crossing Down' || t === 'Greater Than' || t === 'Less Than' || t === 'Entering Channel' || t === 'Exiting Channel' || t === 'Moving Up' || t === 'Moving Down')`
    );
    if (conditionRowOpened) {
      await sleep(400);
      conditionSet = await evaluate(`
        (function() {
          var want = ${safeString(conditionApplied)};
          var items = document.querySelectorAll('[role="menuitem"], [class*="menuItem"], [class*="item-"][role], [class*="dropdownItem"], li, [class*="option"]');
          for (var i = 0; i < items.length; i++) {
            var t = (items[i].textContent || '').trim();
            if (t.length < 30 && t.toLowerCase() === want.toLowerCase()) { items[i].click(); return true; }
          }
          // Dismiss any open popover before continuing
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          return false;
        })()
      `);
      await sleep(300);
    }
  }

  // 4. Webhook — open Notifications sub-view, toggle Webhook URL on, fill URL,
  //    then click Apply to return to main view.
  let webhookConfigured = false;
  if (webhook_url) {
    const notifOpened = await clickButtonInDialogByText(
      `(/Webhook|Toast|Email/i.test(t) && /,/.test(t) && t.length < 80)`
    ) || await clickButtonInDialogByText(`(/Webhook/i.test(t) && t.length < 80)`);

    if (notifOpened) {
      await sleep(700);
      const setResult = await evaluate(`
        (function() {
          var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
          if (!dialog) return { toggled: false, filled: false, reason: 'dialog gone' };
          var toggled = false;
          var filled = false;
          var checks = dialog.querySelectorAll('input[type="checkbox"]');
          for (var i = 0; i < checks.length; i++) {
            var row = checks[i].closest('[class*="row"], [class*="Row"], [class*="item"], label, [class*="field"]');
            var rowText = row ? (row.textContent || '').trim() : '';
            if (/^Webhook URL/i.test(rowText)) {
              if (!checks[i].checked) checks[i].click();
              toggled = true;
              break;
            }
          }
          var inputs = dialog.querySelectorAll('input[type="text"], input[type="url"]');
          for (var k = 0; k < inputs.length; k++) {
            var inp = inputs[k];
            if (inp.placeholder && /example\\.com\\/alert-hook/i.test(inp.placeholder)) {
              var nativeSet = ${NATIVE_INPUT_SETTER};
              nativeSet.call(inp, ${safeString(webhook_url)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.dispatchEvent(new Event('blur', { bubbles: true }));
              filled = true;
              break;
            }
          }
          return { toggled: toggled, filled: filled };
        })()
      `);
      webhookConfigured = !!(setResult && setResult.toggled && setResult.filled);
      await applySubView();
      await sleep(500);
    }
  }

  // 5. Message — Message sub-view has the textarea showing the auto-generated
  //    string. Open it, replace, Apply, return.
  let messageSet = false;
  if (message) {
    const msgRowOpened = await clickButtonInDialogByText(
      `(t.length < 70 && t.length > 5 && (/Crossing|Greater Than|Less Than|Entering|Exiting|Moving Up|Moving Down/i.test(t)) && !/^Crossing$|^Crossing Up$|^Crossing Down$|^Greater Than$|^Less Than$|^Entering Channel$|^Exiting Channel$/.test(t))`
    );
    if (msgRowOpened) {
      await sleep(500);
      messageSet = await evaluate(`
        (function() {
          var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
          if (!dialog) return false;
          var textarea = dialog.querySelector('textarea');
          if (!textarea) return false;
          var nativeSet = ${NATIVE_TEXTAREA_SETTER};
          nativeSet.call(textarea, ${safeString(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          textarea.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        })()
      `);
      await applySubView();
      await sleep(500);
    }
  }

  // 6. Expiration — date+time pickers live in an Expiration sub-view.
  let expirationSet = false;
  let expirationAppliedIso = null;
  if (typeof expiration_minutes === 'number' && Number.isFinite(expiration_minutes) && expiration_minutes > 0) {
    const target = new Date(Date.now() + expiration_minutes * 60 * 1000);
    expirationAppliedIso = target.toISOString();
    const expRowOpened = await clickButtonInDialogByText(
      `(/^(January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d+,\\s+\\d{4}\\s+at\\s+\\d{1,2}:\\d{2}/i.test(t))`
    );
    if (expRowOpened) {
      await sleep(500);
      const yyyy = target.getFullYear();
      const mm = String(target.getMonth() + 1).padStart(2, '0');
      const dd = String(target.getDate()).padStart(2, '0');
      const hh = String(target.getHours()).padStart(2, '0');
      const mi = String(target.getMinutes()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const timeStr = `${hh}:${mi}`;
      expirationSet = await evaluate(`
        (function() {
          var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
          var scope = dialog || document;
          var inputs = scope.querySelectorAll('input[type="date"], input[type="time"], input[type="text"]');
          var dateSet = false, timeSet = false;
          var nativeSet = ${NATIVE_INPUT_SETTER};
          for (var i = 0; i < inputs.length; i++) {
            var inp = inputs[i];
            if (inp.type === 'date' && !dateSet) {
              nativeSet.call(inp, ${safeString(dateStr)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              dateSet = true;
            } else if (inp.type === 'time' && !timeSet) {
              nativeSet.call(inp, ${safeString(timeStr)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              timeSet = true;
            }
          }
          return dateSet || timeSet;
        })()
      `);
      await applySubView();
      await sleep(500);
    }
  }

  // 7. Set the trigger price NOW (last, just before Create) so prior sub-view
  //    re-renders don't reset it back to TV's "current price" default.
  const priceSet = await evaluate(`
    (function() {
      var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
      if (!dialog) return false;
      var inputs = dialog.querySelectorAll('input[type="text"], input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.placeholder && /example\\.com\\/alert-hook/i.test(inp.placeholder)) continue;
        var nativeSet = ${NATIVE_INPUT_SETTER};
        nativeSet.call(inp, ${safeString(String(price))});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);
  await sleep(300);

  // 8. Submit on the main view.
  const createdLabel = await clickButtonInDialogByText(`t === 'Create'`);

  // 9. Verification — read back the just-created alert from the REST API to
  //    confirm web_hook actually landed in TV's stored state. This catches
  //    cases where our DOM toggle reported success but TV silently dropped
  //    the URL (rare but possible if the sub-view was in a transient state).
  let webhookVerified = null;
  if (createdLabel && webhook_url) {
    await sleep(400);
    const verify = await evaluateAsync(`
      fetch('https://pricealerts.tradingview.com/list_alerts?limit=1', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.s !== 'ok' || !Array.isArray(d.r) || d.r.length === 0) return null;
          var newest = d.r[0];
          return { alert_id: newest.alert_id, web_hook: newest.web_hook, message: newest.message };
        })
        .catch(function() { return null; })
    `);
    if (verify) webhookVerified = verify.web_hook === webhook_url;
  }

  return {
    success: !!createdLabel,
    price,
    price_set: !!priceSet,
    condition: conditionApplied,
    condition_set: !!conditionSet,
    condition_note: conditionApplied && !conditionSet ? 'Could not locate the condition menu item; alert will use TV\'s currently selected operator.' : undefined,
    message: message || null,
    message_set: !!messageSet,
    webhook_url: webhook_url || null,
    webhook_dom_configured: webhookConfigured,
    webhook_verified_in_tv: webhookVerified,
    expiration_minutes: expiration_minutes || null,
    expiration_iso: expirationAppliedIso,
    expiration_set: !!expirationSet,
    source: 'dom_fallback',
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

// TODO(per-alert delete): TradingView's REST surface for deleting a single
// alert is currently not discoverable from CDP. Tried (all returned
// `code=no_such_endpoint`): GET /remove_alert, /delete_alert, /alert,
// /show_alert, /alert_details, /get_alert, /get_alert_details, /remove_alerts,
// /remove, /delete, /archive_alert. POST /remove_alert and HTTP DELETE on
// /list_alerts / /alerts / /alert also fail (DELETE errors before send).
// The UI's per-row delete button dispatches at zero-bounding-rect when the
// alerts side panel is collapsed, which is why a synthetic click did not
// trigger a network request in repro. A future iteration should either:
//   (a) intercept TV's own delete request (via Network panel during a manual
//       delete) to identify the real endpoint + HTTP verb;
//   (b) ensure the alerts panel is fully expanded and visible before clicking
//       the per-row delete button, then handle the confirm dialog;
//   (c) call the TV WS protocol if that's where deletes actually flow.
// Until then, `name` / `alert_id` matching still runs and reports which
// alerts would be deleted — the caller can use TV's UI or alert_delete with
// delete_all: true (which opens the panel context menu for manual confirm).
async function deleteOneByApi(alertId) {
  const url = `https://pricealerts.tradingview.com/remove_alert?alert_id=${encodeURIComponent(alertId)}`;
  const result = await evaluateAsync(`
    fetch(${safeString(url)}, { credentials: 'include' })
      .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }).catch(function() { return { status: r.status, body: null }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);
  if (result?.error) return { ok: false, error: result.error };
  const body = result?.body;
  if (body && body.s === 'ok') return { ok: true, body };
  if (result?.status === 200 && !body) return { ok: true, body: null };
  return { ok: false, status: result?.status, body, errmsg: body?.errmsg };
}

export async function deleteAlerts({ delete_all, name, alert_id }) {
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
    return {
      success: true,
      note: 'Alert deletion requires manual confirmation in the context menu.',
      context_menu_opened: result?.context_menu_opened || false,
      source: 'dom_fallback',
    };
  }

  if (!name && !alert_id) {
    throw new Error('Pass delete_all: true, alert_id: "<id>", or name: "<substring>" to alert_delete.');
  }

  const listing = await list();
  if (listing.error) throw new Error(`Could not list alerts: ${listing.error}`);
  const all = listing.alerts || [];
  let targets = [];
  if (alert_id) {
    targets = all.filter(a => String(a.alert_id) === String(alert_id));
  } else if (name) {
    const needle = String(name).toLowerCase();
    targets = all.filter(a => (a.message || '').toLowerCase().includes(needle));
  }
  if (targets.length === 0) {
    return {
      success: false,
      deleted: 0,
      reason: alert_id ? `No alert with alert_id=${alert_id}` : `No alert message contains "${name}"`,
      candidates_searched: all.length,
    };
  }

  const results = [];
  for (const a of targets) {
    const res = await deleteOneByApi(a.alert_id);
    results.push({
      alert_id: a.alert_id,
      message: (a.message || '').slice(0, 60),
      ok: res.ok,
      error: res.error,
      status: res.status,
    });
  }
  const okCount = results.filter(r => r.ok).length;
  return {
    success: okCount === targets.length,
    deleted: okCount,
    attempted: targets.length,
    results,
    source: 'rest_api',
  };
}
