/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { getTargetInfo, reconnectTo, CDP_HOST, CDP_PORT, CDP_TIMEOUT_MS, isChartTarget, withCdpDeadline, openCdpClient, closeCdpClient } from '../connection.js';

/**
 * Bounded detached CDP helpers for the Electron shell/landing pages, which are
 * intentionally not chart targets. They never enter the chart-client cache.
 */
export function createTabTransport({ cdp = CDP, fetch: fetchFn = globalThis.fetch, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const closeTimeoutMs = Math.min(timeoutMs, 1000);
  async function discoverTargets() {
    const controller = new AbortController();
    try {
      return await withCdpDeadline((async () => {
        const response = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: controller.signal });
        if (response.ok === false) throw new Error(`CDP discovery returned HTTP ${response.status}`);
        const targets = await response.json();
        if (!Array.isArray(targets)) throw new Error('Invalid CDP target list');
        return targets;
      })(), timeoutMs, 'tab discovery', () => controller.abort());
    } finally { controller.abort(); }
  }

  async function withTarget(targetId, fn, budget = timeoutMs) {
    const endsAt = Date.now() + budget;
    let active = true;
    let client;
    const operation = (async () => {
      client = await openCdpClient({ host: CDP_HOST, port: CDP_PORT, target: targetId }, { cdp, timeoutMs: budget });
      if (!active) throw new Error('Tab operation expired before its CDP connection was ready');
      return fn(async expression => {
        if (!active || Date.now() >= endsAt) throw new Error('Tab operation deadline expired; no further command was dispatched');
        const result = await withCdpDeadline(client.Runtime.evaluate({ expression, returnByValue: true }), Math.max(1, endsAt - Date.now()), 'tab evaluation');
        if (result.exceptionDetails) throw new Error(`JS evaluation error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
        return result.result?.value;
      });
    })();
    try { return await withCdpDeadline(operation, budget, 'tab operation', () => { active = false; }); }
    finally {
      active = false;
      await closeCdpClient(client, closeTimeoutMs);
    }
  }

  async function withShell(fn) {
    const endsAt = Date.now() + timeoutMs;
    const targets = await discoverTargets();
    const candidates = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));
    const shells = [];
    for (const candidate of candidates) {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) throw new Error('CDP shell discovery deadline expired');
      try {
        const found = await withTarget(candidate.id, evaluate => evaluate("!!document.querySelector('.tabs-container .tab')"), remaining);
        if (found) shells.push(candidate);
      } catch (error) {
        if (error.code === 'CDP_TIMEOUT') throw error;
        // Only read-only shell probes may advance to another candidate. Once
        // the callback below begins, every failure propagates without replay.
      }
    }
    if (shells.length > 1) throw new Error('Multiple TradingView shell tab bars are open; their chart ownership cannot be verified. Native tab mutation refused. Use target_select for chart calls.');
    if (!shells.length) throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
    const remaining = endsAt - Date.now();
    if (remaining <= 0) throw new Error('CDP shell discovery deadline expired');
    return withTarget(shells[0].id, fn, remaining);
  }

  return {
    discoverTargets, withTarget, withShell,
    isTargetVisible: targetId => withTarget(targetId, evaluate => evaluate('document.visibilityState')).then(value => value === 'visible'),
    findLandingTarget: async () => {
      const landings = (await discoverTargets()).filter(t => t.type === 'page' && t.title === 'New tab');
      if (landings.length > 1) throw new Error('Multiple new-tab landing pages are open; their window ownership is ambiguous. Refusing to reuse an arbitrary landing page.');
      return landings[0] || null;
    },
  };
}

const tabTransport = createTabTransport();
const { discoverTargets } = tabTransport;
const SHELL_TAB_SNAPSHOT = `(() => {
  const tabs = Array.from(document.querySelectorAll('.tabs-container .tab'));
  const active = Array.from(document.querySelectorAll('.tabs-container .tab.active'));
  return { shellVisible: document.visibilityState === 'visible', count: tabs.length, activeCount: active.length,
    activeIndex: active.length === 1 ? tabs.indexOf(active[0]) : -1,
    activeSignature: active.length === 1 ? active[0].outerHTML : null };
})()`;

function requireUniqueActiveTab(snapshot) {
  if (!snapshot?.shellVisible) throw new Error('The native shell tab bar is not visible; window ownership is unverified and mutation is refused.');
  if (!snapshot || snapshot.activeCount !== 1 || !Number.isInteger(snapshot.activeIndex) || snapshot.activeIndex < 0 || !snapshot.activeSignature) {
    throw new Error('A unique active shell tab could not be verified; native tab mutation refused.');
  }
}

// A visible selected popout is not enough: another visible chart can belong
// to the only recognized tab bar. Refuse native mutations unless the selected
// chart is the sole visible chart AND the native shell is independently visible.
async function requireSelectedVisibleOwner(transport, getSelected = getTargetInfo, expectedId = null) {
  const selected = await getSelected();
  if (!selected?.id || (expectedId && selected.id !== expectedId)) throw new Error('Session-selected chart changed; native tab mutation refused.');
  const targets = (await transport.discoverTargets()).filter(target => isChartTarget(target) || (target.type === 'page' && target.title === 'New tab'));
  if (!targets.some(target => target.id === selected.id)) throw new Error('Session-selected chart is unavailable; native tab mutation refused.');
  const endsAt = Date.now() + CDP_TIMEOUT_MS;
  for (const target of [targets.find(target => target.id === selected.id), ...targets.filter(target => target.id !== selected.id)]) {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) throw new Error('Native tab ownership verification deadline expired');
    const visible = await withCdpDeadline(transport.isTargetVisible(target.id), remaining, 'native tab ownership');
    if (target.id === selected.id && !visible) throw new Error('The session-selected chart is not the visible active tab; native tab mutation refused. Explicitly select the visible chart first.');
    if (target.id !== selected.id && visible) throw new Error('Multiple visible chart targets or landing pages are open; native shell ownership cannot be proven. Tab mutation refused.');
  }
  return selected;
}

/** List chart tabs and new-tab landing pages without changing selection. */
export async function list() {
  const targets = await discoverTargets();
  const tabs = targets.filter(t => isChartTarget(t) || (t.type === 'page' && t.title === 'New tab'))
    .map((target, index) => ({
      index, id: target.id, title: (target.title || '').replace(/^Live stock.*charts on /, ''),
      url: target.url, chart_id: target.url.match(/\/chart\/([^/?]+)/)?.[1] || null, is_chart: isChartTarget(target),
    }));
  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * An already-open picker may be listed, but cannot receive a layout mutation
 * unless it was opened in this operation with verified source-window ownership.
 */
export async function newTab({ layout, name, _deps } = {}) {
  const transport = _deps?.transport || tabTransport;
  const { discoverTargets, withTarget, withShell, isTargetVisible, findLandingTarget } = transport;
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const reconnect = _deps?.reconnectTo || reconnectTo;
  // Check shell ownership even when a landing page already exists. Otherwise
  // reusing that global page would bypass the multiple-window safety guard.
  const ownership = await withShell(evalIn => evalIn(SHELL_TAB_SNAPSHOT));
  requireUniqueActiveTab(ownership);
  let landing = await findLandingTarget();
  if (landing && !await isTargetVisible(landing.id)) throw new Error('The existing new-tab landing page is not the visible active tab; refusing to reuse it.');
  if (landing && layout) throw new Error('Existing landing-page window ownership cannot be proven; refusing layout mutation. Finish or close that picker manually, then call tab_new with layout in one operation.');
  if (!landing) await requireSelectedVisibleOwner(transport, _deps?.getTargetInfo || getTargetInfo);
  let shellCounts = null;

  if (!landing) {
    shellCounts = await withShell(async (evalIn) => {
      const before = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          if (document.visibilityState !== 'visible') return false;
          var btn = document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      await sleep(1500);
      const after = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      return { before, after };
    });
    landing = await findLandingTarget();
  }

  if (!layout) {
    const state = await (_deps?.list || list)();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its landing page target was not found.');
  if (!await isTargetVisible(landing.id)) throw new Error('The new-tab landing page is not visible; layout creation/open refused.');

  // Snapshot existing chart targets so we can spot the one the pick creates.
  const chartIdsBefore = new Set((await discoverTargets()).filter(isChartTarget).map(t => t.id));

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (await evalIn('document.visibilityState') !== 'visible') throw new Error('Landing page visibility changed; layout mutation refused.');
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await sleep(700);
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await sleep(400);
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (t && t.textContent.trim().toLowerCase().indexOf(q) !== -1) {
            items[i].click();
            return t.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await sleep(800);
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // The chart loads under a NEW CDP target: the file:// landing -> https://
  // chart navigation swaps renderer processes, so the target id changes.
  // Wait for a chart target that wasn't there before the pick.
  let chartTarget = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const targets = await discoverTargets();
    const appeared = targets.filter(x => isChartTarget(x) && (!chartIdsBefore.has(x.id) || x.id === landing.id));
    if (appeared.length > 1) throw new Error('Multiple new chart targets appeared; cannot attribute the created tab safely. Select its exact target ID explicitly.');
    chartTarget = appeared[0] || null;
    if (chartTarget) break;
  }
  if (!chartTarget) throw new Error(`Picked "${picked}" but no new chart target appeared.`);

  // Give the chart a moment to boot, then follow it.
  await sleep(2000);
  await reconnect(chartTarget.id);
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTab({ _deps } = {}) {
  const transport = _deps?.transport || tabTransport;
  const { withShell } = transport;
  const selected = await requireSelectedVisibleOwner(transport, _deps?.getTargetInfo || getTargetInfo);
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  return withShell(async evalIn => {
    const snapshot = await evalIn(SHELL_TAB_SNAPSHOT);
    requireUniqueActiveTab(snapshot);
    if (snapshot.count <= 1) throw new Error('Cannot close the last tab.');
    // Recheck visibility immediately before the shell command. The shell
    // command then verifies its active-tab snapshot before clicking anything.
    await requireSelectedVisibleOwner(transport, _deps?.getTargetInfo || getTargetInfo, selected.id);
    const clicked = await evalIn(`(() => {
      if (document.visibilityState !== 'visible') return { error: 'shell-became-hidden' };
      const tabs = Array.from(document.querySelectorAll('.tabs-container .tab'));
      const activeTabs = Array.from(document.querySelectorAll('.tabs-container .tab.active'));
      if (activeTabs.length !== 1) return { error: 'active-tab-ambiguous' };
      const active = activeTabs[0];
      if (tabs.length !== ${snapshot.count} || tabs.indexOf(active) !== ${snapshot.activeIndex}
        || active.outerHTML !== ${JSON.stringify(snapshot.activeSignature)}) return { error: 'active-tab-changed' };
      const close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]');
      if (!close) return { error: 'close-button-missing' };
      close.click();
      return { clicked: true };
    })()`);
    if (!clicked?.clicked) throw new Error(`Active tab could not be closed safely: ${clicked?.error || 'unverified active tab'}`);
    await sleep(1000);
    const after = await evalIn("document.querySelectorAll('.tabs-container .tab').length");
    // Keep the now-closed target pinned: a later call must not silently start
    // operating on whichever chart became active after the close.
    return { success: after === snapshot.count - 1, action: 'tab_closed', target_id: selected.id,
      tabs_before: snapshot.count, tabs_after: after, note: 'Select another target explicitly before further chart operations.' };
  });
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 */
export async function switchTab({ index, _deps }) {
  const transport = _deps?.transport || tabTransport;
  const { withShell, isTargetVisible } = transport;
  const reconnect = _deps?.reconnectTo || reconnectTo;
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const tabs = await (_deps?.list || list)();
  const idx = Number(index);

  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  if (!(await isTargetVisible(target.id))) {
    await requireSelectedVisibleOwner(transport, _deps?.getTargetInfo || getTargetInfo);
    const clicked = await withShell(async (evalIn) => {
      requireUniqueActiveTab(await evalIn(SHELL_TAB_SNAPSHOT));
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      // Try the same ordinal first (shell order usually matches), then the rest.
      const order = [...new Set([Math.min(idx, count - 1), ...Array.from({ length: count }, (_, k) => k)])];
      for (const k of order) {
        await evalIn(`(() => { if (document.visibilityState !== 'visible') throw new Error('Native shell became hidden; tab switch refused'); const tab = document.querySelectorAll('.tabs-container .tab')[${k}]; if (!tab) throw new Error('Tab list changed'); tab.click(); return true; })()`);
        await sleep(400);
        if (await isTargetVisible(target.id)) return k;
      }
      return null;
    });
    if (clicked === null) {
      throw new Error(`Clicked through all shell tabs but chart ${target.chart_id} never became visible.`);
    }
  }

  // Re-attach the cached CDP client so subsequent reads follow the switch.
  try {
    await reconnect(target.id);
  } catch (e) {
    throw new Error(`Tab is visible but failed to re-attach CDP to it: ${e.message}`);
  }

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id, visually_switched: true };
}
