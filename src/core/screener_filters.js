/**
 * Core Screener Filters management.
 *
 * Filter pills live in `[data-name^="screener-filter-pill-"]` inside the
 * screener container. Clicking a pill opens a popover whose header has a
 * `[data-qa-id="popover-header-remove-button"]` — clicking that detaches
 * the filter from the current screen.
 *
 * MVP actions: list, remove, clear.
 * Stretch actions: add, modify — return `not_implemented_yet` for now.
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

/**
 * Dismiss any filter-pill popover that's currently open. Important before
 * clicking the next pill so we don't pick up the previous popover's remove
 * button. Clicks an empty spot inside the screener container and waits for
 * the popover to unmount.
 */
async function closeAnyPopover(evaluate) {
  const anyVisible = await evaluate(`
    (function() {
      var pops = document.querySelectorAll('[class*="popover"]');
      for (var i = 0; i < pops.length; i++) {
        if (pops[i].offsetParent !== null) return true;
      }
      return false;
    })()
  `);
  if (!anyVisible) return;
  // Click just outside any pill — the screener table area dismisses popovers.
  await evaluate(`
    (function() {
      var container = document.querySelector('[class*="screenerContainer"]');
      if (!container) return;
      var table = container.querySelector('table');
      if (table) {
        var r = table.getBoundingClientRect();
        var evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + r.height - 40 });
        document.elementFromPoint(r.x + 40, r.y + r.height - 40)?.dispatchEvent(evt);
      }
      document.body.click();
    })()
  `);
  await sleep(250);
}

const LIST_EXPR = `
  (function() {
    var container = document.querySelector('[class*="screenerContainer"]');
    if (!container) return null;
    var pills = container.querySelectorAll('[data-name^="screener-filter-pill-"]');
    var out = [];
    for (var i = 0; i < pills.length; i++) {
      var el = pills[i];
      var label = (el.textContent || '').trim();
      var id = el.getAttribute('data-name') || '';
      out.push({ label: label, id: id });
    }
    return out;
  })()
`;

export async function list({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const pills = await evaluate(LIST_EXPR);
  if (pills === null) return notOpenResult('list');
  return {
    success: true,
    action: 'list',
    open: true,
    count: pills.length,
    filters: pills,
  };
}

/**
 * Remove a single filter pill whose label matches `filter` (case-insensitive,
 * trimmed, substring match preferred over exact so "Market cap" matches
 * "Market cap" and "market").
 *
 * Returns { success, action, removed, remaining } — idempotent: removing a
 * filter that doesn't exist returns success with removed=[] and full list.
 */
export async function remove({ filter, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  if (!filter || typeof filter !== 'string' || !filter.trim()) {
    throw new Error('remove requires a non-empty `filter` label');
  }
  await assertScreenerOpen(evaluate);
  // Clear any stale popover so we don't pick up the previous one.
  await closeAnyPopover(evaluate);

  const before = await evaluate(LIST_EXPR) || [];

  // Click the matching pill's popover, then the remove button.
  const clickResult = await evaluate(`
    (function() {
      var needle = ${safeString(filter.trim().toLowerCase())};
      var pills = document.querySelectorAll('[data-name^="screener-filter-pill-"]');
      var match = null;
      for (var i = 0; i < pills.length; i++) {
        var label = (pills[i].textContent || '').trim().toLowerCase();
        if (label === needle) { match = pills[i]; break; }
      }
      if (!match) {
        for (var j = 0; j < pills.length; j++) {
          var l = (pills[j].textContent || '').trim().toLowerCase();
          if (l.indexOf(needle) !== -1) { match = pills[j]; break; }
        }
      }
      if (!match) return { found: false };
      var matchedLabel = (match.textContent || '').trim();
      match.click();
      return { found: true, matchedLabel: matchedLabel };
    })()
  `);

  if (!clickResult?.found) {
    // Idempotent: no-op success.
    return {
      success: true,
      action: 'remove',
      filter: filter,
      removed: [],
      remaining: before.map(p => p.label),
      note: 'filter not found — nothing to remove',
    };
  }

  // Wait for popover to render.
  await sleep(350);

  // Search every visible popover for the remove button. Some pills (market
  // source selectors like "Index", "Watchlist") open a categorical-choice
  // popover with no remove button — those are not user-removable.
  const removeBtnResult = await evaluate(`
    (function() {
      var pops = document.querySelectorAll('[class*="popover"]');
      for (var i = 0; i < pops.length; i++) {
        var p = pops[i];
        if (p.offsetParent === null) continue;
        var btn = p.querySelector('[data-qa-id="popover-header-remove-button"]');
        if (btn) { btn.click(); return { ok: true }; }
      }
      var anyVisible = false;
      pops.forEach(function(p) { if (p.offsetParent !== null) anyVisible = true; });
      return { ok: false, reason: anyVisible ? 'no_remove_button' : 'no_popover' };
    })()
  `);

  if (!removeBtnResult?.ok) {
    // Best-effort cleanup: close the popover.
    await evaluate(`document.body.click()`);
    if (removeBtnResult?.reason === 'no_remove_button') {
      // Pill is a market-source selector or otherwise not user-removable —
      // return a clean non-throwing result so callers (including clear())
      // can skip it.
      return {
        success: false,
        action: 'remove',
        filter: clickResult.matchedLabel,
        removed: [],
        remaining: before.map(p => p.label),
        error: 'not_removable',
        hint: 'This pill is not a user filter (likely a market source like "Index" or "Watchlist"). Use TradingView UI to change it.',
      };
    }
    throw new Error('Failed to remove filter: ' + (removeBtnResult?.reason || 'unknown'));
  }

  // Wait for DOM to settle.
  await sleep(400);

  const after = await evaluate(LIST_EXPR) || [];
  const beforeLabels = before.map(p => p.label);
  const afterLabels = after.map(p => p.label);
  const removed = beforeLabels.filter(l => !afterLabels.includes(l));

  return {
    success: true,
    action: 'remove',
    filter: clickResult.matchedLabel,
    removed: removed,
    remaining: afterLabels,
  };
}

/**
 * Remove every filter pill one at a time. Iterates until no pills remain or
 * the loop has made no progress (safety bound ~50 iterations).
 */
export async function clear({ _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  await assertScreenerOpen(evaluate);

  const before = await evaluate(LIST_EXPR) || [];
  const beforeLabels = before.map(p => p.label);

  let removedTotal = 0;
  const skipped = [];
  // Track pill ids we've already tried-and-skipped so we don't loop on them.
  const skippedIds = new Set();
  let guard = 0;
  const MAX = 50;

  while (guard < MAX) {
    guard++;
    // Close any stale popover before each iteration.
    await closeAnyPopover(evaluate);

    const current = await evaluate(LIST_EXPR) || [];
    // Find the first pill we haven't already skipped.
    const nextPill = current.find(p => !skippedIds.has(p.id));
    if (!nextPill) break;

    // Click that specific pill by data-name.
    const clickResult = await evaluate(`
      (function() {
        var pill = document.querySelector('[data-name="' + ${safeString(nextPill.id)} + '"]');
        if (!pill) return { found: false };
        pill.click();
        return { found: true, label: (pill.textContent || '').trim() };
      })()
    `);
    if (!clickResult?.found) {
      skippedIds.add(nextPill.id);
      continue;
    }

    await sleep(300);

    const removeResult = await evaluate(`
      (function() {
        var pops = document.querySelectorAll('[class*="popover"]');
        for (var i = 0; i < pops.length; i++) {
          var p = pops[i];
          if (p.offsetParent === null) continue;
          var btn = p.querySelector('[data-qa-id="popover-header-remove-button"]');
          if (btn) { btn.click(); return { ok: true }; }
        }
        return { ok: false };
      })()
    `);

    if (!removeResult?.ok) {
      // Not user-removable (market source, etc.) — skip this pill and move on.
      await evaluate(`document.body.click()`);
      skippedIds.add(nextPill.id);
      skipped.push(nextPill.label);
      await sleep(200);
      continue;
    }
    removedTotal++;
    await sleep(300);
  }

  const after = await evaluate(LIST_EXPR) || [];
  const afterLabels = after.map(p => p.label);

  return {
    success: true,
    action: 'clear',
    removed_count: removedTotal,
    removed: beforeLabels.filter(l => !afterLabels.includes(l)),
    remaining: afterLabels,
    skipped,
  };
}

// ── Stretch actions (schemas exposed, flows deferred) ────────────────────

export async function add({ filter, operator, value, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  // Soft pre-check so we still return a clean error when closed.
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('add');
  return notImplemented(
    'add',
    'Adding filters requires navigating the TradingView filter catalog (click the + button, pick a category, set operator/value). This UI flow is not yet automated — add the filter in TradingView, then use screener_screens.save to persist.',
  );
}

export async function modify({ filter, operator, value, _deps } = {}) {
  const { evaluate } = resolveDeps(_deps);
  const probe = await evaluate(LIST_EXPR);
  if (probe === null) return notOpenResult('modify');
  return notImplemented(
    'modify',
    'Modifying filter values requires interacting with the per-filter popover inputs. Not yet automated — adjust the filter in TradingView UI directly.',
  );
}
