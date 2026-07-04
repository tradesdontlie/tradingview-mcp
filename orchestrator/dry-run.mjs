#!/usr/bin/env node
/**
 * Deterministic dry-run — exercises the cycle's data + decision machinery (the
 * agent's tools) WITHOUT the model, an API key, or any write to the live config.
 * Win%/expectancy comes from the live-model trade logs (futures live ledger when
 * it has ≥ MIN_SAMPLE retained trades, else the confluence-bot backtest).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readResolvedTrades, ledgerTradesNormalized } from './lib/ledger.mjs';
import { readBacktestTrades } from './lib/backtest.mjs';
import { readEvents, summarizeEvents } from './lib/events.mjs';
import { estimatePerformance } from './lib/estimate.mjs';
import { validateProposal } from './lib/guardrails.mjs';
import { UNIVERSE, THRESHOLDS } from './config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  config: join(ROOT, 'orchestrator_config.json'),
  ledger: join(ROOT, 'trade_ledger.jsonl'),
  events: join(ROOT, 'bot_events.jsonl'),
  backtestSpot: join(ROOT, 'backtest_results.json'),
  backtestFutures: join(ROOT, 'backtest_futures_results.json'),
};
const windowMs = Date.now() - THRESHOLDS.EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const cfg = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, 'utf8')) : {};
const ledgerTrades = ledgerTradesNormalized(readResolvedTrades(paths.ledger, { sinceMs: windowMs }));
const backtest = { spot: readBacktestTrades(paths.backtestSpot), futures: readBacktestTrades(paths.backtestFutures) };
const events = summarizeEvents(readEvents(paths.events, { sinceMs: windowMs }));

console.log('=== INPUTS ===');
console.log(`futures live ledger trades (≥${THRESHOLDS.EVAL_WINDOW_DAYS}d): ${ledgerTrades.length}`);
console.log(`backtest trades — spot: ${backtest.spot.length}, futures: ${backtest.futures.length}`);
console.log(`events in window: ${events.total} (${JSON.stringify(events.bySeverity)})`);

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const r = (x) => (x == null ? 'n/a' : x.toFixed(2) + 'R');

for (const bot of ['spot', 'futures']) {
  const current = cfg[bot] ?? {};
  const trades = { ledgerTrades: bot === 'futures' ? ledgerTrades : [], backtestTrades: backtest[bot] };
  console.log(`\n=== ${bot.toUpperCase()} ===`);

  const baseEst = estimatePerformance(current, trades);
  console.log(`baseline (current config): win%=${pct(baseEst.winRate)} expectancy=${r(baseEst.expectancy)} sample=${baseEst.sample} (source: ${baseEst.source})`);
  const reaffirm = validateProposal({ bot, current, candidate: current, estimate: baseEst });
  console.log(`re-affirm current → ${reaffirm.classification}`);

  // Sweep every single strategy toggle (one change each), estimate via trade-log
  // replay, run through the guardrails, and rank: auto-eligible first.
  const rank = { auto: 0, approval: 1, reject: 2 };
  const rows = [];
  for (const s of UNIVERSE[bot].strategies) {
    const set = new Set(current.active_strategies ?? []);
    const dir = set.has(s) ? 'disable' : 'enable';
    if (set.has(s)) set.delete(s); else set.add(s);
    const candidate = { ...current, active_strategies: [...set] };
    const est = estimatePerformance(candidate, trades);
    const v = validateProposal({ bot, current, candidate, estimate: est });
    rows.push({ label: `${dir} ${s}`, est, v });
  }
  rows.sort((a, b) => (rank[a.v.classification] - rank[b.v.classification]) || ((b.est.winRate ?? 0) - (a.est.winRate ?? 0)));

  console.log('strategy toggles (one change each):');
  for (const { label, est, v } of rows) {
    const why = v.violations.length ? `  [${v.violations.join('; ')}]` : '';
    console.log(`  ${label.padEnd(26)} win%=${pct(est.winRate)} exp=${r(est.expectancy)} n=${est.sample} → ${v.classification.toUpperCase()}${why}`);
  }
  console.log(`filter toggles (${UNIVERSE[bot].filters.join(', ')}): effect NOT measurable offline —`);
  console.log('  the backtest baked in whichever filters were on; regenerate a backtest with the filter toggled to measure its impact.');
}

console.log(`\n(no live config written — deterministic dry-run; universe: ` +
  `spot ${UNIVERSE.spot.strategies.length}str/${UNIVERSE.spot.filters.length}flt, ` +
  `futures ${UNIVERSE.futures.strategies.length}str/${UNIVERSE.futures.filters.length}flt)`);
