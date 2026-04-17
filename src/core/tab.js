/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import {
  CDP_HOST,
  CDP_PORT,
  getClient as _getClient,
  setCurrentTarget as _setCurrentTarget,
  getCurrentTargetId as _getCurrentTargetId,
} from '../connection.js';

function _resolve(deps) {
  return {
    fetchFn: deps?.fetch || ((...args) => fetch(...args)),
    getClient: deps?.getClient || _getClient,
    setCurrentTarget: deps?.setCurrentTarget || _setCurrentTarget,
    getCurrentTargetId: deps?.getCurrentTargetId || _getCurrentTargetId,
  };
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list({ _deps } = {}) {
  const { fetchFn } = _resolve(_deps);
  const resp = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: (t.title || '').replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab({ _deps } = {}) {
  const { getClient, setCurrentTarget } = _resolve(_deps);
  const [before, c] = await Promise.all([list({ _deps }), getClient()]);

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

  const after = await list({ _deps });
  const beforeIds = new Set(before.tabs.map(t => t.id));
  const newlyAdded = after.tabs.filter(t => !beforeIds.has(t.id));
  setCurrentTarget(newlyAdded.length === 1 ? newlyAdded[0].id : null);

  return { success: true, action: 'new_tab_opened', ...after };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab({ _deps } = {}) {
  const { getClient, setCurrentTarget, getCurrentTargetId } = _resolve(_deps);
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

  await new Promise(r => setTimeout(r, 1000));

  const after = await list({ _deps });
  const pinnedId = getCurrentTargetId();
  if (pinnedId && !after.tabs.some(t => t.id === pinnedId)) {
    setCurrentTarget(null);
  }

  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. The next getClient() rebinds the CDP websocket
 * to the new target — reads after this come from the switched tab.
 */
export async function switchTab({ index, _deps } = {}) {
  const { fetchFn, setCurrentTarget } = _resolve(_deps);
  const tabs = await list({ _deps });
  const idx = Number(index);

  if (!Number.isFinite(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  let resp;
  try {
    resp = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to activate tab ${idx}: HTTP ${resp.status}`);
  }

  setCurrentTarget(target.id);
  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
}
