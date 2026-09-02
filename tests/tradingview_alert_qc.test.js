import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRADINGVIEW_ALERT_QC_EXPECTED_SCHEMA_VERSION,
  buildTradingViewAlertQcReport,
  importTradingViewAlertsLogCsv,
  loadTradingViewAlertQcOccurrences,
  prepareTradingViewAlertQcHome,
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
    assert.equal(replay.appended_count, 0);
    assert.equal(replay.exact_duplicates, 1);
    assert.equal(repeated.appended_count, 1);
    assert.equal(occurrences.length, 2);
    assert.equal(summary.repeated_firings[0].distinct_source_times, 2);
    assert.equal(statSync(first.raw_evidence_path).mode & 0o777, 0o600);
  });
});

describe('TradingView Alert QC report and reviewer backlog', () => {
  it('keeps absent deployed source evidence absent in live alert normalization', () => {
    const row = normalizeInvestmentAttentionLiveAlert({
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
    });
    assert.equal(row.source_sha256, null);
    assert.equal(row.definition_version, null);
    assert.equal(row.source_hash_status, 'unverified');
    assert.equal(row.definition_status, 'unverified');
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
});
