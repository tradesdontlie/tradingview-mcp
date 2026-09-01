import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectInboxOnce,
  collectorSourceBindings,
  ingestAttentionPayload,
} from '../src/core/investment-attention-collector.js';
import {
  assessInvestmentAttentionAlertHealth,
  buildInvestmentAttentionWeeklyReview,
  buildRouteCoverageReceipt,
} from '../src/core/investment-attention-health.js';
import {
  queryInvestmentAttention,
} from '../src/core/investment-attention-query.js';
import {
  generateRsiAlertScannerPine,
} from '../src/core/rsi-alert-pine.js';
import {
  proveRsiSemanticParity,
} from '../src/core/rsi-semantic-parity.js';
import {
  renderSmaFibAlertScannerPine,
} from '../src/core/sma-fib-alert-pine.js';

function stateDir() {
  return mkdtempSync(join(tmpdir(), 'investment-attention-test-'));
}

function smaPayload({ path = 'PROVISIONAL', targetTime = '2026-08-31 21:00:00' } = {}) {
  return [
    'SMA_FIB_ATTENTION|V1|PROFILE=D|SHARD=1',
    `NYSE:ABC|${path}|MASK=2|EVENTS=MA_TOUCH|STAGE_TIME=1725000000000|TARGET_CLOSE_UTC=${targetTime}|MA_EP=episode-1|PAIR=pair-1|C=10|SMA=10|GP=na`,
    '',
  ].join('\n');
}

function rsiPayload(event = 'NEW_DEVELOPING_REGULAR_BULL') {
  return JSON.stringify({
    schema_version: 'rsi-watchlist-alert-batch/v1',
    definition_version: 'rsi-watchlist-alert-scanner/v1',
    source_sha256: '2786edbb5280fc186d32d0bf2e266e2e46d63d2c5307b3cedddf25d7cafd1d50',
    profile: 'D',
    events: [{ event, symbol: 'NYSE:ABC', data_bar_time_ms: 1725000000000, provisional: true }],
  });
}

function cupPayload(stage = 'HANDLE_READY') {
  return JSON.stringify({
    schema_version: 'cup-handle-alert-v1',
    detector_version: '0.2.0-cleanroom',
    event_id: `cup-event-${stage}`,
    family_id: 'NVDA|1D',
    pattern_id: 'pattern-1',
    symbol: 'NASDAQ:NVDA',
    timeframe: '1D',
    from_stage: 'HANDLE_FORMING',
    to_stage: stage,
    reason_code: 'test',
    detection_bar_open_ms: 1725000000000,
    detection_bar_close_ms: 1725003600000,
    provisional: false,
  });
}

function humanEnvelope(headline, payload) {
  return `${headline}\n--- DATA ---\n${payload}`;
}

function assertPhoneAlertCopyIsHumanOnly(source) {
  for (const label of ['ACTUAL ALERT:', 'TIMEFRAME:', 'FIRED:', 'MEANING:', 'STATUS:', 'ACTION:']) {
    assert.match(source, new RegExp(label));
  }
  const alertCalls = source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('alert('));
  assert.equal(alertCalls.length > 0, true);
  for (const call of alertCalls) {
    assert.doesNotMatch(call, /--- DATA ---|SHARD=|MASK=|KEY=|STAGE_TIME=|data_bar_time_ms/u);
  }
}

describe('Investment Attention phone alert copy', () => {
  it('keeps SMA/Fib phone notifications human-only in generated and deployed source', () => {
    const generated = renderSmaFibAlertScannerPine({ symbols: ['BATS:SLV'] });
    const deployed = readFileSync(
      new URL('../ma reaction classifier/sma-fib-watchlist-alert-scanner-metals-v2.pine', import.meta.url),
      'utf8',
    );
    assertPhoneAlertCopyIsHumanOnly(generated);
    assertPhoneAlertCopyIsHumanOnly(deployed);
    assert.match(deployed, /ACTUAL ALERT: " \+ symbol/u);
  });

  it('keeps RSI phone notifications human-only in generated and both deployed shards', () => {
    const sources = [
      generateRsiAlertScannerPine({ symbols: ['BATS:ATI'] }).source,
      readFileSync(new URL('../rsi indicator/bullish-rsi-watchlist-alert-scanner-metals-s01-v1.pine', import.meta.url), 'utf8'),
      readFileSync(new URL('../rsi indicator/bullish-rsi-watchlist-alert-scanner-metals-s02-v1.pine', import.meta.url), 'utf8'),
    ];
    for (const source of sources) {
      assertPhoneAlertCopyIsHumanOnly(source);
      assert.match(source, /Price made a lower low while RSI made a higher low/u);
      assert.match(source, /Price held a higher low while RSI made a lower low/u);
    }
  });

  it('keeps Cup-and-Handle phone notifications human-only and exchange-qualified', () => {
    const source = readFileSync(new URL('../cup-and-handle/cup-and-handle.pine', import.meta.url), 'utf8');
    assertPhoneAlertCopyIsHumanOnly(source);
    assert.match(source, /ACTUAL ALERT: " \+ syminfo\.tickerid/u);
    assert.match(source, /A rounded cup is present and the handle is still developing/u);
  });
});

describe('Investment Attention ledger and collector', () => {
  it('deduplicates SMA provisional to closed as one episode and survives restart', async () => {
    const dir = stateDir();
    const binding = collectorSourceBindings().sma_fib;
    const first = await ingestAttentionPayload({
      stateDir: dir,
      payload: smaPayload(),
      sourceBinding: binding,
      observedAt: '2026-08-31T10:00:00Z',
    });
    const replay = await ingestAttentionPayload({
      stateDir: dir,
      payload: smaPayload(),
      sourceBinding: binding,
      observedAt: '2026-08-31T10:01:00Z',
    });
    const closed = await ingestAttentionPayload({
      stateDir: dir,
      payload: smaPayload({ path: 'CLOSED' }),
      sourceBinding: binding,
      observedAt: '2026-08-31T22:01:00Z',
    });
    assert.equal(first.notifications.length, 1);
    assert.equal(replay.notifications.length, 0);
    assert.equal(closed.notifications.length, 0);
    assert.equal(closed.outcomes[0].ingest_result, 'state_upgrade');
    const restarted = queryInvestmentAttention({ stateDir: dir, symbol: 'NYSE:ABC', timeframe: 'D' });
    assert.equal(restarted.routes.length, 1);
    assert.equal(restarted.latest_event.provisional, false);
    const unchanged = queryInvestmentAttention({ stateDir: dir, sinceRevision: restarted.revision });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.notifications_emitted, false);
    const records = readFileSync(join(dir, 'investment-attention-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[0].payload_text, smaPayload());
    assert.equal(records[0].payload_sha256.length, 64);
    assert.equal(new Set(records.map(record => record.event_id)).size, 1);
  });

  it('parses RSI and Cup payloads and consumes complete inbox lines once', async () => {
    const dir = stateDir();
    const inbox = join(dir, 'attention-inbox.jsonl');
    const pending = cupPayload('EXPIRED');
    const splitAt = Math.floor(pending.length / 2);
    writeFileSync(inbox, `${rsiPayload()}\n${cupPayload()}\n${pending.slice(0, splitAt)}`, 'utf8');
    const first = await collectInboxOnce({
      stateDir: dir,
      inboxPath: inbox,
      sourceBindings: collectorSourceBindings(),
      observedAt: '2026-08-31T10:00:00Z',
    });
    assert.equal(first.processed_payload_count, 2);
    assert.equal(first.incomplete_bytes_held > 0, true);
    appendFileSync(inbox, `${pending.slice(splitAt)}\n`, 'utf8');
    const second = await collectInboxOnce({
      stateDir: dir,
      inboxPath: inbox,
      sourceBindings: collectorSourceBindings(),
      observedAt: '2026-08-31T10:01:00Z',
    });
    assert.equal(second.processed_payload_count, 1);
    const query = queryInvestmentAttention({ stateDir: dir });
    assert.equal(query.routes.some(route => route.family === 'rsi'), true);
    assert.equal(query.routes.some(route => route.family === 'cup_and_handle'), true);
    assert.equal(query.current_lifecycle.length, 1);
  });

  it('accepts human-readable alert envelopes while preserving the full original payload', async () => {
    const cases = [
      {
        family: 'sma_fib',
        headline: 'WATCH ONLY — ABC (Daily)\nTouching the 200-period SMA. Wait for the daily close. Not a trade signal.',
        payload: smaPayload(),
      },
      {
        family: 'rsi',
        headline: 'WATCH ONLY — ABC (Daily)\nDeveloping regular bullish RSI divergence. Wait for the daily close. Not a trade signal.',
        payload: rsiPayload(),
      },
      {
        family: 'cup_and_handle',
        headline: 'REVIEW — NVDA (Daily)\nHandle is ready. Review the chart for a potential breakout. Not a trade signal.',
        payload: cupPayload(),
      },
    ];

    for (const [index, row] of cases.entries()) {
      const dir = stateDir();
      const wrapped = humanEnvelope(row.headline, row.payload);
      const result = await ingestAttentionPayload({
        stateDir: dir,
        payload: wrapped,
        sourceBinding: collectorSourceBindings()[row.family === 'rsi' ? 'rsi_scanner_s1' : row.family],
        observedAt: `2026-08-31T10:0${index}:00Z`,
      });
      assert.equal(result.family, row.family);
      const record = JSON.parse(readFileSync(join(dir, 'investment-attention-events.jsonl'), 'utf8').trim());
      assert.equal(record.payload_text, wrapped);
      assert.equal(record.payload_sha256.length, 64);
    }
  });
});

describe('Investment Attention health and weekly review', () => {
  it('produces all 66 route rows and fails closed on missing/warming routes', () => {
    const receipt = buildRouteCoverageReceipt({
      readings: [{ runtime_symbol: 'CBOE:GVX', timeframe: 'D', available: true, warm: true }],
      exclusions: [{ family: 'sma_fib', symbol: 'FRED:GVZCLS', timeframe: 'W', reason: 'test exclusion' }],
      observedAt: '2026-08-31T10:00:00Z',
    });
    assert.equal(receipt.expected_route_count, 66);
    assert.equal(receipt.routes.length, 66);
    assert.equal(receipt.substitution_count, 6);
    assert.equal(receipt.healthy, false);
    assert.equal(receipt.routes.some(route => route.route_key === 'FRED:GVZCLS|D'), true);
  });

  it('detects alert drift, duplicate/unexpected/disabled/expired routes, and stale collector', () => {
    const expected = [{
      expected_key: 'cup-and-handle|BATS:NVDA|D|early',
      family: 'cup_and_handle',
      symbol: 'BATS:NVDA',
      timeframe: 'D',
      source_identity: { script_id: 'USER;cup', script_version: '1.0', source_sha256: 'a'.repeat(64) },
      input_identity: { sha256: 'b'.repeat(64), values: { alertRimApproach: true } },
      feed_symbol: 'BATS:NVDA',
      maximum_expiry_at_creation: '2026-09-30T00:00:00Z',
      popup: true,
      mobile_push: true,
      web_hook: null,
    }];
    const actual = {
      ...expected[0],
      alert_id: '1',
      route_symbol: 'BATS:NVDA',
      route_timeframe: 'D',
      active: false,
      expiration: '2026-08-01T00:00:00Z',
      source_identity: { script_id: 'USER;wrong' },
      input_identity: { sha256: 'c'.repeat(64), values: {} },
      feed_symbol: 'NASDAQ:NVDA',
      popup: false,
      mobile_push: false,
    };
    const health = assessInvestmentAttentionAlertHealth({
      expectedAlerts: expected,
      activeAlerts: [actual, { ...actual, alert_id: '2', active: true }],
      excludedRoutes: [{ family: 'cup_and_handle', symbol: 'BATS:EXCLUDED', timeframe: 'D', reason: 'invalid' }],
      collectorHeartbeat: { schema_version: 'investment-attention-collector/v1', alive_at: '2026-08-30T00:00:00Z' },
      now: '2026-08-31T10:00:00Z',
    });
    assert.equal(health.healthy, false);
    assert.equal(health.disabled.length, 1);
    assert.equal(health.duplicates.length, 1);
    assert.equal(health.source_drift.length, 1);
    assert.equal(health.input_drift.length, 1);
    assert.equal(health.feed_drift.length, 1);
    assert.equal(health.expiry_reconciliation.length, 1);
    assert.equal(health.invalid_exclusions.length, 1);
    assert.equal(health.collector_liveness.alive, false);
  });

  it('requires four family canaries and miss sampling for a complete weekly review', () => {
    const complete = buildInvestmentAttentionWeeklyReview({
      records: [],
      weekStart: '2026-08-24T00:00:00Z',
      weekEnd: '2026-08-31T00:00:00Z',
      familyCanaries: [
        { family: 'sma_fib', passed: true },
        { family: 'rsi', passed: true },
        { family: 'cup_and_handle', passed: true },
        { family: 'collector', passed: true },
      ],
      missSampling: { passed: true, candidates: [] },
      health: { healthy: true },
    });
    assert.equal(complete.complete, true);
    assert.equal(complete.zero_event_exception, true);
    const incomplete = buildInvestmentAttentionWeeklyReview({
      records: [],
      weekStart: '2026-08-24T00:00:00Z',
      weekEnd: '2026-08-31T00:00:00Z',
      familyCanaries: complete.canaries,
      missSampling: { passed: false, candidates: [] },
      health: { healthy: true },
    });
    assert.equal(incomplete.complete, false);
  });
});

describe('RSI scanner/query semantic parity', () => {
  it('covers regular and hidden provisional and confirmed pulses', () => {
    const receipt = proveRsiSemanticParity();
    assert.equal(receipt.accepted_pulses.length, 4);
    assert.equal(receipt.complete, true);
  });
});
