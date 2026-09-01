import {
  CUP_ALERT_ROUTES,
  CUP_TARGETS,
  SOURCE_BINDINGS,
  sourceBindingFor,
} from './investment-attention-config.js';
import { canonicalJson, sha256 } from './investment-attention-ledger.js';

export const INVESTMENT_ATTENTION_LIVE_SNAPSHOT_SCHEMA_VERSION = 'investment-attention-live-snapshot/v1';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function inputValues(alert) {
  return clone(alert?.condition?.series?.[0]?.inputs ?? alert?.conditions?.[0]?.series?.[0]?.inputs ?? {});
}

function inputHash(values) {
  return sha256(canonicalJson(values));
}

function semanticInputValues(classification, inputs) {
  const limit = classification.family === 'sma_fib' ? 1
    : classification.family === 'rsi' ? 23 : 6;
  return Object.fromEntries(Object.entries(inputs)
    .filter(([key]) => /^in_\d+$/u.test(key) && Number(key.slice(3)) <= limit)
    .sort(([left], [right]) => Number(left.slice(3)) - Number(right.slice(3))));
}

function scriptDetails(alert) {
  const series = alert?.condition?.series?.[0] ?? alert?.conditions?.[0]?.series?.[0] ?? {};
  return {
    script_id: series.pine_id ?? series.script_id ?? null,
    script_version: series.pine_version ?? series.script_version ?? null,
  };
}

function normalizeTimeframe(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === '1D' || raw === 'D' || raw === 'DAY') return 'D';
  if (raw === '1W' || raw === 'W' || raw === 'WEEK') return 'W';
  if (raw === '240' || raw === '240M' || raw === '4H') return '4H';
  return raw;
}

function parseSymbol(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^=/u, '')).symbol ?? text;
  } catch {
    return text;
  }
}

function cupTargetFor(symbol, timeframe) {
  const normalizedSymbol = String(symbol ?? '').toUpperCase();
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  return CUP_TARGETS.find(target => (
    target.feed_symbol.toUpperCase() === normalizedSymbol
    && normalizeTimeframe(target.timeframe) === normalizedTimeframe
  )) ?? null;
}

function classifyCupStage(inputs) {
  if (inputs.in_4 === true || inputs.in_5 === true || inputs.in_6 === true) return 'terminal';
  if (inputs.in_2 === true || inputs.in_3 === true) return 'early';
  return 'unknown';
}

/** Return only the four-family alert rows that belong to this beta. */
export function classifyInvestmentAttentionAlert(alert) {
  const script = scriptDetails(alert);
  const inputs = inputValues(alert);
  const symbol = parseSymbol(alert?.symbol);
  const timeframe = normalizeTimeframe(alert?.condition?.resolution ?? alert?.resolution);
  const name = String(alert?.name ?? '').toLowerCase();

  if (script.script_id === 'USER;a4bbd841edfc4444a2253c71953105bf'
    || script.script_id === 'USER;720227505bc34a03b43abe7248ddb736'
    || (inputs.in_0 && inputs.in_1 && (String(inputs.in_0).startsWith('1') || Number.isInteger(inputs.in_1)))) {
    const profile = normalizeTimeframe(inputs.in_0);
    const shard = Number(inputs.in_1);
    if ((profile === 'D' || profile === 'W') && Number.isSafeInteger(shard) && shard > 0) {
      return { family: 'sma_fib', profile, shard, stage_group: 'scanner', symbol, timeframe, script, inputs };
    }
  }

  if (script.script_id === 'USER;53eb4225f4f44cb4a9c7d5022fd50419'
    || script.script_id === 'USER;7a48561c91f14232aec86357d70a37e4') {
    const profile = normalizeTimeframe(inputs.in_1);
    const shard = String(inputs.in_0 ?? '');
    if ((profile === 'D' || profile === 'W') && shard.startsWith('metals-')) {
      return { family: 'rsi', profile, shard, stage_group: 'scanner', symbol, timeframe, script, inputs };
    }
  }

  const target = cupTargetFor(symbol, timeframe);
  if (target || name.includes('cup handle')) {
    const stageGroup = classifyCupStage(inputs);
    if (target && (stageGroup === 'early' || stageGroup === 'terminal')) {
      return {
        family: 'cup_and_handle',
        profile: normalizeTimeframe(target.timeframe),
        stage_group: stageGroup,
        target_id: target.target_id,
        route_id: `${target.target_id}|${stageGroup}`,
        symbol: target.feed_symbol,
        timeframe: normalizeTimeframe(target.timeframe),
        script,
        inputs,
      };
    }
  }
  return null;
}

function expectedKey(classification) {
  if (classification.family === 'sma_fib') {
    return `sma_fib|${classification.profile}|shard${classification.shard}`;
  }
  if (classification.family === 'rsi') {
    return `rsi|${classification.shard}|${classification.profile}`;
  }
  return `cup_and_handle|${classification.route_id}`;
}

function bindingForClassification(classification) {
  if (classification.family === 'sma_fib') return SOURCE_BINDINGS.sma_fib;
  if (classification.family === 'rsi') return sourceBindingFor('rsi', classification.script.script_id === 'USER;7a48561c91f14232aec86357d70a37e4' ? 2 : 1);
  return SOURCE_BINDINGS.cup_and_handle;
}

/**
 * Convert TradingView's alert-list rows to the explicit source/version/input/
 * feed records consumed by the health reconciler.
 */
export function normalizeInvestmentAttentionLiveAlert(alert, {
  sourceShaByScriptId = {},
  definitionByScriptId = {},
  expectedKeyOverride = null,
} = {}) {
  const classification = classifyInvestmentAttentionAlert(alert);
  if (!classification) return null;
  const binding = bindingForClassification(classification);
  const input = classification.inputs;
  const semanticInputs = semanticInputValues(classification, input);
  const actualSourceSha = sourceShaByScriptId[classification.script.script_id] ?? binding.source_sha256;
  const actualDefinition = definitionByScriptId[classification.script.script_id] ?? binding.definition_version;
  const routeSymbol = classification.symbol ?? alert.symbol;
  const routeTimeframe = classification.profile ?? classification.timeframe;
  const key = expectedKeyOverride ?? expectedKey(classification);
  return {
    ...clone(alert),
    alert_id: String(alert.alert_id),
    family: classification.family,
    expected_key: key,
    route_symbol: routeSymbol,
    route_timeframe: routeTimeframe,
    symbol: routeSymbol,
    timeframe: routeTimeframe,
    feed_symbol: semanticInputs.in_23 ?? routeSymbol,
    source_sha256: actualSourceSha,
    definition_version: actualDefinition,
    input_sha256: inputHash(semanticInputs),
    input_values: semanticInputs,
    stage_group: classification.stage_group,
    target_id: classification.target_id ?? null,
    script_id: classification.script.script_id,
    script_version: classification.script.script_version,
  };
}

function desiredExpectedRow(observed, {
  sourceBinding,
  maximumExpiryAtCreation,
  scriptId = observed.script_id,
  scriptVersion = observed.script_version,
} = {}) {
  return {
    alert_id: observed.alert_id,
    expected_key: observed.expected_key,
    family: observed.family,
    symbol: observed.route_symbol,
    timeframe: observed.route_timeframe,
    route_symbol: observed.route_symbol,
    route_timeframe: observed.route_timeframe,
    feed_symbol: observed.feed_symbol,
    active: true,
    popup: observed.stage_group === 'terminal' ? false : true,
    mobile_push: observed.stage_group === 'terminal' ? false : true,
    web_hook: null,
    source_identity: {
      definition_version: sourceBinding.definition_version,
      source_sha256: sourceBinding.source_sha256,
      script_id: scriptId,
      script_version: scriptVersion,
    },
    input_identity: {
      sha256: observed.input_sha256,
      values: clone(observed.input_values),
    },
    maximum_expiry_at_creation: maximumExpiryAtCreation ?? observed.expiration,
    expiration: maximumExpiryAtCreation ?? observed.expiration,
    stage_group: observed.stage_group,
    target_id: observed.target_id,
  };
}

/**
 * Build a health input from one sanitized alert-list snapshot. Expected rows
 * preserve the live input values but bind them to the release source hashes;
 * this makes source drift visible without treating a stale snapshot as proof
 * of a healthy deployment.
 */
export function buildInvestmentAttentionHealthInput(alerts, {
  sourceShaByScriptId = {},
  definitionByScriptId = {},
  maximumExpiries = {},
  includeInactive = true,
} = {}) {
  if (!Array.isArray(alerts)) throw new TypeError('alerts must be an array');
  const observed = alerts
    .map(alert => normalizeInvestmentAttentionLiveAlert(alert, { sourceShaByScriptId, definitionByScriptId }))
    .filter(Boolean)
    .filter(alert => includeInactive || alert.active !== false);
  const expected = observed.map(row => {
    const binding = bindingForClassification(classifyInvestmentAttentionAlert(alerts.find(alert => String(alert.alert_id) === row.alert_id)));
    return desiredExpectedRow(row, {
      sourceBinding: binding,
      maximumExpiryAtCreation: maximumExpiries[row.expected_key] ?? row.expiration,
    });
  });
  return {
    expected_alerts: expected,
    active_alerts: observed,
    excluded_routes: [],
    observed_at: new Date().toISOString(),
    schema_version: INVESTMENT_ATTENTION_LIVE_SNAPSHOT_SCHEMA_VERSION,
  };
}

/** Build the three missing terminal rows without broadening the Cup cohort. */
export function buildCupTerminalExpectedRows({
  scriptId,
  scriptVersion,
  maximumExpiryAtCreation,
} = {}) {
  return CUP_ALERT_ROUTES.filter(route => route.stage_group === 'terminal').map(route => ({
    expected_key: `cup_and_handle|${route.route_id}`,
    family: 'cup_and_handle',
    symbol: route.feed_symbol,
    timeframe: normalizeTimeframe(route.timeframe),
    route_symbol: route.feed_symbol,
    route_timeframe: normalizeTimeframe(route.timeframe),
    feed_symbol: route.feed_symbol,
    active: true,
    popup: false,
    mobile_push: false,
    web_hook: null,
    source_identity: {
      definition_version: SOURCE_BINDINGS.cup_and_handle.definition_version,
      source_sha256: SOURCE_BINDINGS.cup_and_handle.source_sha256,
      script_id: scriptId ?? null,
      script_version: scriptVersion ?? null,
    },
    input_identity: {
      sha256: inputHash(route.input_definition),
      values: clone(route.input_definition),
    },
    maximum_expiry_at_creation: maximumExpiryAtCreation ?? null,
    expiration: maximumExpiryAtCreation ?? null,
    stage_group: 'terminal',
    target_id: route.target_id,
  }));
}

export function liveSnapshotSourceBindingDefaults() {
  return {
    sma_fib: SOURCE_BINDINGS.sma_fib,
    rsi_s1: SOURCE_BINDINGS.rsi_scanner_s1,
    rsi_s2: SOURCE_BINDINGS.rsi_scanner_s2,
    cup_and_handle: SOURCE_BINDINGS.cup_and_handle,
  };
}
