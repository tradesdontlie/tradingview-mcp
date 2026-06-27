/**
 * Core alert logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient, safeString } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

// Wait for the Create Alert dialog to mount before populating price/message fields.
const ALERT_DIALOG_OPEN_MS = 1000;
// Wait after filling fields before clicking Create, so input events settle.
const ALERT_FIELDS_SETTLE_MS = 500;
// Wait after changing the condition: the dialog re-renders its field set (the
// operator dropdown opens, then the field row re-lays-out on selection).
const ALERT_CONDITION_SETTLE_MS = 700;

// The redesigned (2025/2026) alert dialog exposes only these three operators for
// a Price condition. The values are the literal option labels rendered in the
// `[role="option"]` dropdown — see openspec change `apply-alert-condition`
// design.md §0 for the live-DOM capture. "Greater Than"/"Less Than" no longer
// exist in this UI, so the `condition` enum was re-aligned to match it.
const CONDITION_LABELS = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// React in the alert dialog only honours TRUSTED pointer events, so the operator
// dropdown and its options must be driven with real CDP mouse input — page-side
// element.click()/synthetic MouseEvents are ignored (design.md §0). evaluate()
// locates the target rect; this issues the trusted click at its centre.
async function realClick(client, x, y) {
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Centre of an element matched by a page-side expression that returns a rect, or
// null if the element is absent. `findExpr` must evaluate to the element.
function rectOf(findExpr) {
  return `(function(){ var el = ${findExpr}; if (!el) return null; var r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
}

// Type a value into an input by driving it with TRUSTED keyboard input: real
// click to focus -> Ctrl+A to select existing text -> insertText -> Tab to
// commit. A native-setter `.value` write updates only the visible field, not
// TradingView's alert model, so the model keeps the dialog's seeded value and
// the created alert lands at the wrong price (smoke-test finding). The commit
// (Tab/blur) is what makes the model pick the value up.
async function typeIntoField(client, rect, text) {
  await realClick(client, rect.x, rect.y);
  await sleep(150);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await sleep(120);
  await client.Input.insertText({ text });
  await sleep(120);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
}

// Open the create-alert dialog. The header "Create alert" control opens the side
// panel (wrong surface) and page-side clicks don't drive it, so the reliable path
// is: right-click the chart pane -> click the "Add alert on <symbol>" context-menu
// row (real mouse). Alt+A is the keyboard fallback. Returns true once the dialog's
// condition control is present.
async function openAlertDialog(evaluate, getClient) {
  const client = await getClient();
  const present = () => evaluate(`(!!document.querySelector('[class*="operatorRow"]'))`);

  const paneRect = await evaluate(rectOf(`document.querySelector('[class*="chart-gui-wrapper"]') || document.querySelector('table.chart-markup-table') || document.querySelector('canvas')`));
  if (paneRect) {
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: paneRect.x, y: paneRect.y });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: paneRect.x, y: paneRect.y, button: 'right', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: paneRect.x, y: paneRect.y, button: 'right', clickCount: 1 });
    await sleep(ALERT_FIELDS_SETTLE_MS);
    const row = await evaluate(rectOf(`(function(){ var t = document.querySelectorAll('tr,[role="menuitem"],[class*="item"]'); for (var i = 0; i < t.length; i++) { if (/^Add alert on/i.test((t[i].textContent || '').trim())) return t[i]; } return null; })()`));
    if (row) { await realClick(client, row.x, row.y); await sleep(ALERT_DIALOG_OPEN_MS); }
  }

  if (await present()) return true;

  // Fallback: Alt+A keyboard shortcut (the same action the context menu names).
  await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  await sleep(ALERT_DIALOG_OPEN_MS);
  return await present();
}

// Select the requested condition in the open dialog and verify the dialog holds
// it. Throws if the control is missing, the requested option isn't offered by
// this build, or the read-back doesn't match — so a wrong/unverified condition
// never reaches Create. Returns the confirmed label.
async function applyCondition(evaluate, getClient, condition) {
  const label = CONDITION_LABELS[condition];
  if (!label) throw new Error(`Unknown alert condition '${condition}'`);
  const client = await getClient();

  const rowRect = await evaluate(rectOf(`document.querySelector('[class*="operatorRow"]')`));
  if (!rowRect) throw new Error(`Could not apply alert condition '${condition}': condition control not found in alert dialog`);
  await realClick(client, rowRect.x, rowRect.y);
  await sleep(ALERT_CONDITION_SETTLE_MS);

  const optRect = await evaluate(rectOf(`(function(){ var n = document.querySelectorAll('[role="option"]'); for (var i = 0; i < n.length; i++) { if ((n[i].textContent || '').trim() === ${safeString(label)}) return n[i]; } return null; })()`));
  if (!optRect) throw new Error(`Could not apply alert condition '${condition}': option ${safeString(label)} not offered by this TradingView build (available: Crossing, Crossing Up, Crossing Down)`);
  await realClick(client, optRect.x, optRect.y);
  await sleep(ALERT_CONDITION_SETTLE_MS);

  const confirmed = await evaluate(`(function(){ var e = document.querySelector('[class*="operatorRow"]'); return e ? (e.textContent || '').trim() : null; })()`);
  if (confirmed !== label) throw new Error(`Alert condition not applied: requested ${safeString(label)}, dialog holds ${safeString(String(confirmed))}`);
  return confirmed;
}

export async function create({ condition, price, message, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);

  const opened = await openAlertDialog(evaluate, getClient);
  if (!opened) throw new Error('Could not open the alert dialog');

  // Apply + verify the requested condition BEFORE touching price/Create, so a
  // condition that can't be honoured fails loud and creates nothing.
  const confirmedLabel = await applyCondition(evaluate, getClient, condition);

  const client = await getClient();

  // The context-menu entry seeds a price at the click location; override it with
  // the requested price via trusted keyboard input (a DOM `.value` write is
  // ignored by the alert model). The dialog uses hashed class names, so target
  // the first visible value input inside the dialog.
  const PRICE_INPUT = `(function(){ var dlg = document.querySelector('[class*="dialog"]'); var ins = dlg ? dlg.querySelectorAll('input[type="text"], input[type="number"]') : []; for (var i = 0; i < ins.length; i++) { if (ins[i].offsetParent !== null) return ins[i]; } return null; })()`;
  const priceRect = await evaluate(rectOf(PRICE_INPUT));
  if (!priceRect) throw new Error('Could not find the price input in the alert dialog');
  await typeIntoField(client, priceRect, String(price));
  await sleep(ALERT_FIELDS_SETTLE_MS);

  // Verify the price committed BEFORE clicking Create, so a mis-set price fails
  // loud instead of creating an alert at the wrong level.
  const priceReadback = await evaluate(`(function(){ var el = ${PRICE_INPUT}; return el ? el.value : null; })()`);
  const priceSet = priceReadback != null && Number(String(priceReadback).replace(/[,\s]/g, '')) === Number(price);
  if (!priceSet) throw new Error(`Alert price not applied: requested ${price}, dialog holds ${safeString(String(priceReadback))}`);

  // Best-effort custom message: type it into the dialog's message field if one is
  // visible. The auto-generated message (symbol + condition + price) stands
  // otherwise — message is cosmetic and never blocks alert creation.
  if (message) {
    const msgRect = await evaluate(rectOf(`(function(){ var dlg = document.querySelector('[class*="dialog"]'); var t = dlg && dlg.querySelector('textarea'); return (t && t.offsetParent !== null) ? t : null; })()`));
    if (msgRect) { await typeIntoField(client, msgRect, message); await sleep(ALERT_FIELDS_SETTLE_MS); }
  }

  // Click Create with real mouse (page-side clicks aren't trusted by the dialog).
  const createRect = await evaluate(rectOf(`(function(){ var b = document.querySelectorAll('button,[role="button"]'); for (var i = 0; i < b.length; i++) { if (/^create$/i.test((b[i].textContent || '').trim())) return b[i]; } return null; })()`));
  if (!createRect) throw new Error('Could not find Create button in alert dialog');
  await realClick(client, createRect.x, createRect.y);

  return {
    success: true,
    price,
    condition_requested: condition,
    condition: confirmedLabel,
    message: message || '(none)',
    price_set: priceSet,
    source: 'applied',
  };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
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
  if (result?.error) throw new Error(result.error);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [] };
}

// Page-side fetch to the pricealerts delete endpoint. The body MUST be wrapped in
// `payload` and sent as text/plain — application/json triggers a CORS preflight
// the server rejects, and the bare `{alert_ids:[...]}` shape returns
// invalid_request. Captured from the live TradingView client via CDP Network.
function deleteAlertsJS(ids) {
  const body = JSON.stringify({ payload: { alert_ids: ids } });
  return `
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${JSON.stringify(body)}
    })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { error: e.message }; })
  `;
}

export async function deleteAlerts({ alert_ids, delete_all = false, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);

  let ids = Array.isArray(alert_ids) ? alert_ids.slice() : (alert_ids != null ? [alert_ids] : []);

  if (delete_all) {
    const listed = await list({ _deps });
    ids = (listed.alerts || []).map(a => a.alert_id);
    if (ids.length === 0) return { success: true, deleted_count: 0, deleted_ids: [], source: 'pricealerts_api' };
  }

  if (ids.length === 0) throw new Error('Pass alert_ids (one id or an array) or delete_all:true');

  const result = await evaluateAsync(deleteAlertsJS(ids));
  if (result?.error) throw new Error(result.error);
  if (result?.s !== 'ok') throw new Error(`delete_alerts failed: ${result?.errmsg || JSON.stringify(result)}`);

  return { success: true, deleted_count: ids.length, deleted_ids: ids, source: 'pricealerts_api' };
}
