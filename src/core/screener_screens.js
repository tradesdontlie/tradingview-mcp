/**
 * Core Screener Screens (preset) management.
 *
 * The "screen" is the named preset shown in the top-left of the dialog
 * (e.g., "All stocks", "Pre-market gainers"). The screen-actions menu opens
 * when you click the title: `[data-name="screener-topbar-screen-title"]`.
 *
 * Menu items (by `data-qa-id`):
 *   screener-screen-actions-save-screen       — Save (disabled if no changes)
 *   screener-screen-actions-save-screen-as    — "Make a copy…" (save-as)
 *   screener-screen-actions-rename-screen     — Rename (disabled for built-ins)
 *   screener-screen-actions-create-new-screen — Create blank screen
 *   screener-screen-actions-load-screen       — "Open screen…" (switch)
 *   screener-screen-actions-export-csv        — CSV export
 *
 * MVP: active (read current screen name), menu_actions (report availability).
 * Stretch: list, switch, save_as, save, delete, rename, create_new.
 *
 * The modal flows behind "Open screen…" and "Make a copy…" require typing
 * into an input and confirming — these are deferred to a follow-up once the
 * modal DOM is fully characterised.
 *
 * Per CONTRIBUTING.md: UI automation only.
 */
import { safeString } from '../connection.js';
import {
  resolveDeps,
  assertScreenerOpen,
  notOpenResult,
  notImplemented,
  sleep,
} from './_screener_shared.js';

const ACTIVE_EXPR = `
  (function() {
    var container = document.querySelector('[class*="screenerContainer"]');
    if (!container || container.offsetParent === null) return null;
    var titleEl = document.querySelector('[data-name="screener-topbar-screen-title"]');
    if (!titleEl) return { error: 'no_title' };
    return { name: (titleEl.textContent || '').trim() };
  })()
`;

/** Return the currently active screen name. */
export async function active({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const result = await evaluate(ACTIVE_EXPR);
  if (result === null) return notOpenResult('active');
  if (result.error) return { success: false, action: 'active', open: true, error: result.error };
  return { success: true, action: 'active', open: true, screen: result.name };
}

/**
 * Open the screen-actions menu and report which actions are currently
 * available (aria-disabled=false). Closes the menu before returning.
 *
 * Returns { success, active, available, disabled } where:
 *   available — actions with aria-disabled !== "true"
 *   disabled  — actions with aria-disabled === "true" (e.g., Rename on builtins)
 */
export async function menu_actions({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  await assertScreenerOpen(evaluate);

  // Open the menu.
  await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="screener-topbar-screen-title"]');
      if (el) el.click();
    })()
  `);
  await sleep(500);

  const snapshot = await evaluate(`
    (function() {
      var menu = document.querySelector('[class*="menu-jTwl4vFK"]');
      if (!menu) return { err: 'menu_not_found' };
      var items = menu.querySelectorAll('[data-qa-id^="screener-screen-actions-"]');
      var out = [];
      for (var i = 0; i < items.length; i++) {
        out.push({
          qaId: items[i].getAttribute('data-qa-id'),
          label: (items[i].textContent || '').trim(),
          disabled: items[i].getAttribute('aria-disabled') === 'true',
        });
      }
      return { items: out };
    })()
  `);

  // Dismiss menu.
  await evaluate(`document.body.click()`);
  await sleep(200);

  if (snapshot?.err) {
    throw new Error('Screen-actions menu did not open: ' + snapshot.err);
  }

  const items = snapshot?.items || [];
  const available = items.filter(i => !i.disabled).map(i => i.label);
  const disabled = items.filter(i => i.disabled).map(i => i.label);

  return {
    success: true,
    action: 'menu_actions',
    available,
    disabled,
    items,
  };
}

/**
 * Internal helper: open the screen-actions menu and click a menu item by
 * its `data-qa-id` suffix (e.g., "save-screen-as"). Returns { clicked, disabled }.
 */
async function clickMenuAction(evaluate, suffix) {
  await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="screener-topbar-screen-title"]');
      if (el) el.click();
    })()
  `);
  await sleep(500);

  const result = await evaluate(`
    (function() {
      var qa = ${safeString('screener-screen-actions-' + suffix)};
      var menu = document.querySelector('[class*="menu-jTwl4vFK"]');
      if (!menu) return { clicked: false, reason: 'menu_not_found' };
      var item = menu.querySelector('[data-qa-id="' + qa + '"]');
      if (!item) return { clicked: false, reason: 'item_not_found' };
      if (item.getAttribute('aria-disabled') === 'true') {
        // Close menu via body click.
        document.body.click();
        return { clicked: false, reason: 'item_disabled' };
      }
      item.click();
      return { clicked: true };
    })()
  `);

  return result || { clicked: false, reason: 'unknown' };
}

/**
 * Save the current screen state (if "Save screen" is enabled — i.e. there
 * are unsaved changes to a screen you own). Returns { success, action,
 * saved } — saved=false when nothing to save or the action was disabled.
 */
export async function save({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  await assertScreenerOpen(evaluate);

  const r = await clickMenuAction(evaluate, 'save-screen');
  if (!r.clicked) {
    return {
      success: true,
      action: 'save',
      saved: false,
      reason: r.reason || 'unknown',
      hint: r.reason === 'item_disabled'
        ? 'Save is disabled — either no unsaved changes, or the current screen is a built-in preset (use save_as to copy it).'
        : 'Save menu item not found.',
    };
  }
  await sleep(700);
  return { success: true, action: 'save', saved: true };
}

// ── Stretch actions — return not_implemented_yet with explanatory hints ──

export async function list({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('list');
  return notImplemented(
    'list',
    'Listing saved screens requires opening the "Open screen…" modal. Not yet automated — use screener_screens.active to get the current one, or browse the dropdown in TradingView.',
  );
}

export async function switchTo({ name, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('switch');
  return notImplemented(
    'switch',
    'Switching screens requires the "Open screen…" modal flow. Not yet automated — switch manually in TradingView.',
  );
}

export async function save_as({ name, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('save_as');
  return notImplemented(
    'save_as',
    'Save-as requires clicking "Make a copy…" and typing a name into a modal. Not yet automated — use TradingView UI directly.',
  );
}

export async function remove({ name, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('delete');
  return notImplemented(
    'delete',
    'Deleting a saved screen requires the "Open screen…" modal and a per-row delete affordance. Not yet automated.',
  );
}

export async function rename({ name, new_name, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('rename');
  return notImplemented(
    'rename',
    'Rename requires the rename modal flow. Not yet automated.',
  );
}

export async function createNew({ name, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(ACTIVE_EXPR);
  if (probe === null) return notOpenResult('create_new');
  return notImplemented(
    'create_new',
    '"Create new screen…" opens a modal for the new screen name. Not yet automated.',
  );
}
