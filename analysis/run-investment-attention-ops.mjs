import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectInboxOnce,
  collectorSourceBindings,
} from '../src/core/investment-attention-collector.js';
import {
  assessInvestmentAttentionAlertHealth,
  buildInvestmentAttentionWeeklyReview,
  buildRouteCoverageReceipt,
  writeInvestmentAttentionHealthReceipt,
} from '../src/core/investment-attention-health.js';
import { DEFAULT_ATTENTION_INBOX_PATH, DEFAULT_ATTENTION_STATE_DIR } from '../src/core/investment-attention-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = resolve(repoRoot, 'analysis/runtime');
const inboxPath = DEFAULT_ATTENTION_INBOX_PATH;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function weekBounds(now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const day = end.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  end.setUTCDate(end.getUTCDate() - daysSinceMonday);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

const collected = await collectInboxOnce({
  stateDir,
  inboxPath,
  sourceBindings: collectorSourceBindings(),
});
const routeCoverage = buildRouteCoverageReceipt({
  readings: readJson(resolve(stateDir, 'route-readings-input.json'), []),
});
const alertInput = readJson(resolve(stateDir, 'alert-health-input.json'), {
  expected_alerts: [],
  active_alerts: [],
  excluded_routes: [],
});
const alertHealth = assessInvestmentAttentionAlertHealth({
  expectedAlerts: alertInput.expected_alerts ?? alertInput.expectedAlerts ?? [],
  activeAlerts: alertInput.active_alerts ?? alertInput.activeAlerts ?? [],
  excludedRoutes: alertInput.excluded_routes ?? alertInput.excludedRoutes ?? [],
  collectorHeartbeat: collected,
});
writeInvestmentAttentionHealthReceipt(stateDir, 'route-coverage.json', routeCoverage);
writeInvestmentAttentionHealthReceipt(stateDir, 'alert-health.json', alertHealth);

const bounds = weekBounds();
const weeklyReview = buildInvestmentAttentionWeeklyReview({
  stateDir,
  weekStart: bounds.start,
  weekEnd: bounds.end,
  familyCanaries: readJson(resolve(stateDir, 'family-canaries.json'), []),
  missSampling: readJson(resolve(stateDir, 'miss-sampling.json'), { passed: false, candidates: [] }),
  health: alertHealth,
});
writeInvestmentAttentionHealthReceipt(stateDir, 'weekly-review.json', weeklyReview);

const result = {
  schema_version: 'investment-attention-ops-run/v1',
  ran_at: new Date().toISOString(),
  source: 'local_inbox_and_persisted_live_snapshot',
  collector: collected,
  route_coverage: {
    healthy: routeCoverage.healthy,
    expected: routeCoverage.expected_route_count,
    available: routeCoverage.available_route_count,
    warm: routeCoverage.warm_route_count,
    action_count: routeCoverage.missing_routes.length
      + routeCoverage.warming_routes.length
      + routeCoverage.invalid_exclusions.length
      + routeCoverage.unexpected_readings.length,
  },
  alert_health: {
    healthy: alertHealth.healthy,
    action_count: alertHealth.action_required.length,
  },
  weekly_review: {
    status: weeklyReview.status,
    complete: weeklyReview.complete,
    week_start: weeklyReview.week_start,
    week_end: weeklyReview.week_end,
  },
  limitation: 'This local job cannot authenticate to TradingView or publish a webhook. Run node analysis/refresh-investment-attention-live-snapshot.mjs from an authenticated TradingView Desktop session to refresh the live inventory and source/version hashes; this job only processes the persisted snapshot, local inbox, ledger, and reports.',
};
console.log(JSON.stringify(result));
