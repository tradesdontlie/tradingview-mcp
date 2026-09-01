import { existsSync, readFileSync } from 'node:fs';
import { register } from '../router.js';
import {
  DEFAULT_ATTENTION_INBOX_PATH,
  DEFAULT_ATTENTION_STATE_DIR,
} from '../../core/investment-attention-config.js';
import {
  collectInboxOnce,
  collectorSourceBindings,
} from '../../core/investment-attention-collector.js';
import {
  assessInvestmentAttentionAlertHealth,
  buildInvestmentAttentionWeeklyReview,
  buildRouteCoverageReceipt,
  readInvestmentAttentionReceipt,
  writeInvestmentAttentionHealthReceipt,
} from '../../core/investment-attention-health.js';
import { queryInvestmentAttention } from '../../core/investment-attention-query.js';

function fileValue(path, label) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError(`${label} must be a path`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function optionalFile(path, fallback) {
  return path ? fileValue(path, 'input file') : fallback;
}

function bool(value) {
  return value === true || value === 'true';
}

function integer(value, label, fallback = 0) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return result;
}

register('attention', {
  description: 'Investment Attention Monitoring Beta operations (query, collect, health, weekly review)',
  subcommands: new Map([
    ['query', {
      description: 'Read durable four-family attention state without notifying',
      options: {
        'state-dir': { type: 'string', description: 'Absolute ledger state directory' },
        symbol: { type: 'string', description: 'Optional exchange-qualified symbol' },
        timeframe: { type: 'string', description: 'Optional D, W, or 4H timeframe' },
        family: { type: 'string', description: 'Optional sma_fib, rsi, or cup_and_handle family' },
        'since-revision': { type: 'string', description: 'Return unchanged=true when this revision is current' },
      },
      handler: opts => queryInvestmentAttention({
        stateDir: opts['state-dir'] ?? DEFAULT_ATTENTION_STATE_DIR,
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        family: opts.family,
        sinceRevision: opts['since-revision'] === undefined ? undefined : integer(opts['since-revision'], '--since-revision'),
      }),
    }],
    ['collect-once', {
      description: 'Consume complete local payload lines and update the durable ledger',
      options: {
        'state-dir': { type: 'string', description: 'Absolute ledger state directory' },
        inbox: { type: 'string', description: 'Absolute append-only local payload inbox' },
        bootstrap: { type: 'boolean', description: 'Suppress notifications while seeding existing state' },
      },
      handler: async opts => collectInboxOnce({
        stateDir: opts['state-dir'] ?? DEFAULT_ATTENTION_STATE_DIR,
        inboxPath: opts.inbox ?? DEFAULT_ATTENTION_INBOX_PATH,
        sourceBindings: collectorSourceBindings(),
        bootstrap: bool(opts.bootstrap),
      }),
    }],
    ['health', {
      description: 'Reconcile stored route, alert, and collector health receipts',
      options: {
        'state-dir': { type: 'string', description: 'Absolute ledger state directory' },
      },
      handler: opts => {
        const stateDir = opts['state-dir'] ?? DEFAULT_ATTENTION_STATE_DIR;
        return {
          route_coverage: readInvestmentAttentionReceipt(stateDir, 'route-coverage.json'),
          alert_health: readInvestmentAttentionReceipt(stateDir, 'alert-health.json'),
          collector_heartbeat: readInvestmentAttentionReceipt(stateDir, 'collector-heartbeat.json'),
        };
      },
    }],
    ['weekly-review', {
      description: 'Build the bounded weekly usefulness/noise/misses/outcomes report',
      options: {
        'state-dir': { type: 'string', description: 'Absolute ledger state directory' },
        'week-start': { type: 'string', description: 'ISO week start' },
        'week-end': { type: 'string', description: 'ISO week end' },
        'canaries-file': { type: 'string', description: 'JSON array of family canary evidence' },
        'miss-sampling-file': { type: 'string', description: 'JSON miss-sampling evidence object' },
      },
      handler: opts => {
        const stateDir = opts['state-dir'] ?? DEFAULT_ATTENTION_STATE_DIR;
        const canaries = optionalFile(opts['canaries-file'], []);
        const missSampling = optionalFile(opts['miss-sampling-file'], { passed: false, candidates: [] });
        const health = readInvestmentAttentionReceipt(stateDir, 'alert-health.json');
        const report = buildInvestmentAttentionWeeklyReview({
          stateDir,
          weekStart: opts['week-start'],
          weekEnd: opts['week-end'],
          familyCanaries: canaries,
          missSampling,
          health,
        });
        writeInvestmentAttentionHealthReceipt(stateDir, 'weekly-review.json', report);
        return report;
      },
    }],
    ['ops-once', {
      description: 'Run one collector, route-coverage, alert-health, and optional weekly-review cycle',
      options: {
        'state-dir': { type: 'string', description: 'Absolute ledger state directory' },
        inbox: { type: 'string', description: 'Absolute append-only local payload inbox' },
        'availability-file': { type: 'string', description: 'JSON array of route availability readings' },
        'alerts-file': { type: 'string', description: 'JSON alert-health input object' },
        'week-start': { type: 'string', description: 'Optional ISO week start' },
        'week-end': { type: 'string', description: 'Optional ISO week end' },
        'canaries-file': { type: 'string', description: 'JSON array of family canary evidence' },
        'miss-sampling-file': { type: 'string', description: 'JSON miss-sampling evidence object' },
        bootstrap: { type: 'boolean', description: 'Suppress notifications while seeding existing state' },
      },
      handler: async opts => {
        const stateDir = opts['state-dir'] ?? DEFAULT_ATTENTION_STATE_DIR;
        const collected = await collectInboxOnce({
          stateDir,
          inboxPath: opts.inbox ?? DEFAULT_ATTENTION_INBOX_PATH,
          sourceBindings: collectorSourceBindings(),
          bootstrap: bool(opts.bootstrap),
        });
        const availability = optionalFile(opts['availability-file'], []);
        const routeCoverage = buildRouteCoverageReceipt({ readings: availability });
        writeInvestmentAttentionHealthReceipt(stateDir, 'route-coverage.json', routeCoverage);
        const alertInput = optionalFile(opts['alerts-file'], { expected_alerts: [], active_alerts: [], excluded_routes: [] });
        const alertHealth = assessInvestmentAttentionAlertHealth({
          expectedAlerts: alertInput.expected_alerts ?? alertInput.expectedAlerts ?? [],
          activeAlerts: alertInput.active_alerts ?? alertInput.activeAlerts ?? [],
          excludedRoutes: alertInput.excluded_routes ?? alertInput.excludedRoutes ?? [],
          collectorHeartbeat: collected,
        });
        writeInvestmentAttentionHealthReceipt(stateDir, 'alert-health.json', alertHealth);
        let weeklyReview = null;
        if (opts['week-start'] && opts['week-end']) {
          weeklyReview = buildInvestmentAttentionWeeklyReview({
            stateDir,
            weekStart: opts['week-start'],
            weekEnd: opts['week-end'],
            familyCanaries: optionalFile(opts['canaries-file'], []),
            missSampling: optionalFile(opts['miss-sampling-file'], { passed: false, candidates: [] }),
            health: alertHealth,
          });
          writeInvestmentAttentionHealthReceipt(stateDir, 'weekly-review.json', weeklyReview);
        }
        return { collected, route_coverage: routeCoverage, alert_health: alertHealth, weekly_review: weeklyReview };
      },
    }],
  ]),
});
