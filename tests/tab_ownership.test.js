import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { closeTab, newTab, switchTab, createTabTransport } from '../src/core/tab.js';

function twoTabs() {
  const state = { activeId: 'b', shellVisibility: 'visible', closed: [], shellCalls: 0, beforeEvaluate: null };
  const makeTab = id => ({
    id,
    get outerHTML() { return `<div data-id="${id}" class="tab${state.activeId === id ? ' active' : ''}"></div>`; },
    querySelector: () => ({ click: () => { state.closed.push(id); state.tabs = state.tabs.filter(tab => tab.id !== id); } }),
  });
  state.tabs = [makeTab('a'), makeTab('b')];
  const document = { get visibilityState() { return state.shellVisibility; }, querySelectorAll: selector => selector.endsWith('.tab.active')
    ? state.tabs.filter(tab => tab.id === state.activeId) : state.tabs };
  const transport = {
    discoverTargets: async () => ['a', 'b'].map(id => ({ id, type: 'page', url: `https://www.tradingview.com/chart/${id}/` })),
    findLandingTarget: async () => null,
    isTargetVisible: async targetId => targetId === state.activeId,
    withShell: async callback => {
      state.shellCalls++;
      return callback(async expression => {
        state.beforeEvaluate?.(expression);
        return vm.runInNewContext(expression, { document });
      });
    },
  };
  return { state, transport };
}

it('a session bound to hidden chart A cannot close visible chart B in the same shell', async () => {
  const { state, transport } = twoTabs();
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /session-selected chart is not the visible active tab/);
  assert.deepEqual(state.closed, []);
  assert.equal(state.shellCalls, 0, 'the shell mutation callback must not even start');
  assert.equal(state.tabs.length, 2);
});

it('closes only the selected visible chart and leaves the other chart intact', async () => {
  const { state, transport } = twoTabs();
  const result = await closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'b' }), sleep: async () => {},
  } });
  assert.equal(result.success, true);
  assert.equal(result.target_id, 'b');
  assert.deepEqual(state.closed, ['b']);
  assert.deepEqual(state.tabs.map(tab => tab.id), ['a']);
  assert.match(result.note, /Select another target explicitly/);
});

it('never falls back to the first tab when the shell has no unique active tab', async () => {
  const { state, transport } = twoTabs();
  state.activeId = null;
  transport.isTargetVisible = async id => id === 'a';
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /unique active shell tab/);
  assert.deepEqual(state.closed, []);
});

it('refuses the close if the active shell tab changed after the selected-target visibility check', async () => {
  const { state, transport } = twoTabs();
  state.beforeEvaluate = expression => {
    if (expression.includes('const activeTabs')) state.activeId = 'a';
  };
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'b' }), sleep: async () => {},
  } }), /active-tab-changed/);
  assert.deepEqual(state.closed, []);
});

const shell = id => ({ id, type: 'page', url: `file:///TradingView/app/window/index.html?window=${id}` });
const landing = id => ({ id, type: 'page', url: 'file:///TradingView/app/chart/index.html', title: 'New tab' });

function landingTransport(targets, visibility = 'visible') {
  let clicks = 0;
  const transport = createTabTransport({
    timeoutMs: 100,
    fetch: async () => ({ ok: true, json: async () => targets }),
    cdp: async () => ({
      Runtime: { evaluate: async ({ expression }) => {
        if (expression.includes('.click(')) clicks++;
        const value = expression.startsWith('!!') ? true
          : expression === 'document.visibilityState' ? visibility
            : { shellVisible: true, count: 2, activeCount: 1, activeIndex: 1, activeSignature: '<div class="tab active">New tab</div>' };
        return { result: { value } };
      } }, close: async () => {},
    }),
  });
  return { transport, get clicks() { return clicks; } };
}

it('an existing landing page cannot bypass the multiple-shell ownership guard', async () => {
  const h = landingTransport([shell('one'), shell('two'), landing('picker')]);
  await assert.rejects(newTab({ layout: 'new', _deps: { transport: h.transport } }), /Multiple TradingView shell tab bars/);
  assert.equal(h.clicks, 0);
});

it('refuses to reuse the first of multiple new-tab landing pages', async () => {
  const h = landingTransport([shell('one'), landing('picker-a'), landing('picker-b')]);
  await assert.rejects(newTab({ layout: 'new', _deps: { transport: h.transport } }), /Multiple new-tab landing pages/);
  assert.equal(h.clicks, 0);
});

it('does not operate a hidden existing landing page even in a single shell', async () => {
  const h = landingTransport([shell('one'), landing('picker')], 'hidden');
  await assert.rejects(newTab({ layout: 'new', _deps: { transport: h.transport } }), /not the visible active tab/);
  assert.equal(h.clicks, 0);
});

it('may reuse one visible landing page after proving a unique active shell', async () => {
  const h = landingTransport([shell('one'), landing('picker')]);
  const result = await newTab({ _deps: { transport: h.transport, list: async () => ({ tab_count: 2, tabs: [] }) } });
  assert.equal(result.success, true);
  assert.equal(result.action, 'new_tab_opened');
  assert.equal(h.clicks, 0, 'reusing the picker without a layout is not a mutation');
});

it('refuses to close the ordinary active tab when selected A is a visible popout and B is also visible', async () => {
  const { state, transport } = twoTabs();
  transport.isTargetVisible = async () => true;
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /Multiple visible chart targets/);
  assert.equal(state.shellCalls, 0);
  assert.deepEqual(state.closed, []);
});

it('refuses to close a hidden ordinary shell while the selected popout alone is visible', async () => {
  const { state, transport } = twoTabs();
  state.shellVisibility = 'hidden';
  transport.isTargetVisible = async id => id === 'a';
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /native shell tab bar is not visible/);
  assert.deepEqual(state.closed, []);
});

it('does not create a tab through an unrelated shell when a selected popout and ordinary chart are both visible', async () => {
  const { state, transport } = twoTabs();
  transport.isTargetVisible = async () => true;
  let attemptedClick = false;
  state.beforeEvaluate = expression => { if (expression.includes('.click(')) attemptedClick = true; };
  await assert.rejects(newTab({ layout: 'new', _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /Multiple visible chart targets/);
  assert.equal(attemptedClick, false);
});

it('does not switch shell tabs when the selected popout cannot be associated with the ordinary visible chart', async () => {
  const { state, transport } = twoTabs();
  transport.discoverTargets = async () => ['a', 'b', 'c'].map(id => ({ id, type: 'page', url: `https://www.tradingview.com/chart/${id}/` }));
  transport.isTargetVisible = async id => id !== 'c';
  await assert.rejects(switchTab({ index: 2, _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
    list: async () => ({ tab_count: 3, tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
  } }), /Multiple visible chart targets/);
  assert.equal(state.shellCalls, 0);
  assert.deepEqual(state.closed, []);
});

it('does not mutate an unowned existing picker even when the only visible chart is a selected popout', async () => {
  const h = landingTransport([shell('ordinary'), landing('picker'), { id: 'popout', type: 'page', url: 'https://www.tradingview.com/chart/popout/' }]);
  await assert.rejects(newTab({ layout: 'new', _deps: {
    transport: h.transport, getTargetInfo: async () => ({ id: 'popout' }),
  } }), /Existing landing-page window ownership cannot be proven/);
  assert.equal(h.clicks, 0);
});

it('checks shell visibility again at the destructive click after its snapshot', async () => {
  const { state, transport } = twoTabs();
  state.beforeEvaluate = expression => {
    if (expression.includes('const activeTabs')) state.shellVisibility = 'hidden';
  };
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'b' }), sleep: async () => {},
  } }), /shell-became-hidden/);
  assert.deepEqual(state.closed, []);
});

it('does not close an unrelated visible picker when the selected popout is the only visible chart', async () => {
  const { state, transport } = twoTabs();
  transport.discoverTargets = async () => [
    { id: 'a', type: 'page', url: 'https://www.tradingview.com/chart/a/' },
    landing('picker'),
  ];
  transport.isTargetVisible = async () => true;
  await assert.rejects(closeTab({ _deps: {
    transport, getTargetInfo: async () => ({ id: 'a' }), sleep: async () => {},
  } }), /Multiple visible chart targets or landing pages/);
  assert.equal(state.shellCalls, 0);
  assert.deepEqual(state.closed, []);
});
