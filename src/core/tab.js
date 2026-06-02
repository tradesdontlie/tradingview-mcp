/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate, setDedicatedTab, disconnect } from '../connection.js';

function _resolve(deps) {
  return {
    CDP: deps?.CDP || CDP,
    setDedicatedTab: deps?.setDedicatedTab || setDedicatedTab,
    disconnect: deps?.disconnect || disconnect,
  };
}

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

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
 * Switch to a tab by index.
 * Uses Page.bringToFront (not just HTTP /json/activate) so the painted foreground
 * actually changes in Electron. Updates the dedicated tab singleton so subsequent
 * getClient() calls reconnect to this tab.
 */
export async function switchTab({ index, _deps } = {}) {
  const { CDP: cdp, setDedicatedTab: setTab, disconnect: disc } = _resolve(_deps);

  const listFn = _deps?.list || list;
  const tabs = await listFn();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Open a temporary CDP client for this target to call Page.bringToFront
  const tempClient = await cdp({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  try {
    await tempClient.Page.enable();
    await tempClient.Page.bringToFront();
  } finally {
    try { await tempClient.close(); } catch {}
  }

  // Rebind the singleton so all subsequent evaluate/getClient calls target this tab
  setTab(target.id);
  // Force a reconnect on the next getClient() call
  await disc();

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
}
