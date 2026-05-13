#!/usr/bin/env node
// Live verification of the mcp-fixes-2026-05-13 branch.
// Bypasses the MCP wire format and exercises the fixed core modules directly
// against the running TradingView Desktop on CDP port 9222.
//
// Expectations (from earlier DOM scrape against the same SMA-cross strategy):
//   Total P&L      ≈ +$15,437 (+1.54%)
//   Total trades   = 748
//   Profit factor  = 1.172
//   Max equity DD  = 7,256
//   Profitable %   = 33.29
//
// If data_get_strategy_results returns metrics matching the DOM values,
// the fix works end-to-end. Run from repo root: `node scripts/live-verify-fixes.mjs`

import { getStrategyResults, getTrades, getEquity } from '../src/core/data.js';
import { uiState, healthCheck } from '../src/core/health.js';
import { detectStrategyTester } from '../src/core/ui.js';
import { evaluate as cdpEval } from '../src/connection.js';

function section(title) {
  console.log('\n' + '─'.repeat(70));
  console.log(' ' + title);
  console.log('─'.repeat(70));
}

function ok(label) { console.log(`  ✔ ${label}`); }
function fail(label, detail) { console.log(`  ✘ ${label}${detail ? ' — ' + detail : ''}`); }

(async () => {
  let allOk = true;

  section('1. healthCheck — CDP + chart attach');
  try {
    const h = await healthCheck();
    if (h.success && h.cdp_connected) {
      ok(`CDP connected → ${h.chart_symbol} @ ${h.chart_resolution}`);
    } else {
      fail('healthCheck did not return success');
      allOk = false;
    }
  } catch (e) {
    fail('healthCheck threw', e.message);
    allOk = false;
  }

  section('2. detectStrategyTester (Agent F helper)');
  try {
    const st = await detectStrategyTester();
    if (st.open) ok(`open=true via signals: ${st.signals.join(', ')}`);
    else { fail(`open=false, tried: ${JSON.stringify(st.tried)}`); allOk = false; }
  } catch (e) {
    fail('detectStrategyTester threw', e.message);
    allOk = false;
  }

  section('3. uiState — strategy_tester.open (B6/B10 wire-up)');
  try {
    const u = await uiState();
    if (u.strategy_tester?.open) {
      ok(`strategy_tester.open=true, signals: ${(u.strategy_tester.signals || []).join(', ')}`);
    } else {
      fail(`strategy_tester.open=${u.strategy_tester?.open}`);
      allOk = false;
    }
  } catch (e) {
    fail('uiState threw', e.message);
    allOk = false;
  }

  section('3b. Direct probe: scrape via raw cdpEval');
  try {
    const raw = await cdpEval(`(function() {
      var root = document.querySelector('[class*="backtestingReport"]') || document.querySelector('[class*="reportContainer"]');
      if (!root) return { found: false, error: 'no root' };
      var cards = root.querySelectorAll('[class*="containerCell"]');
      var metrics = {};
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var lbl = card.querySelector('[class*="title"]');
        var val = card.querySelector('[class*="value"]');
        if (!lbl || !val) continue;
        var L = (lbl.textContent || '').trim();
        var V = (val.textContent || '').trim();
        if (L && V) metrics[L] = V;
      }
      return { found: true, card_count: cards.length, metrics: metrics };
    })()`);
    console.log('  raw probe via cdpEval:', JSON.stringify(raw));
  } catch (e) { console.log('  raw probe threw:', e.message); }

  section('4. getStrategyResults (B2 — DOM fallback)');
  try {
    const r = await getStrategyResults();
    console.log('  raw response:', JSON.stringify(r, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    if (r.success !== false && (r.metric_count > 0 || (r.metrics && Object.keys(r.metrics).length > 0))) {
      ok(`source=${r.source}, metric_count=${r.metric_count || Object.keys(r.metrics).length}`);
    } else {
      fail('returned empty/failed result');
      allOk = false;
    }
  } catch (e) {
    fail('getStrategyResults threw', e.message);
    allOk = false;
  }

  section('5. getTrades (B3 — DOM fallback)');
  try {
    const t = await getTrades({ max_trades: 5 });
    console.log('  raw response keys:', Object.keys(t).join(', '));
    console.log('  source:', t.source, 'trade_count:', t.trade_count, 'first trade:', JSON.stringify(t.trades?.[0] || null));
    if (t.success !== false && t.trade_count > 0) ok(`source=${t.source}, ${t.trade_count} trades`);
    else { fail(`trade_count=${t.trade_count}, error=${t.error || 'none'}`); allOk = false; }
  } catch (e) {
    fail('getTrades threw', e.message);
    allOk = false;
  }

  section('6. getEquity (B4 — DOM fallback / summary)');
  try {
    const e = await getEquity();
    console.log('  source:', e.source, 'data_points:', e.data_points, 'equity_summary:', JSON.stringify(e.equity_summary || null));
    if (e.success !== false) ok(`source=${e.source}, data_points=${e.data_points}`);
    else { fail(`failed: ${e.error || 'unknown'}`); allOk = false; }
  } catch (err) {
    fail('getEquity threw', err.message);
    allOk = false;
  }

  section('VERDICT');
  if (allOk) console.log('  ✔ All checks passed.');
  else console.log('  ✘ One or more checks failed — see details above.');

  process.exit(allOk ? 0 : 1);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
