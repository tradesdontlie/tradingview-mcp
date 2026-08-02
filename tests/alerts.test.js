import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlertPayload,
  create,
  normalizeListedAlert,
  syncAlerts,
  validateAlertDefinition,
} from '../src/core/alerts.js';
import { registerAlertTools } from '../src/tools/alerts.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const EXPIRATION = '2030-01-02T15:30:00-05:00';
const NORMALIZED_EXPIRATION = '2030-01-02T20:30:00.000Z';

function priceDefinition(overrides = {}) {
  return {
    symbol: 'NASDAQ:NVDA',
    timeframe: '1',
    kind: 'price',
    condition: 'crossing',
    price: 123.45,
    frequency: 'once_per_bar_close',
    expiration: EXPIRATION,
    message: 'DT|2030-01-02|NASDAQ:NVDA|breakout|1|crossing',
    ...overrides,
  };
}

function indicatorDefinition(overrides = {}) {
  return {
    symbol: 'NASDAQ:NVDA',
    timeframe: '1',
    kind: 'indicator',
    condition: 'Initial ORB opportunity',
    indicator: 'MTF 5m-1m ORB Retest/Reclaim v3 [Live]',
    frequency: 'once_per_bar_close',
    expiration: EXPIRATION,
    message: 'DT|2030-01-02|NASDAQ:NVDA|orb|1|Initial ORB opportunity',
    ...overrides,
  };
}

function resolvedIndicator() {
  return {
    pane_index: 2,
    alert_condition_id: 'plot_7',
    series: {
      type: 'study',
      study: 'Script@tv-scripting-101',
      pine_id: 'USER;abc123',
      pine_version: '3.0',
      inputs: { in_0: '0930-0935', pineFeatures: '{"alertcondition":1}' },
      offsets_by_plot: { plot_0: 0 },
    },
  };
}

function existingAlert(definition, alertId, overrides = {}) {
  const normalized = validateAlertDefinition(definition, { now: NOW });
  return { alert_id: alertId, active: true, ...normalized, ...overrides };
}

function mockDeps({ existing = [], createResults = [], resolveResult = resolvedIndicator() } = {}) {
  const calls = { list: 0, create: [], delete: [], resolve: [] };
  let createIndex = 0;
  return {
    calls,
    deps: {
      now: NOW,
      async listAlerts() {
        calls.list++;
        return { success: true, alerts: structuredClone(existing) };
      },
      async createRaw(payload) {
        calls.create.push(structuredClone(payload));
        const configured = createResults[createIndex++];
        return configured || { success: true, alert_id: 9000 + createIndex };
      },
      async deleteRaw(ids) {
        calls.delete.push([...ids]);
        return { success: true, alert_ids: [...ids] };
      },
      async resolveIndicator(definition) {
        calls.resolve.push(structuredClone(definition));
        if (resolveResult instanceof Error) throw resolveResult;
        return structuredClone(resolveResult);
      },
    },
  };
}

describe('alert definition validation and payloads', () => {
  it('requires an exchange-qualified symbol and explicit timeframe', () => {
    assert.throws(
      () => validateAlertDefinition(priceDefinition({ symbol: 'NVDA' }), { now: NOW }),
      /exchange-qualified/,
    );
    assert.throws(
      () => validateAlertDefinition(priceDefinition({ timeframe: '' }), { now: NOW }),
      /timeframe is required/,
    );
  });

  for (const [condition, internal] of [
    ['crossing', 'cross'],
    ['greater_than', 'greater'],
    ['less_than', 'less'],
  ]) {
    it(`preserves the ${condition} price condition exactly`, () => {
      const definition = validateAlertDefinition(priceDefinition({ condition }), { now: NOW });
      const payload = buildAlertPayload(definition);
      assert.equal(payload.conditions[0].type, internal);
      assert.equal(payload.conditions[0].series[1].value, 123.45);
      assert.equal(payload.conditions[0].resolution, '1');
      assert.equal(payload.symbol, '={"symbol":"NASDAQ:NVDA"}');
    });
  }

  it('builds a named Pine alertcondition payload without substituting a price condition', async () => {
    const mock = mockDeps();
    const result = await create({ ...indicatorDefinition(), _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(result.definition.kind, 'indicator');
    assert.equal(result.definition.condition, 'Initial ORB opportunity');
    assert.equal(mock.calls.resolve.length, 1);
    const condition = mock.calls.create[0].conditions[0];
    assert.equal(condition.type, 'alert_cond');
    assert.equal(condition.alert_cond_id, 'plot_7');
    assert.equal(condition.series[0].pine_id, 'USER;abc123');
    assert.equal(condition.series.some(series => series.type === 'value'), false);
  });

  for (const [frequency, internal] of [
    ['once', 'on_first_fire'],
    ['once_per_bar', 'on_each_fire'],
    ['once_per_bar_close', 'on_bar_close'],
  ]) {
    it(`preserves ${frequency} and an offset expiration`, () => {
      const definition = validateAlertDefinition(priceDefinition({ frequency }), { now: NOW });
      const payload = buildAlertPayload(definition);
      assert.equal(definition.expiration, NORMALIZED_EXPIRATION);
      assert.equal(payload.expiration, NORMALIZED_EXPIRATION);
      assert.equal(payload.conditions[0].frequency, internal);
    });
  }

  it('dry-run validates with zero mutations', async () => {
    const mock = mockDeps();
    const result = await create({ ...priceDefinition(), dry_run: true, _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.chart_state_changed, false);
    assert.equal(mock.calls.create.length, 0);
    assert.equal(mock.calls.delete.length, 0);
  });

  it('fails closed when an exact Pine condition cannot be resolved', async () => {
    const unsupported = new Error('Exact Pine condition is unavailable');
    unsupported.stage = 'indicator_resolution';
    const mock = mockDeps({ resolveResult: unsupported });
    const result = await create({ ...indicatorDefinition(), _deps: mock.deps });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'indicator_resolution');
    assert.equal(mock.calls.create.length, 0, 'never substitutes a price alert');
  });

  it('normalizes exact Pine titles, frequency, expiration, and canonical pro symbol from list_alerts', () => {
    const raw = {
      alert_id: 77,
      type: 'indicator',
      symbol: '={"symbol":"BATS:NVDA"}',
      pro_symbol: '={"symbol":"NASDAQ:NVDA"}',
      resolution: '1',
      message: 'deterministic',
      expiration: '2030-01-02T20:30:00Z',
      active: true,
      condition: {
        type: 'alert_cond',
        frequency: 'on_bar_close',
        resolution: '1',
        alert_cond_id: 'plot_7',
        series: [{ type: 'study', pine_id: 'USER;abc123' }],
      },
      presentation_data: {
        studies: {
          'Script$USER;abc123@tv-scripting-101_3.0': {
            description: 'Exact Live Indicator',
            alert_conditions: { plot_7: { title: 'Exact Pine Condition' } },
          },
        },
      },
    };
    const normalized = normalizeListedAlert(raw);
    assert.equal(normalized.symbol, 'NASDAQ:NVDA');
    assert.equal(normalized.indicator, 'Exact Live Indicator');
    assert.equal(normalized.condition, 'Exact Pine Condition');
    assert.equal(normalized.frequency, 'once_per_bar_close');
    assert.equal(normalized.expiration, NORMALIZED_EXPIRATION);
  });
});

describe('alerts_sync', () => {
  it('lists once and leaves an exact existing alert unchanged', async () => {
    const definition = priceDefinition();
    const mock = mockDeps({ existing: [existingAlert(definition, 101)] });
    const result = await syncAlerts({ alerts: [definition], _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(mock.calls.list, 1);
    assert.equal(mock.calls.create.length, 0);
    assert.equal(mock.calls.delete.length, 0);
    assert.deepEqual(result.final_alert_ids, [101]);
    assert.deepEqual(result.unchanged[0].alert_ids, [101]);
  });

  it('classifies a related non-exact alert as a conflict and avoids duplication', async () => {
    const definition = priceDefinition();
    const conflict = existingAlert(definition, 202, { frequency: 'once' });
    const mock = mockDeps({ existing: [conflict] });
    const result = await syncAlerts({ alerts: [definition], dry_run: true, _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.missing.length, 0);
    assert.equal(mock.calls.create.length, 0);
    assert.equal(mock.calls.delete.length, 0);
  });

  it('replaces only a conflicting alert whose exact ID is approved', async () => {
    const definition = priceDefinition();
    const conflict = existingAlert(definition, 303, { message: 'old message' });
    const unrelated = existingAlert(priceDefinition({ symbol: 'NASDAQ:MSFT' }), 404);
    const mock = mockDeps({ existing: [conflict, unrelated] });
    const result = await syncAlerts({
      alerts: [definition],
      replace_alert_ids: [303],
      _deps: mock.deps,
    });
    assert.equal(result.success, true);
    assert.deepEqual(mock.calls.delete, [[303]]);
    assert.equal(mock.calls.create.length, 1);
    assert.deepEqual(result.unrelated_preserved, [404]);
    assert.deepEqual(result.replaced[0].replaced_alert_ids, [303]);
  });

  it('never replaces a conflicting alert without its approved ID', async () => {
    const definition = priceDefinition();
    const mock = mockDeps({ existing: [existingAlert(definition, 505, { frequency: 'once' })] });
    const result = await syncAlerts({ alerts: [definition], _deps: mock.deps });
    assert.equal(result.success, false);
    assert.equal(result.conflicts.length, 1);
    assert.equal(mock.calls.delete.length, 0);
    assert.equal(mock.calls.create.length, 0);
  });

  it('rejects a replace ID that belongs to an unrelated alert', async () => {
    const definition = priceDefinition();
    const unrelated = existingAlert(priceDefinition({ symbol: 'NASDAQ:MSFT' }), 515);
    const mock = mockDeps({ existing: [unrelated] });
    const result = await syncAlerts({ alerts: [definition], replace_alert_ids: [515], _deps: mock.deps });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'unrelated_replace_ids');
    assert.equal(mock.calls.delete.length, 0);
    assert.equal(mock.calls.create.length, 0);
  });

  it('rejects duplicate plan definitions before listing or mutating', async () => {
    const definition = priceDefinition();
    const mock = mockDeps();
    const result = await syncAlerts({ alerts: [definition, { ...definition }], _deps: mock.deps });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'duplicate_plan_definitions');
    assert.equal(mock.calls.list, 0);
    assert.equal(mock.calls.create.length, 0);
    assert.equal(mock.calls.delete.length, 0);
  });

  it('keeps chart symbol, timeframe, pane, and focus untouched during indicator resolution', async () => {
    const mock = mockDeps();
    const result = await syncAlerts({ alerts: [indicatorDefinition()], _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(mock.calls.resolve.length, 1);
    assert.equal(mock.calls.create.length, 1);
    assert.equal(result.created[0].definition.symbol, 'NASDAQ:NVDA');
    assert.equal(result.created[0].definition.timeframe, '1');
    assert.equal('focus' in mock.calls, false);
  });

  it('reports partial creation failures while retaining successful alert IDs', async () => {
    const first = priceDefinition();
    const second = priceDefinition({
      symbol: 'NASDAQ:MSFT',
      message: 'DT|2030-01-02|NASDAQ:MSFT|breakout|1|crossing',
    });
    const mock = mockDeps({
      createResults: [
        { success: true, alert_id: 606 },
        { success: false, error: 'server rejected second alert' },
      ],
    });
    const result = await syncAlerts({ alerts: [first, second], _deps: mock.deps });
    assert.equal(result.success, false);
    assert.deepEqual(result.final_alert_ids, [606]);
    assert.equal(result.created.length, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /second alert/);
  });

  it('dry-run returns a complete diff with zero mutations', async () => {
    const exact = priceDefinition();
    const missing = indicatorDefinition({ symbol: 'NASDAQ:MSFT' });
    const mock = mockDeps({ existing: [existingAlert(exact, 707)] });
    const result = await syncAlerts({ alerts: [exact, missing], dry_run: true, _deps: mock.deps });
    assert.equal(result.success, true);
    assert.equal(result.mutation_count, 0);
    assert.equal(result.unchanged.length, 1);
    assert.equal(result.missing.length, 1);
    assert.equal(mock.calls.resolve.length, 1, 'dry-run resolves exact live Pine capability');
    assert.equal(mock.calls.create.length, 0);
    assert.equal(mock.calls.delete.length, 0);
  });
});

describe('alert MCP contracts', () => {
  it('extends alert_create and registers alerts_sync without duplicating alert_create', () => {
    const registrations = [];
    const server = {
      tool(name, description, schema, handler) { registrations.push({ name, description, schema, handler }); },
    };
    registerAlertTools(server);
    assert.equal(registrations.filter(tool => tool.name === 'alert_create').length, 1);
    const createTool = registrations.find(tool => tool.name === 'alert_create');
    assert.deepEqual(Object.keys(createTool.schema), [
      'symbol', 'timeframe', 'kind', 'condition', 'price', 'indicator',
      'frequency', 'expiration', 'message', 'dry_run',
    ]);
    const syncTool = registrations.find(tool => tool.name === 'alerts_sync');
    assert.ok(syncTool);
    assert.deepEqual(Object.keys(syncTool.schema), ['alerts', 'replace_alert_ids', 'dry_run']);
  });
});
