/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import {
  getClient as _getClient,
  CDP_HOST,
  CDP_PORT,
  fetchWithTimeout as _fetchWithTimeout,
  disconnect as _disconnect,
  reconnect as _reconnect,
} from '../connection.js';

function _resolve(deps) {
  return {
    getClient: deps?.getClient || _getClient,
    fetchWithTimeout: deps?.fetchWithTimeout || _fetchWithTimeout,
    disconnect: deps?.disconnect || _disconnect,
    reconnect: deps?.reconnect || _reconnect,
  };
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list({ _deps } = {}) {
  const { fetchWithTimeout } = _resolve(_deps);
  const resp = await fetchWithTimeout(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
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
export async function newTab({ _deps } = {}) {
  const { getClient } = _resolve(_deps);
  const before = await list({ _deps });

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

  // Poll the tab list until the count increases (bounded), instead of a fixed sleep.
  const state = await waitForTabCount(c => c > before.tab_count, { _deps });
  if (!state) {
    throw new Error('New tab did not appear within the expected time');
  }
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Poll list() until predicate(tab_count) is true or attempts are exhausted.
 * Returns the latest list() state when the predicate matches, otherwise null.
 */
async function waitForTabCount(predicate, { attempts = 20, intervalMs = 200, _deps } = {}) {
  for (let i = 0; i < attempts; i++) {
    const state = await list({ _deps });
    if (predicate(state.tab_count)) return state;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab({ _deps } = {}) {
  const { getClient } = _resolve(_deps);
  const before = await list({ _deps });
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

  // Poll the tab list until the count decreases (bounded). If it never changes
  // within the bound, fall back to the latest observed state (conservative —
  // a stuck close-confirmation dialog should not throw).
  const after = (await waitForTabCount(c => c < before.tab_count, { _deps })) || (await list({ _deps }));
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index, _deps }) {
  const { fetchWithTimeout, disconnect, reconnect } = _resolve(_deps);
  const tabs = await list({ _deps });
  const idx = Number(index);

  // Guard both bounds and non-integers BEFORE indexing tabs.tabs[idx]; a
  // negative/NaN/fractional index otherwise reads `undefined` and throws an
  // opaque `Cannot read properties of undefined (reading 'id')` deeper down.
  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Bring the tab to the foreground via the CDP HTTP activate endpoint.
  try {
    const resp = await fetchWithTimeout(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    await resp.text();
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }

  // Activating the tab in the UI does NOT migrate the cached CDP session, which
  // stays bound to the previous target. Rebuild it against the new target id so
  // every subsequent tool call (chart_get_state, quote_get, …) hits this tab.
  await disconnect();
  await reconnect(target.id);

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
}
