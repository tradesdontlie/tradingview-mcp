import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION,
  buildTradingViewAlertQcReport,
  importTradingViewAlertsLogCsv,
  loadTradingViewAlertQcOccurrences,
  prepareTradingViewAlertQcHome,
  tradingViewAlertQcUiExpressions,
  withTradingViewAlertQcDownloadBehavior,
  writeTradingViewAlertQcBacklog,
} from '../src/core/tradingview-alert-qc.js';
import {
  normalizeTradingViewAlertLogRows,
  parseTradingViewAlertsLogCsv,
  summarizeAlertLogOccurrences,
} from '../src/core/tradingview-alert-log.js';
import { normalizeInvestmentAttentionLiveAlert } from '../src/core/investment-attention-live-snapshot.js';

function tempRoot(prefix = 'tradingview-alert-qc-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function csvRow({ alertId = '123', ticker = 'BINANCE:BTCUSDT, 1h', name = 'Scanner "quoted"', description, time = '2026-09-01T10:00:00Z', webhook = '' } = {}) {
  const values = [alertId, ticker, name, description, time, webhook];
  return values.map(value => {
    const text = String(value ?? '');
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',');
}

function humanDescription({ symbol = 'BATS:ABC', timeframe = 'DAILY', fired = 'First signal; Second signal' } = {}) {
  return [
    `ACTUAL ALERT: ${symbol}`,
    `TIMEFRAME: ${timeframe}`,
    `FIRED: ${fired}`,
    'MEANING: A bounded test signal',
    'STATUS: Developing - candle still open',
    'ACTION: Review only. Not a trade signal.',
  ].join('\n');
}

function expectedConfig() {
  return {
    schema_version: TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION,
    alerts: [{
      alert_id: '123',
      expected_key: 'rsi|metals-rsi-test-v1|D',
      family: 'rsi',
      symbol: 'BINANCE:BTCUSDT',
      timeframe: 'D',
      route_symbol: 'BINANCE:BTCUSDT',
      route_timeframe: 'D',
      feed_symbol: 'BATS:ABC',
      active: true,
      popup: true,
      mobile_push: true,
      web_hook: null,
      source_identity: {
        definition_version: 'rsi-watchlist-alert-scanner/v1',
        source_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        script_id: 'USER;test-script',
        script_version: '3.0',
      },
      input_identity: { sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', values: { in_0: 'metals-rsi-test-v1', in_1: 'D' } },
      expiration: '2026-09-29T22:58:09Z',
    }],
  };
}

function observedInventory() {
  return {
    managed: [{
      alert_id: '123',
      expected_key: 'rsi|metals-rsi-test-v1|D',
      family: 'rsi',
      active: true,
      route_symbol: 'BINANCE:BTCUSDT',
      route_timeframe: 'D',
      feed_symbol: 'BATS:ABC',
      script_id: 'USER;test-script',
      script_version: '3.0',
      source_sha256: null,
      definition_version: null,
      input_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      input_values: { in_0: 'metals-rsi-test-v1', in_1: 'D' },
      popup: true,
      mobile_push: true,
      web_hook: null,
      notification_field_presence: { popup: true, mobile_push: true, web_hook: true },
      expiration: '2026-09-29T22:58:09Z',
    }],
    unmanaged: [],
  };
}

describe('TradingView Alerts Log parsing', () => {
  it('parses quoted multiline rows and keeps source time separate from import time', () => {
    const description = humanDescription();
    const csv = [
      'Alert ID,Ticker,Name,Description,Time,Webhook status',
      csvRow({ description, name: 'Scanner "quoted"' }),
    ].join('\n');
    const parsed = parseTradingViewAlertsLogCsv(csv);
    const [row] = normalizeTradingViewAlertLogRows(parsed, {
      importedAt: '2026-09-02T20:00:00Z',
      observedAlertsById: new Map([['123', {
        alert_id: '123', expected_key: 'rsi|metals-rsi-test-v1|D', family: 'rsi',
        script_id: 'USER;test-script', script_version: '3.0',
      }]]),
      expectedAlertsById: new Map([['123', expectedConfig().alerts[0]]]),
      expectedAlertsByKey: new Map([[expectedConfig().alerts[0].expected_key, expectedConfig().alerts[0]]]),
    });
    assert.equal(parsed.record_count, 1);
    assert.equal(row.name, 'Scanner "quoted"');
    assert.equal(row.host_symbol, 'BINANCE:BTCUSDT');
    assert.equal(row.host_timeframe, '1H');
    assert.equal(row.actual_symbol, 'BATS:ABC');
    assert.equal(row.declared_timeframe, 'D');
    assert.equal(row.source_fired_at, '2026-09-01T10:00:00.000Z');
    assert.equal(row.imported_at, '2026-09-02T20:00:00.000Z');
    assert.equal(row.description_kind, 'human_only');
    assert.equal(row.signal_blocks.length, 2);
    assert.equal(row.identity.status, 'observed_managed');
  });

  it('preserves unknown legacy rows instead of assigning managed semantics', () => {
    const csv = [
      'Alert ID,Ticker,Name,Description,Time,Webhook status',
      csvRow({ alertId: 'legacy', ticker: 'BATS:FIG, 1D', name: 'FIG crossing', description: 'FIG, 1D Crossing horizontal ray', time: '2026-09-01T11:00:00Z' }),
    ].join('\n');
    const [row] = normalizeTradingViewAlertLogRows(parseTradingViewAlertsLogCsv(csv), { importedAt: '2026-09-02T20:00:00Z' });
    assert.equal(row.identity.status, 'unknown');
    assert.equal(row.description_kind, 'legacy_or_unknown');
    assert.equal(row.actual_symbol, null);
    assert.equal(row.signal_blocks.length, 0);
    assert.equal(row.raw_csv_record.includes('FIG crossing'), true);
  });
});

describe('TradingView Alerts Log occurrence ledger', () => {
  it('deduplicates exact overlap while retaining a genuine repeated firing', () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const backlog = join(root, 'backlog.md');
    const paths = prepareTradingViewAlertQcHome(home, backlog);
    const firstCsv = join(root, 'first.csv');
    const description = humanDescription();
    writeFileSync(firstCsv, [
      'Alert ID,Ticker,Name,Description,Time,Webhook status',
      csvRow({ description, time: '2026-09-01T10:00:00Z' }),
      csvRow({ description, time: '2026-09-01T10:00:00Z' }),
    ].join('\n'), { mode: 0o600 });
    const first = importTradingViewAlertsLogCsv({
      csvPath: firstCsv,
      paths,
      importedAt: '2026-09-02T20:00:00Z',
      observedInventory: observedInventory(),
      expectedConfig: expectedConfig(),
    });
    const replay = importTradingViewAlertsLogCsv({
      csvPath: firstCsv,
      paths,
      importedAt: '2026-09-02T20:01:00Z',
      observedInventory: observedInventory(),
      expectedConfig: expectedConfig(),
    });
    const secondCsv = join(root, 'second.csv');
    writeFileSync(secondCsv, [
      'Alert ID,Ticker,Name,Description,Time,Webhook status',
      csvRow({ description, time: '2026-09-01T11:00:00Z' }),
    ].join('\n'), { mode: 0o600 });
    const repeated = importTradingViewAlertsLogCsv({
      csvPath: secondCsv,
      paths,
      importedAt: '2026-09-02T20:02:00Z',
      observedInventory: observedInventory(),
      expectedConfig: expectedConfig(),
    });
    const occurrences = loadTradingViewAlertQcOccurrences(paths);
    const summary = summarizeAlertLogOccurrences(occurrences);
    assert.equal(first.appended_count, 1);
    assert.equal(first.exact_duplicates, 1);
    assert.equal(replay.appended_count, 0);
    assert.equal(replay.exact_duplicates, 2);
    assert.equal(repeated.appended_count, 1);
    assert.equal(occurrences.length, 2);
    assert.equal(summary.repeated_firings[0].distinct_source_times, 2);
    assert.equal(statSync(first.raw_evidence_path).mode & 0o777, 0o600);
  });
});

describe('TradingView Alert QC report and reviewer backlog', () => {
  function fakeElement(text = '') {
    return {
      offsetParent: {},
      getClientRects: () => [{}],
      textContent: text,
      clicks: 0,
      click() { this.clicks += 1; },
    };
  }

  function fakeDocument({ actions = false, log = false, alertButton = false }) {
    const actionElement = actions ? fakeElement('Options') : null;
    const logElement = log ? fakeElement('26Log26') : null;
    const alertElement = alertButton ? fakeElement('Alerts') : null;
    return {
      actionElement,
      logElement,
      alertElement,
      querySelectorAll(selector) {
        if (selector.includes('alerts-log-actions-button')) return actionElement ? [actionElement] : [];
        if (selector.includes('alerts-button')) return alertElement ? [alertElement] : [];
        if (selector === 'button, a, [role="button"], [role="tab"]') return [logElement, alertElement].filter(Boolean);
        return [];
      },
    };
  }

  it('keeps the reviewed frozen RSI baseline expanded through in_52', () => {
    const frozen = JSON.parse(readFileSync(new URL('../analysis/tradingview-alert-qc-expected.json', import.meta.url), 'utf8'));
    const rsi = frozen.alerts.filter(alert => alert.family === 'rsi');
    assert.equal(rsi.length, 24);
    assert.equal(new Set(rsi.map(alert => alert.expected_key)).size, 24);
    assert.ok(rsi.every(alert => Object.keys(alert.input_identity.values).length === 53));
    assert.ok(rsi.every(alert => Object.hasOwn(alert.input_identity.values, 'in_52')));
    for (const timeframe of ['D', 'W']) {
      const feeds = rsi
        .filter(alert => alert.timeframe === timeframe)
        .flatMap(alert => Object.entries(alert.input_identity.values)
          .filter(([key, value]) => Number(key.slice(3)) >= 23 && Number(key.slice(3)) <= 52 && typeof value === 'string' && value)
          .map(([, value]) => value));
      assert.equal(new Set(feeds).size, 33);
      assert.equal(feeds.length, 33);
    }
    assert.equal(frozen.baseline_provenance.fresh_inventory_review.accepted_mapping_unique_nonempty_feeds_each_timeframe, 33);
    assert.equal(frozen.baseline_provenance.fresh_inventory_review.duplicate_mapping_count, 0);
    assert.equal(frozen.baseline_provenance.fresh_inventory_review.extra_mapping_count, 0);
    assert.equal(frozen.baseline_provenance.fresh_inventory_review.alert_rollout_performed, false);
  });

  it('supports closed, Alerts-list-open, and Log-open UI states without a panel toggle loop', () => {
    const expression = tradingViewAlertQcUiExpressions().ensure_log;
    const closed = fakeDocument({ alertButton: true });
    const closedState = runInNewContext(expression, { document: closed });
    assert.equal(closedState.action, 'alerts_panel_requested');
    assert.equal(closed.alertElement.clicks, 1);

    const listOpen = fakeDocument({ log: true, alertButton: true });
    const listState = runInNewContext(expression, { document: listOpen });
    assert.equal(listState.action, 'log_tab_requested');
    assert.equal(listOpen.logElement.clicks, 1);
    assert.equal(listOpen.alertElement.clicks, 0);

    const logOpen = fakeDocument({ actions: true });
    const logState = runInNewContext(expression, { document: logOpen });
    assert.equal(logState.ready, true);
    assert.equal(logOpen.actionElement.clicks, 0);
  });

  it('restores the default CDP download behavior on success and failure', async () => {
    const successCalls = [];
    const successClient = { Page: { setDownloadBehavior: async options => successCalls.push(options) } };
    await withTradingViewAlertQcDownloadBehavior(successClient, '/tmp/tradingview-alert-qc-test', async () => 'ok');
    assert.deepEqual(successCalls, [
      { behavior: 'allow', downloadPath: '/tmp/tradingview-alert-qc-test' },
      { behavior: 'default' },
    ]);
    const failureCalls = [];
    const failureClient = { Page: { setDownloadBehavior: async options => failureCalls.push(options) } };
    await assert.rejects(
      withTradingViewAlertQcDownloadBehavior(failureClient, '/tmp/tradingview-alert-qc-test', async () => { throw new Error('export failed'); }),
      /export failed/u,
    );
    assert.deepEqual(failureCalls, [
      { behavior: 'allow', downloadPath: '/tmp/tradingview-alert-qc-test' },
      { behavior: 'default' },
    ]);
  });

  it('fails closed when restoring the default CDP download behavior fails', async () => {
    let calls = 0;
    const client = {
      Page: {
        setDownloadBehavior: async () => {
          calls += 1;
          if (calls === 2) throw new Error('restore failed');
        },
      },
    };
    await assert.rejects(
      withTradingViewAlertQcDownloadBehavior(client, '/tmp/tradingview-alert-qc-test', async () => 'ok'),
      /could not restore CDP download behavior: restore failed/u,
    );
  });

  it('keeps absent deployed source evidence absent in live alert normalization', () => {
    const alert = {
      alert_id: '123',
      symbol: '={"symbol":"BINANCE:BTCUSDT"}',
      active: true,
      resolution: '1D',
      condition: {
        resolution: '1D',
        series: [{
          pine_id: 'USER;53eb4225f4f44cb4a9c7d5022fd50419',
          pine_version: '3.0',
          inputs: { in_0: 'metals-rsi-test-v1', in_1: 'D', in_23: 'BATS:ABC' },
        }],
      },
    };
    const row = normalizeInvestmentAttentionLiveAlert(alert);
    const expanded = normalizeInvestmentAttentionLiveAlert({
      ...alert,
      condition: { ...alert.condition, series: [{ ...alert.condition.series[0], inputs: { ...alert.condition.series[0].inputs, in_24: 'BATS:CHANGED' } }] },
    }, { includeAllRsiSlots: true });
    const expandedBase = normalizeInvestmentAttentionLiveAlert(alert, { includeAllRsiSlots: true });
    assert.equal(row.source_sha256, null);
    assert.equal(row.definition_version, null);
    assert.equal(row.source_hash_status, 'unverified');
    assert.equal(row.definition_status, 'unverified');
    assert.equal(expandedBase.input_values.in_24, undefined);
    assert.equal(expanded.input_values.in_24, 'BATS:CHANGED');
    assert.notEqual(expanded.input_sha256, expandedBase.input_sha256);
  });

  it('reports missing source proof without substituting the frozen hash', () => {
    const report = buildTradingViewAlertQcReport({
      expectedConfig: expectedConfig(),
      observedInventory: observedInventory(),
      collection: {
        success: true,
        observed_at: '2026-09-02T20:00:00Z',
        collected_at: '2026-09-02T20:00:01Z',
        csv_columns: ['Alert ID', 'Ticker', 'Name', 'Description', 'Time', 'Webhook status'],
        csv_record_count: 1,
        history_completeness: 'unproven',
      },
      generatedAt: '2026-09-02T20:00:02Z',
    });
    assert.equal(report.run_status, 'success');
    assert.equal(report.inventory.source_unverified.length, 1);
    assert.equal(report.inventory.source_unverified[0].alert_id, '123');
    assert.equal(report.inventory.source_identity_drift.length, 0);
    assert.equal(report.rsi_miss_sampling.status, 'not_verified');
    assert.deepEqual(report.improvement_suggestions.map(item => item.id), ['TV-QC-001', 'TV-QC-002', 'TV-QC-004']);
  });

  it('separates confirmed firing from possible and confirmed RSI misses', () => {
    const expected = expectedConfig();
    const observed = observedInventory();
    observed.managed[0].source_sha256 = expected.alerts[0].source_identity.source_sha256;
    observed.managed[0].definition_version = expected.alerts[0].source_identity.definition_version;
    const coverage = {
      evidence_present: true,
      evidence_ref: 'TV-QC/2026-09-02/alerts-log-export',
      source: 'TradingView Alerts Log CSV',
      window_start: '2026-09-02T10:00:00Z',
      window_end: '2026-09-02T12:00:00Z',
      complete_for_window: true,
    };
    const sourceIdentity = expected.alerts[0].source_identity;
    const sampleBase = {
      expected_key: expected.alerts[0].expected_key,
      route_symbol: 'BINANCE:BTCUSDT',
      route_timeframe: 'D',
      source_identity: sourceIdentity,
      input_sha256: expected.alerts[0].input_identity.sha256,
      independent_observation: true,
      coverage,
    };
    const report = buildTradingViewAlertQcReport({
      expectedConfig: expected,
      observedInventory: observed,
      collection: { success: true, observed_at: '2026-09-02T12:00:00Z', collected_at: '2026-09-02T12:00:01Z', history_completeness: 'unproven' },
      occurrences: [{ identity: { expected_key: expected.alerts[0].expected_key }, source_fired_at_ms: Date.parse('2026-09-02T11:30:00Z') }],
      rsiReference: {
        verified: true,
        reference_kind: 'independent_verified_reference',
        samples: [
          { ...sampleBase, event_time: '2026-09-02T11:00:00Z', expected_event: true, alert_fired: false },
          { ...sampleBase, event_time: '2026-09-02T11:30:00Z', expected_event: true, alert_fired: true },
        ],
      },
      generatedAt: '2026-09-02T12:00:02Z',
    });
    assert.equal(report.rsi_miss_sampling.status, 'confirmed_miss');
    assert.deepEqual(report.rsi_miss_sampling.outcomes.map(row => row.outcome), ['confirmed_miss', 'confirmed_firing']);
    assert.equal(report.rsi_miss_sampling.counts.confirmed_miss, 1);
    assert.equal(report.rsi_miss_sampling.counts.confirmed_firing, 1);
  });

  it('preserves a reviewer-edited status on the next generated backlog update', () => {
    const root = tempRoot();
    const backlogPath = join(root, 'backlog.md');
    const suggestions = [{
      id: 'TV-QC-001',
      title: 'Prove export coverage',
      evidence_refs: ['TV-QC/2026-09-02/export'],
      first_seen_at: '2026-09-02T20:00:00.000Z',
      last_seen_at: '2026-09-02T20:00:00.000Z',
      recurrence: { runs_observed: 1 },
      affected_alerts: ['Alerts Log export'],
      proposed_change: 'Review export coverage.',
      benefit: 'Bounded history.',
      risk: 'Review work.',
      test: 'Replay export.',
      status: 'proposed',
    }];
    writeTradingViewAlertQcBacklog(suggestions, { backlogPath, generatedAt: '2026-09-02T20:00:00Z' });
    const accepted = readFileSync(backlogPath, 'utf8').replace('- Status: proposed', '- Status: accepted');
    writeFileSync(backlogPath, accepted, 'utf8');
    writeTradingViewAlertQcBacklog(suggestions, { backlogPath, generatedAt: '2026-09-02T21:00:00Z' });
    assert.match(readFileSync(backlogPath, 'utf8'), /- Status: accepted/u);
  });

  it('retains disappeared proposals, reviewer notes, first-seen time, and cumulative recurrence', () => {
    const root = tempRoot();
    const backlogPath = join(root, 'backlog-history.md');
    const item = {
      id: 'TV-QC-001',
      title: 'Prove export coverage',
      evidence_refs: ['TV-QC/2026-09-01/export'],
      first_seen_at: '2026-09-01T20:00:00.000Z',
      last_seen_at: '2026-09-01T20:00:00.000Z',
      recurrence: { runs_observed: 1 },
      affected_alerts: ['Alerts Log export'],
      proposed_change: 'Review export coverage.',
      benefit: 'Bounded history.',
      risk: 'Review work.',
      test: 'Replay export.',
      status: 'proposed',
    };
    writeTradingViewAlertQcBacklog([item], { backlogPath, generatedAt: '2026-09-01T20:00:00Z' });
    let content = readFileSync(backlogPath, 'utf8').replace('- Status: proposed', '- Status: accepted');
    content = content.replace('<!-- tradingview-alert-qc:generated:end -->', '#### Reviewer notes\nKeep this evidence gap visible.\n\n<!-- tradingview-alert-qc:generated:end -->');
    writeFileSync(backlogPath, content, 'utf8');
    const other = { ...item, id: 'TV-QC-002', title: 'Another proposal' };
    const second = writeTradingViewAlertQcBacklog([other], { backlogPath, generatedAt: '2026-09-02T20:00:00Z' });
    assert.equal(second.preserved_history_count, 1);
    assert.match(readFileSync(backlogPath, 'utf8'), /Keep this evidence gap visible\./u);
    assert.match(readFileSync(backlogPath, 'utf8'), /### TV-QC-001 — Prove export coverage[\s\S]*- Status: accepted/u);
    const third = writeTradingViewAlertQcBacklog([{ ...item, first_seen_at: '2026-09-03T20:00:00.000Z', last_seen_at: '2026-09-03T20:00:00.000Z' }], { backlogPath, generatedAt: '2026-09-03T20:00:00Z' });
    assert.equal(third.preserved_history_count, 1);
    const finalContent = readFileSync(backlogPath, 'utf8');
    assert.match(finalContent, /### TV-QC-001 — Prove export coverage[\s\S]*First seen: 2026-09-01T20:00:00\.000Z/u);
    assert.match(finalContent, /### TV-QC-001 — Prove export coverage[\s\S]*runs_observed.:2/u);
    assert.match(finalContent, /Keep this evidence gap visible\./u);
  });
});
