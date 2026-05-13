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

/**
 * DEFECT 8 — select the Source dropdown option in the Create Alert dialog.
 *
 * This dropdown is the FIRST dropdown in the Condition row (e.g. currently
 * "Price"). Clicking it opens an inline popover with a different DOM
 * architecture than the operator-row portal (DEFECT 2c):
 *
 *   Popover container: [role="listbox"][data-qa-id="popup-menu-container main-series-select"]
 *     class: menuWrap-XktvVkFF
 *     position: fixed (rendered to document.body — NOT inside the dialog)
 *   Items: [role="option"][class*="menuItem-VfhgWFqC"]
 *     id pattern: id_item_$Price$ | id_item_$Study$-<num>_<num>
 *     aria-selected: "true" on current selection
 *   Item label: [data-qa-id="main-series-select-title"] [class*="label-VfhgWFqC"]
 *     Example labels observed:
 *       "Price"
 *       "HyperClaw Stack v1 (Hurst + VWAP-Z + wRSI + RSI-Div) (100, 24, 7, ...)"
 *       "Vol"
 *       "Test1 RSI Sweep (14, 30, 70)"
 *
 * The popover dismisses on any document-level interaction, so the open
 * dropdown → find option → click flow must happen inside a single
 * page-context script (the MutationObserver pattern used during DOM probing
 * confirmed this).
 *
 * Matching strategy: case-insensitive substring match against the label
 * text — Pine indicators on the chart include their full param list in the
 * label, so callers can pass just the script title ("HyperClaw Stack v1")
 * without enumerating params.
 */
async function selectAlertSource(sourceName) {
  const want = String(sourceName).trim();
  const result = await evaluate(`
    (function() {
      var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
      if (!dialog) return { ok: false, error: 'no dialog' };
      // Find the source dropdown row — the FIRST select wrapper in the Condition row.
      var allSelects = dialog.querySelectorAll('[class*="select-VfhgWFqC"]');
      var sourceWrapper = allSelects[0];
      if (!sourceWrapper) return { ok: false, error: 'no source dropdown' };
      var realBtn = sourceWrapper.querySelector('[role="button"]');
      if (!realBtn) return { ok: false, error: 'no role=button child' };
      // Open the popover
      realBtn.click();
      // The popover renders via a React portal at document.body — it should be
      // available synchronously after the click, before this script returns
      // (because no setTimeout or microtask gap intervenes).
      var portal = document.querySelector('[role="listbox"][class*="menuWrap-XktvVkFF"]');
      if (!portal) {
        // Older popover class fallback
        portal = document.querySelector('[role="listbox"][data-qa-id*="main-series-select"]');
      }
      if (!portal) return { ok: false, error: 'source popover did not appear', source_wanted: ${safeString(want)} };
      // Collect all option labels for diagnostics
      var options = portal.querySelectorAll('[role="option"]');
      var labels = [];
      var match = null;
      var wantLower = ${safeString(want.toLowerCase())};
      for (var i = 0; i < options.length; i++) {
        var labelEl = options[i].querySelector('[data-qa-id="main-series-select-title"] [class*="label-VfhgWFqC"]')
                   || options[i].querySelector('[class*="label-VfhgWFqC"]');
        var labelText = (labelEl && labelEl.textContent || '').trim();
        labels.push(labelText);
        var lowerLabel = labelText.toLowerCase();
        if (!match) {
          // Prefer exact match first, then substring
          if (lowerLabel === wantLower) match = { el: options[i], label: labelText, score: 'exact' };
        }
      }
      if (!match) {
        for (var j = 0; j < options.length; j++) {
          var labelEl2 = options[j].querySelector('[data-qa-id="main-series-select-title"] [class*="label-VfhgWFqC"]')
                     || options[j].querySelector('[class*="label-VfhgWFqC"]');
          var labelText2 = (labelEl2 && labelEl2.textContent || '').trim().toLowerCase();
          if (labelText2.indexOf(wantLower) !== -1) {
            match = { el: options[j], label: (labelEl2 && labelEl2.textContent || '').trim(), score: 'substring' };
            break;
          }
        }
      }
      if (!match) {
        // Close popover so we don't leave it dangling
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return { ok: false, error: 'source not found', wanted: ${safeString(want)}, available: labels };
      }
      match.el.click();
      return { ok: true, matched_label: match.label, match_kind: match.score, available: labels };
    })()
  `);
  return result;
}

export async function create({ source, condition, price, message, webhook_url, expiration_minutes }) {
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

  // 2. Source (DEFECT 8) — change the alert data source from the default
  //    "Price" to a chart indicator (Pine alertcondition source). Must run
  //    BEFORE the operator step because switching source re-renders the
  //    operator dropdown's options (Price uses Crossing/Greater/Less; a
  //    Pine indicator uses its alertcondition() titles).
  let sourceSet = false;
  let sourceMatchedLabel = null;
  let sourceAvailable = null;
  if (source) {
    // The dialog defaults to "Price" — so if caller asked for "Price" exactly
    // and that's already what's shown, skip the dropdown round-trip. Any
    // other value (Vol, Volume, a Pine indicator title, etc) goes through
    // the source selector.
    const skipBecauseDefault = String(source).trim().toLowerCase() === 'price';
    if (!skipBecauseDefault) {
      const srcResult = await selectAlertSource(source);
      sourceSet = !!(srcResult && srcResult.ok);
      sourceMatchedLabel = srcResult?.matched_label || null;
      sourceAvailable = srcResult?.available || null;
      if (!sourceSet) {
        throw new Error(
          `Source "${source}" not found in alert dropdown — is the Pine indicator attached to the chart? ` +
          (sourceAvailable ? `Available: ${sourceAvailable.join(' | ')}` : '')
        );
      }
      // Switching source re-renders dependent fields; let TV settle.
      await sleep(700);
    }
  }

  // 3. Condition operator (Crossing / Greater Than / Less Than / etc.).
  //    The operator row is a button whose text is the current operator name.
  //    Clicking it opens a portal popover (class positioner-lATuqHRX +
  //    contentDefaultAppearance-ODkmI6nR) outside the dialog DOM. The first
  //    three options (Crossing / Crossing Up / Crossing Down) are visible
  //    initially; the remaining 10 are revealed by clicking "Show more". Each
  //    option's text lives in a [class*="title-RDCgMoEQ"] inside a clickable
  //    [class*="button-HZXWyU6m"] wrapper.
  let conditionSet = false;
  let conditionApplied = source ? String(condition || '').trim() : canonicalCondition(condition);
  const PORTAL_SELECTOR = `[class*="positioner-lATuqHRX"][class*="contentDefaultAppearance"]`;
  if (conditionApplied) {
    // When source is a Pine indicator, the row button text is the current
    // alertcondition title — arbitrary text. Fall back to matching the
    // dropdown button by class rather than known operator names.
    let conditionRowOpened = await clickButtonInDialogByText(
      `(t === 'Crossing' || t === 'Crossing Up' || t === 'Crossing Down' || t === 'Greater Than' || t === 'Less Than' || t === 'Entering Channel' || t === 'Exiting Channel' || t === 'Inside Channel' || t === 'Outside Channel' || t === 'Moving Up' || t === 'Moving Down' || t === 'Moving Up %' || t === 'Moving Down %')`
    );
    if (!conditionRowOpened && source) {
      // Pine-source path: click the dropdownButton-lFPR_Qij in the Condition row.
      conditionRowOpened = await evaluate(`
        (function() {
          var dialog = document.querySelector(${safeString(DIALOG_SELECTOR)});
          if (!dialog) return false;
          var btn = dialog.querySelector('[class*="dropdownButton-lFPR_Qij"]');
          if (!btn) return false;
          var realBtn = btn.querySelector('[role="button"]') || btn;
          realBtn.click();
          return (btn.textContent || '').trim();
        })()
      `);
    }
    if (conditionRowOpened) {
      await sleep(500);
      // If the wanted option isn't in the first 3 visible items, click "Show more".
      const wantInTopThree = ['Crossing', 'Crossing Up', 'Crossing Down'].some(
        s => s.toLowerCase() === conditionApplied.toLowerCase()
      );
      if (!wantInTopThree) {
        const expanded = await evaluate(`
          (function() {
            var portal = document.querySelector(${safeString(PORTAL_SELECTOR)});
            if (!portal) return false;
            // Show more is rendered as a "customListItem" BUTTON. Match by its text.
            var clickables = portal.querySelectorAll('button, [class*="customListItem"], [class*="clickable"]');
            for (var i = 0; i < clickables.length; i++) {
              if ((clickables[i].textContent || '').trim() === 'Show more') {
                clickables[i].click();
                return true;
              }
            }
            return false;
          })()
        `);
        if (expanded) await sleep(500);
      }
      // Click the option whose title matches the requested operator.
      conditionSet = await evaluate(`
        (function() {
          var want = ${safeString(conditionApplied)};
          var portal = document.querySelector(${safeString(PORTAL_SELECTOR)});
          if (!portal) return false;
          var titles = portal.querySelectorAll('[class*="title-RDCgMoEQ"]');
          for (var i = 0; i < titles.length; i++) {
            var t = (titles[i].textContent || '').trim();
            if (t.toLowerCase() === want.toLowerCase()) {
              // Walk up to the clickable button-HZXWyU6m wrapper
              var p = titles[i];
              for (var d = 0; d < 6 && p.parentElement; d++) {
                p = p.parentElement;
                if ((p.className || '').indexOf('button-HZXWyU6m') !== -1) { p.click(); return true; }
              }
              titles[i].click();
              return true;
            }
          }
          // Dismiss the popover if we couldn't match
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
  //    confirm web_hook and condition operator actually landed in TV's stored
  //    state. DOM observation alone is unreliable because the dialog inherits
  //    fields from previous alerts.
  let webhookVerified = null;
  let conditionVerified = null;
  let verifiedAlertId = null;
  if (createdLabel) {
    // TV's REST list_alerts can lag the Create click by ~1.5-2s, especially
    // for indicator-sourced alerts whose payload is larger. Wait long enough
    // that the newest alert is reliably visible to the API; otherwise verify
    // reads back the *previous* alert and falsely reports a stale alert_id /
    // condition / webhook for the just-created one.
    await sleep(2500);
    const verify = await evaluateAsync(`
      fetch('https://pricealerts.tradingview.com/list_alerts?limit=1', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.s !== 'ok' || !Array.isArray(d.r) || d.r.length === 0) return null;
          var newest = d.r[0];
          var series0 = newest.condition && newest.condition.series && newest.condition.series[0];
          return {
            alert_id: newest.alert_id,
            web_hook: newest.web_hook,
            message: newest.message,
            type: newest.type,
            condition_type: newest.condition && newest.condition.type,
            condition_value: newest.condition && newest.condition.series && newest.condition.series[1] && newest.condition.series[1].value,
            // Pine-source fields (only populated when type === "indicator")
            series_type: series0 && series0.type,
            pine_id: series0 && series0.pine_id,
            pine_version: series0 && series0.pine_version,
            alert_cond_id: newest.condition && newest.condition.alert_cond_id
          };
        })
        .catch(function() { return null; })
    `);
    if (verify) {
      verifiedAlertId = verify.alert_id;
      if (webhook_url) webhookVerified = verify.web_hook === webhook_url;
      if (conditionApplied) {
        if (source && verify.type === 'indicator' && verify.condition_type === 'alert_cond') {
          // Pine-source alert: verification is "did TV store the alert as an
          // indicator alert with our pine_id?" We can't easily verify the
          // exact alertcondition title from the REST payload (it stores an
          // opaque alert_cond_id like "plot_1"), so we accept the alert if
          // it landed as a pine_id alert at all.
          conditionVerified = !!verify.pine_id;
        } else {
          // TV's stored condition type is "cross" / "greater" / "less" — slug.
          const wantSlug = (function(name) {
            var n = String(name).toLowerCase();
            if (n === 'crossing') return 'cross';
            if (n === 'crossing up') return 'cross_up';
            if (n === 'crossing down') return 'cross_down';
            if (n === 'greater than') return 'greater';
            if (n === 'less than') return 'less';
            if (n === 'entering channel') return 'entering_channel';
            if (n === 'exiting channel') return 'exiting_channel';
            if (n === 'inside channel') return 'inside_channel';
            if (n === 'outside channel') return 'outside_channel';
            if (n === 'moving up') return 'moving_up';
            if (n === 'moving down') return 'moving_down';
            if (n === 'moving up %') return 'moving_up_percent';
            if (n === 'moving down %') return 'moving_down_percent';
            return n;
          })(conditionApplied);
          conditionVerified = verify.condition_type === wantSlug;
        }
      }
    }
  }

  return {
    success: !!createdLabel,
    alert_id: verifiedAlertId,
    price,
    price_set: !!priceSet,
    // Source selection (DEFECT 8)
    source: source || null,
    source_set: !!sourceSet,
    source_matched_label: sourceMatchedLabel,
    source_available: sourceAvailable,
    condition: conditionApplied,
    condition_set: !!conditionSet,
    condition_verified_in_tv: conditionVerified,
    condition_note: conditionApplied && !conditionSet ? 'Could not locate the condition menu item; alert will use TV\'s currently selected operator.' : undefined,
    message: message || null,
    message_set: !!messageSet,
    webhook_url: webhook_url || null,
    webhook_dom_configured: webhookConfigured,
    webhook_verified_in_tv: webhookVerified,
    expiration_minutes: expiration_minutes || null,
    expiration_iso: expirationAppliedIso,
    expiration_set: !!expirationSet,
    walker_source: 'dom_fallback',
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

/**
 * Delete one or more alerts in a single batched POST to TradingView's
 * pricealerts service. Endpoint discovered via DevTools network capture on
 * the web client (see commit message). Auth piggybacks on the session
 * cookies already present in the TV Desktop context.
 *
 *   POST https://pricealerts.tradingview.com/delete_alerts
 *   Content-Type: text/plain;charset=UTF-8
 *   Body: {"payload":{"alert_ids":[<id>, ...]}}
 *
 * On success TV returns {s:"ok", ...}. On failure it returns
 * {s:"error", errmsg:"...", err:{code:"..."}}.
 */
async function deleteAlertsByApi(alertIds) {
  if (!Array.isArray(alertIds) || alertIds.length === 0) {
    return { ok: false, error: 'alertIds must be a non-empty array' };
  }
  const idsAsNumbers = alertIds.map(x => {
    const n = Number(x);
    return Number.isFinite(n) ? n : x;
  });
  const body = JSON.stringify({ payload: { alert_ids: idsAsNumbers } });
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: ${safeString(body)}
    })
      .then(function(r) {
        return r.json()
          .then(function(j) { return { status: r.status, body: j }; })
          .catch(function() { return { status: r.status, body: null }; });
      })
      .catch(function(e) { return { error: e.message }; })
  `);
  if (result?.error) return { ok: false, error: result.error };
  const b = result?.body;
  if (b && b.s === 'ok') return { ok: true, body: b };
  if (result?.status === 200 && !b) return { ok: true, body: null };
  return { ok: false, status: result?.status, body: b, errmsg: b?.errmsg };
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

  // Batch delete in a single POST — the /delete_alerts endpoint accepts an
  // array of alert_ids and returns a single ok/error response for the whole
  // batch. We surface the matched targets so the caller can audit what got
  // removed even when only one was requested.
  const ids = targets.map(a => a.alert_id);
  const res = await deleteAlertsByApi(ids);

  return {
    success: !!res.ok,
    deleted: res.ok ? targets.length : 0,
    attempted: targets.length,
    matched: targets.map(a => ({ alert_id: a.alert_id, message: (a.message || '').slice(0, 80), symbol: a.symbol })),
    error: res.ok ? undefined : (res.errmsg || res.error || `delete_alerts returned status ${res.status}`),
    source: 'rest_api',
  };
}
