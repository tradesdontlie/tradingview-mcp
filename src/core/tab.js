/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * Open a new TradingView chart tab by evaluating window.open() in an
 * existing chart tab's renderer. TradingView Desktop's Electron host
 * intercepts same-origin opens and creates a new in-app tab — no menu
 * shortcut, no keystroke injection, no Accessibility permission needed.
 *
 * (CDP's Input.dispatchKeyEvent can't trigger Electron menu shortcuts
 * like Cmd+T, and AppleScript System Events requires the parent process
 * to be granted Accessibility, which is fragile for a daemon.)
 */
async function openNewTabViaJS(existingTargetId) {
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: existingTargetId });
  try {
    await c.Runtime.enable();
    await c.Runtime.evaluate({
      expression: `window.open('https://www.tradingview.com/chart/', '_blank')`,
      returnByValue: true,
    });
  } finally {
    try { await c.close(); } catch {}
  }
}

// Marker placed on the document.title of the MCP-dedicated tab.
// Visible via CDP /json/list without needing to attach.
export const DEDICATED_TITLE_PREFIX = '[MCP] ';

/**
 * Inline JS that marks a tab as MCP-dedicated and keeps the title prefix
 * sticky against TradingView's own title updates.
 */
const MARKER_JS = `
  (function(){
    window.__MCP_DEDICATED = true;
    var prefix = ${JSON.stringify(DEDICATED_TITLE_PREFIX)};
    function apply() {
      if (typeof document.title === 'string' && document.title.indexOf(prefix) !== 0) {
        document.title = prefix + document.title;
      }
    }
    apply();
    // MutationObserver on the <title> node fires synchronously whenever
    // TradingView overwrites the title (every few seconds with the ticker
    // and price), so the prefix is restored instantly. A periodic timer
    // can't keep up — TV's updates race in between ticks.
    if (!window.__MCP_TITLE_OBSERVER) {
      var titleEl = document.querySelector('title');
      if (titleEl) {
        var obs = new MutationObserver(apply);
        obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
        window.__MCP_TITLE_OBSERVER = obs;
      }
      // Belt-and-suspenders: a 2s timer in case <title> is replaced wholesale
      // (which would detach our observer).
      window.__MCP_TITLE_INTERVAL = setInterval(function(){
        var cur = document.querySelector('title');
        if (cur && cur !== window.__MCP_TITLE_OBSERVER_NODE) {
          window.__MCP_TITLE_OBSERVER_NODE = cur;
          try { window.__MCP_TITLE_OBSERVER && window.__MCP_TITLE_OBSERVER.disconnect(); } catch(e){}
          var o = new MutationObserver(apply);
          o.observe(cur, { childList: true, characterData: true, subtree: true });
          window.__MCP_TITLE_OBSERVER = o;
        }
        apply();
      }, 2000);
    }
    return { marked: true, title: document.title };
  })()
`;

async function listChartTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

export function isDedicatedTarget(target) {
  return !!(target && typeof target.title === 'string' && target.title.startsWith(DEDICATED_TITLE_PREFIX));
}

/** Find the existing dedicated tab, if any. */
export async function findDedicatedTarget() {
  const charts = await listChartTargets();
  return charts.find(isDedicatedTarget) || null;
}

/**
 * Attach to a specific target by id, evaluate an expression, then disconnect.
 * Used to mark a freshly-opened tab without disturbing the connection module's
 * cached client.
 */
async function evaluateOnTarget(targetId, expression) {
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
  try {
    await c.Runtime.enable();
    const result = await c.Runtime.evaluate({ expression, returnByValue: true });
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'eval error';
      throw new Error(msg);
    }
    return result.result?.value;
  } finally {
    try { await c.close(); } catch {}
  }
}

/**
 * Ensure an MCP-dedicated tab exists. Returns the dedicated target object.
 *
 * If one already exists (title starts with [MCP] ), returns it untouched.
 * Otherwise opens a new chart tab via Cmd+T (TV Desktop) on an existing
 * tab's CDP client, waits for it to load tradingview.com/chart, then marks
 * its document.title.
 */
export async function ensureDedicated() {
  const existing = await findDedicatedTarget();
  if (existing) return { success: true, action: 'reused', target: existing };

  const before = await listChartTargets();
  if (before.length === 0) {
    throw new Error('No TradingView chart tab is open. Open TradingView Desktop first.');
  }

  // Open a new tab via window.open() in an existing tab's JS context.
  // Electron's host intercepts same-origin opens and creates a new in-app
  // tab — no keystroke or Accessibility permission required.
  await openNewTabViaJS(before[0].id);

  // Wait for a new chart target to appear with a tradingview.com/chart URL.
  const beforeIds = new Set(before.map(t => t.id));
  const deadline = Date.now() + 15000;
  let newTarget = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const charts = await listChartTargets();
    newTarget = charts.find(t => !beforeIds.has(t.id));
    if (newTarget) break;
  }
  if (!newTarget) {
    throw new Error('New chart tab did not appear after window.open(). Is TradingView Desktop responsive?');
  }

  // Give the page a moment to mount its document before we touch the title.
  await new Promise(r => setTimeout(r, 500));
  await evaluateOnTarget(newTarget.id, MARKER_JS);

  // Refresh the target info so the returned object reflects the new title.
  const charts = await listChartTargets();
  const marked = charts.find(t => t.id === newTarget.id) || newTarget;
  return { success: true, action: 'created', target: marked };
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Use CDP Target.activateTarget to bring the tab to front
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    const text = await resp.text();
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
