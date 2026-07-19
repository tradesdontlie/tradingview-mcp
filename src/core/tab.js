/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

async function listPageTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.filter(t => t.type === 'page');
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const targets = await listPageTargets();

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
 * Open a new tab by clicking the tab bar's "+" button in the window host page.
 * Synthetic Cmd+T via CDP does NOT work — Electron menu accelerators live in the
 * main process and never see renderer-level Input.dispatchKeyEvent.
 */
export async function newTab() {
  const before = await listPageTargets();
  const host = before.find(t => /app\/window\/index\.html/.test(t.url));
  if (!host) throw new Error('TradingView window host target not found. Is TradingView Desktop running with --remote-debugging-port?');

  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: host.id });
  try {
    await c.Runtime.enable();
    const r = await c.Runtime.evaluate({
      expression: `(function(){var b=document.querySelector('.create-new-tab-button');if(!b)return false;b.click();return true;})()`,
      returnByValue: true,
    });
    if (r.exceptionDetails || !r.result?.value) {
      throw new Error('create-new-tab-button not found in TradingView window host');
    }
  } finally {
    await c.close().catch(() => {});
  }

  // Only report success once the new target is verifiably present
  const beforeIds = new Set(before.map(t => t.id));
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const now = await listPageTargets();
    const added = now.find(t => !beforeIds.has(t.id) && /app\/new-tab\/|tradingview\.com\/chart/i.test(t.url));
    if (added) {
      const state = await list();
      return {
        success: true,
        action: 'new_tab_opened',
        new_target: { id: added.id, url: added.url },
        note: /app\/new-tab\//.test(added.url)
          ? 'New tab opened on the start screen — it becomes a chart tab once a chart is selected.'
          : undefined,
        ...state,
      };
    }
  }
  throw new Error('New tab did not appear within 5s of clicking the tab bar "+" button');
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
