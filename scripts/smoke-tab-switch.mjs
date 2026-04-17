#!/usr/bin/env node
/**
 * Live smoke test for the tab_switch CDP rebinding fix.
 *
 * Requires TradingView running on localhost:9222 with >=2 chart tabs.
 * Run from the worktree: node scripts/smoke-tab-switch.mjs
 *
 * Asserts: after switchTab(i), getState() returns data bound to the same tab.
 */
import { list, switchTab } from '../src/core/tab.js';
import { getState } from '../src/core/chart.js';
import { disconnect, getCurrentTargetId } from '../src/connection.js';

const pass = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg, extra) => { console.log(`  FAIL ${msg}`); if (extra) console.log(extra); process.exitCode = 1; };

(async () => {
  const tabs = (await list()).tabs;
  console.log(`found ${tabs.length} chart tabs`);
  if (tabs.length < 2) {
    console.log('need at least 2 tabs for this test — open more and re-run');
    process.exit(2);
  }

  const results = [];
  for (let i = 0; i < tabs.length; i++) {
    await switchTab({ index: i });
    const pinned = getCurrentTargetId();
    if (pinned !== tabs[i].id) {
      fail(`switchTab(${i}) did not pin target ${tabs[i].id.slice(0, 8)} (pin=${pinned})`);
      continue;
    }
    pass(`switchTab(${i}) pinned ${pinned.slice(0, 8)}`);

    const state = await getState();
    results.push({ index: i, tab_id: tabs[i].id, symbol: state.symbol, resolution: state.resolution });
  }

  console.log('\nPer-tab reads:');
  for (const r of results) {
    console.log(`  tab ${r.index} (${r.tab_id.slice(0, 8)}): ${r.symbol} @ ${r.resolution}`);
  }

  const uniqueSymbols = new Set(results.map(r => `${r.symbol}@${r.resolution}`));
  if (uniqueSymbols.size === 1 && results.length > 1) {
    fail(`all tabs returned identical state "${[...uniqueSymbols][0]}" — fix did not rebind CDP`);
  } else {
    pass(`got ${uniqueSymbols.size} distinct states across ${results.length} tabs`);
  }

  await disconnect();
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('smoke test crashed:', e);
  process.exit(3);
});
