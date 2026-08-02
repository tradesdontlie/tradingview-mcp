/**
 * Deterministic TradingView alert creation and synchronization.
 *
 * Alert mutations use TradingView's authenticated pricealerts REST endpoint.
 * Pine alertcondition metadata is resolved read-only from studies that are
 * already live on an exact symbol/timeframe pane; no pane focus or chart state
 * changes are required.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';

const PRICE_CONDITIONS = new Set(['crossing', 'greater_than', 'less_than']);
const FREQUENCIES = new Set(['once', 'once_per_bar', 'once_per_bar_close']);
const CONDITION_TO_INTERNAL = {
  crossing: 'cross',
  greater_than: 'greater',
  less_than: 'less',
};
const CONDITION_FROM_INTERNAL = {
  cross: 'crossing',
  greater: 'greater_than',
  less: 'less_than',
};
const FREQUENCY_TO_INTERNAL = {
  once: 'on_first_fire',
  once_per_bar: 'on_each_fire',
  once_per_bar_close: 'on_bar_close',
};
const FREQUENCY_FROM_INTERNAL = Object.fromEntries(
  Object.entries(FREQUENCY_TO_INTERNAL).map(([external, internal]) => [internal, external]),
);

class AlertCapabilityError extends Error {
  constructor(stage, code, message, details = {}) {
    super(message);
    this.name = 'AlertCapabilityError';
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

function errorResult(err, extra = {}) {
  const error = {
    stage: err?.stage || 'unexpected',
    code: err?.code || 'unexpected_error',
    message: err?.message || String(err),
    ...(err?.details || {}),
  };
  return { success: false, stage: error.stage, error, ...extra };
}

function nowValue(deps) {
  const value = typeof deps?.now === 'function' ? deps.now() : deps?.now;
  return value == null ? Date.now() : Number(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AlertCapabilityError('validation', `invalid_${field}`, `${field} is required`);
  }
  return value.trim();
}

function canonicalExpiration(value, now = Date.now()) {
  const text = requireString(value, 'expiration');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new AlertCapabilityError(
      'validation',
      'invalid_expiration',
      'expiration must be an ISO-8601 timestamp with Z or an explicit UTC offset',
    );
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new AlertCapabilityError('validation', 'invalid_expiration', 'expiration is not a valid timestamp');
  }
  if (timestamp <= now) {
    throw new AlertCapabilityError('validation', 'expired_expiration', 'expiration must be in the future');
  }
  return new Date(timestamp).toISOString();
}

/** Validate and normalize the exact public alert contract. */
export function validateAlertDefinition(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AlertCapabilityError('validation', 'invalid_definition', 'alert definition must be an object');
  }

  const symbol = requireString(input.symbol, 'symbol').toUpperCase();
  if (!/^[A-Z0-9._-]+:[A-Z0-9._!\-/]+$/.test(symbol)) {
    throw new AlertCapabilityError(
      'validation',
      'invalid_symbol',
      'symbol must be exchange-qualified (for example NASDAQ:NVDA)',
    );
  }
  const timeframe = requireString(input.timeframe, 'timeframe');
  if (/\s/.test(timeframe)) {
    throw new AlertCapabilityError('validation', 'invalid_timeframe', 'timeframe must not contain whitespace');
  }
  const kind = requireString(input.kind, 'kind').toLowerCase();
  if (kind !== 'price' && kind !== 'indicator') {
    throw new AlertCapabilityError('validation', 'invalid_kind', 'kind must be "price" or "indicator"');
  }
  const condition = requireString(input.condition, 'condition');
  const frequency = requireString(input.frequency, 'frequency').toLowerCase();
  if (!FREQUENCIES.has(frequency)) {
    throw new AlertCapabilityError(
      'validation',
      'invalid_frequency',
      'frequency must be once, once_per_bar, or once_per_bar_close',
    );
  }
  const expiration = canonicalExpiration(input.expiration, options.now ?? Date.now());
  const message = requireString(input.message, 'message');

  const normalized = { symbol, timeframe, kind, condition, frequency, expiration, message };
  if (kind === 'price') {
    if (!PRICE_CONDITIONS.has(condition)) {
      throw new AlertCapabilityError(
        'validation',
        'invalid_price_condition',
        'price condition must be crossing, greater_than, or less_than',
      );
    }
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new AlertCapabilityError('validation', 'invalid_price', 'price alerts require a positive finite price');
    }
    if (input.indicator != null) {
      throw new AlertCapabilityError('validation', 'unexpected_indicator', 'price alerts must not include indicator');
    }
    normalized.price = price;
  } else {
    normalized.indicator = requireString(input.indicator, 'indicator');
    if (input.price != null) {
      throw new AlertCapabilityError('validation', 'unexpected_price', 'indicator alerts must not include price');
    }
  }
  return normalized;
}

function parseSymbol(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value.symbol || '').toUpperCase();
  const text = String(value);
  try {
    const parsed = JSON.parse(text.replace(/^=/, ''));
    return String(parsed.symbol || text).toUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

function presentationStudy(raw, series) {
  const studies = raw?.presentation_data?.studies || {};
  const entries = Object.entries(studies);
  const pineId = String(series?.pine_id || '');
  const exact = entries.find(([key]) => pineId && key.includes(pineId));
  return exact?.[1] || (entries.length === 1 ? entries[0][1] : null);
}

/** Convert a raw list_alerts item into the exact public definition shape. */
export function normalizeListedAlert(raw) {
  const conditionData = raw?.condition || raw?.conditions?.[0] || {};
  const series = Array.isArray(conditionData.series) ? conditionData.series : [];
  const studySeries = series.find(item => item?.type === 'study');
  const valueSeries = series.find(item => item?.type === 'value');
  const kind = raw?.type === 'indicator' || conditionData.type === 'alert_cond' ? 'indicator' : 'price';
  const base = {
    alert_id: raw?.alert_id,
    symbol: parseSymbol(raw?.pro_symbol || raw?.symbol),
    timeframe: String(raw?.resolution || conditionData.resolution || ''),
    kind,
    frequency: FREQUENCY_FROM_INTERNAL[conditionData.frequency] || conditionData.frequency || null,
    expiration: raw?.expiration ? new Date(raw.expiration).toISOString() : null,
    message: raw?.message ?? '',
    active: raw?.active !== false,
    created: raw?.create_time || null,
    last_fired: raw?.last_fire_time || null,
  };

  if (kind === 'price') {
    base.condition = CONDITION_FROM_INTERNAL[conditionData.type] || conditionData.type || null;
    base.price = Number(valueSeries?.value);
  } else {
    const study = presentationStudy(raw, studySeries);
    const conditionMeta = study?.alert_conditions?.[conditionData.alert_cond_id];
    base.condition = conditionMeta?.title || null;
    base.indicator = study?.description || study?.short_description || null;
  }
  return base;
}

async function fetchRawAlerts() {
  return evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(response) { return response.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) {
          return { success: false, error: data.errmsg || 'Unexpected list_alerts response' };
        }
        return { success: true, alerts: data.r };
      })
      .catch(function(error) { return { success: false, error: error.message }; })
  `);
}

async function postCreateAlert(payload) {
  const serialized = JSON.stringify(payload);
  return evaluate(`
    (function() {
      try {
        var payload = JSON.parse(${safeString(serialized)});
        var request = new XMLHttpRequest();
        request.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        request.withCredentials = true;
        request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        request.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(request.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, alert_id: data.r && data.r.alert_id, status: request.status };
        }
        return {
          success: false,
          status: request.status,
          error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + request.status),
          response: (request.responseText || '').slice(0, 500)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    })()
  `);
}

async function postDeleteAlerts(ids) {
  return evaluate(`
    (function() {
      try {
        var request = new XMLHttpRequest();
        request.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        request.withCredentials = true;
        request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        request.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {};
        try { data = JSON.parse(request.responseText); } catch (e) {}
        if (data.s === 'ok') return { success: true, alert_ids: ${JSON.stringify(ids)} };
        return {
          success: false,
          error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + request.status),
          response: (request.responseText || '').slice(0, 500)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    })()
  `);
}

/** Resolve an exact live Pine study and alertcondition without changing panes. */
export async function resolveLiveIndicator(definition) {
  const result = await evaluate(`
    (function() {
      var requestedSymbol = ${safeString(definition.symbol)};
      var requestedTimeframe = ${safeString(definition.timeframe)};
      var requestedIndicator = ${safeString(definition.indicator)};
      var requestedCondition = ${safeString(definition.condition)};
      var collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var panes = collection && collection.getAll ? collection.getAll() : [];
      var matchingPanes = [], indicatorCandidates = [], matches = [];

      for (var i = 0; i < panes.length; i++) {
        try {
          var model = panes[i].model();
          var mainSeries = model.mainSeries();
          var symbol = (mainSeries.proSymbol && mainSeries.proSymbol()) || mainSeries.symbol();
          var timeframe = String(mainSeries.interval());
          var paneInfo = { pane_index: i, symbol: symbol, timeframe: timeframe, indicators: [] };
          var sources = model.model().dataSources();
          for (var j = 0; j < sources.length; j++) {
            var source = sources[j], meta = null;
            try { meta = source.metaInfo && source.metaInfo(); } catch (e) {}
            if (!meta || !meta.description) continue;
            var plots = Array.isArray(meta.plots) ? meta.plots : [];
            var alertPlots = plots.filter(function(plot) { return plot.type === 'alertcondition'; });
            if (!alertPlots.length) continue;
            var conditionNames = alertPlots.map(function(plot) {
              return { id: plot.id, title: meta.styles && meta.styles[plot.id] && meta.styles[plot.id].title };
            }).filter(function(item) { return !!item.title; });
            paneInfo.indicators.push({ title: meta.description, conditions: conditionNames.map(function(item) { return item.title; }) });
            if (meta.description !== requestedIndicator) continue;
            indicatorCandidates.push({ pane_index: i, symbol: symbol, timeframe: timeframe, conditions: conditionNames.map(function(item) { return item.title; }) });
            if (symbol !== requestedSymbol || timeframe !== requestedTimeframe) continue;
            var conditionMatches = conditionNames.filter(function(item) { return item.title === requestedCondition; });
            if (conditionMatches.length !== 1) continue;

            var state = {};
            try { state = source.properties().state(); } catch (e) {}
            var inputs = Object.assign({}, state.inputs || {});
            delete inputs.text;
            delete inputs.pineId;
            delete inputs.pineVersion;
            var offsets = {};
            plots.forEach(function(plot) { if (plot.type !== 'alertcondition') offsets[plot.id] = 0; });
            matches.push({
              pane_index: i,
              symbol: symbol,
              timeframe: timeframe,
              indicator: meta.description,
              condition: requestedCondition,
              alert_condition_id: conditionMatches[0].id,
              series: {
                type: 'study',
                study: 'Script@tv-scripting-' + meta.version,
                pine_id: meta.scriptIdPart,
                pine_version: meta.pine && meta.pine.version,
                inputs: inputs,
                offsets_by_plot: offsets
              }
            });
          }
          if (symbol === requestedSymbol && timeframe === requestedTimeframe) matchingPanes.push(paneInfo);
        } catch (e) {}
      }
      return { matches: matches, matching_panes: matchingPanes, indicator_candidates: indicatorCandidates };
    })()
  `);

  if (result?.matches?.length === 1) return result.matches[0];
  if (result?.matches?.length > 1) {
    throw new AlertCapabilityError(
      'indicator_resolution',
      'ambiguous_indicator',
      'More than one live study exactly matches the requested indicator condition',
      { matches: result.matches.map(item => ({ pane_index: item.pane_index })) },
    );
  }
  if (!result?.matching_panes?.length) {
    throw new AlertCapabilityError(
      'indicator_resolution',
      'exact_pane_not_found',
      'Indicator alerts require an already-open pane with the exact canonical symbol and timeframe',
      { indicator_candidates: result?.indicator_candidates || [] },
    );
  }
  const exactIndicator = (result.indicator_candidates || []).filter(item => (
    item.symbol === definition.symbol && item.timeframe === definition.timeframe
  ));
  if (!exactIndicator.length) {
    throw new AlertCapabilityError(
      'indicator_resolution',
      'indicator_not_found',
      'The exact live indicator title is not present on the requested symbol/timeframe pane',
      { available_indicators: result.matching_panes.flatMap(item => item.indicators || []) },
    );
  }
  throw new AlertCapabilityError(
    'indicator_resolution',
    'condition_not_found',
    'The exact Pine alertcondition() name is not present on the requested live indicator',
    { available_conditions: [...new Set(exactIndicator.flatMap(item => item.conditions || []))] },
  );
}

/** Build the exact payload understood by TradingView's structured alert API. */
export function buildAlertPayload(definition, indicatorResolution = null) {
  const internalFrequency = FREQUENCY_TO_INTERNAL[definition.frequency];
  let condition;
  if (definition.kind === 'price') {
    condition = {
      type: CONDITION_TO_INTERNAL[definition.condition],
      frequency: internalFrequency,
      series: [{ type: 'barset' }, { type: 'value', value: definition.price }],
      resolution: definition.timeframe,
    };
  } else {
    if (!indicatorResolution?.series || !indicatorResolution?.alert_condition_id) {
      throw new AlertCapabilityError(
        'indicator_resolution',
        'indicator_metadata_unavailable',
        'Exact live Pine alertcondition metadata is unavailable',
      );
    }
    condition = {
      type: 'alert_cond',
      frequency: internalFrequency,
      series: [indicatorResolution.series],
      alert_cond_id: indicatorResolution.alert_condition_id,
      cross_interval: false,
      resolution: definition.timeframe,
    };
  }

  return {
    conditions: [condition],
    symbol: `=${JSON.stringify({ symbol: definition.symbol })}`,
    resolution: definition.timeframe,
    message: definition.message,
    sound_file: 'alert/fired',
    sound_duration: 0,
    popup: true,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: null,
    expiration: definition.expiration,
    active: true,
    ignore_warnings: false,
  };
}

function resolveDeps(deps = {}) {
  return {
    fetchRawAlerts: deps.fetchRawAlerts || fetchRawAlerts,
    createRaw: deps.createRaw || postCreateAlert,
    deleteRaw: deps.deleteRaw || postDeleteAlerts,
    resolveIndicator: deps.resolveIndicator || resolveLiveIndicator,
    listAlerts: deps.listAlerts,
    now: nowValue(deps),
  };
}

export async function list({ _deps } = {}) {
  const deps = resolveDeps(_deps);
  try {
    const result = await deps.fetchRawAlerts();
    if (!result?.success) {
      throw new AlertCapabilityError('list', 'list_failed', result?.error || 'Could not list alerts');
    }
    const alerts = (result.alerts || []).map(normalizeListedAlert);
    return { success: true, alert_count: alerts.length, source: 'internal_api', alerts };
  } catch (err) {
    return errorResult(err, { source: 'internal_api', alerts: [], alert_count: 0 });
  }
}

async function createValidated(definition, deps, indicatorResolution) {
  const payload = buildAlertPayload(definition, indicatorResolution);
  const result = await deps.createRaw(payload);
  if (!result?.success || result.alert_id == null) {
    throw new AlertCapabilityError(
      'create',
      'create_failed',
      result?.error || 'TradingView did not return an alert ID',
      { response: result?.response, status: result?.status },
    );
  }
  return { alert_id: result.alert_id, payload };
}

export async function create(args = {}) {
  const deps = resolveDeps(args._deps);
  try {
    const definition = validateAlertDefinition(args, { now: deps.now });
    const indicatorResolution = definition.kind === 'indicator'
      ? await deps.resolveIndicator(definition)
      : null;
    if (args.dry_run === true) {
      return {
        success: true,
        action: 'dry_run',
        dry_run: true,
        definition,
        chart_state_changed: false,
        ...(indicatorResolution && {
          resolved_indicator: {
            pane_index: indicatorResolution.pane_index,
            alert_condition_id: indicatorResolution.alert_condition_id,
          },
        }),
      };
    }
    const created = await createValidated(definition, deps, indicatorResolution);
    return {
      success: true,
      action: 'created',
      source: 'internal_api',
      alert_id: created.alert_id,
      definition,
      chart_state_changed: false,
    };
  } catch (err) {
    return errorResult(err, { chart_state_changed: false });
  }
}

function definitionFromExisting(alert) {
  const definition = {
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    kind: alert.kind,
    condition: alert.condition,
    frequency: alert.frequency,
    expiration: alert.expiration,
    message: alert.message,
  };
  if (alert.kind === 'price') definition.price = alert.price;
  if (alert.kind === 'indicator') definition.indicator = alert.indicator;
  return definition;
}

function sameInstant(left, right) {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
}

function exactDefinition(left, right) {
  return left.symbol === right.symbol
    && left.timeframe === right.timeframe
    && left.kind === right.kind
    && left.condition === right.condition
    && left.frequency === right.frequency
    && sameInstant(left.expiration, right.expiration)
    && left.message === right.message
    && (left.kind !== 'price' || left.price === right.price)
    && (left.kind !== 'indicator' || left.indicator === right.indicator);
}

function sameAlertIdentity(left, right) {
  if (left.symbol !== right.symbol || left.timeframe !== right.timeframe || left.kind !== right.kind) return false;
  if (left.kind === 'price') return left.condition === right.condition && left.price === right.price;
  return left.indicator === right.indicator && left.condition === right.condition;
}

function definitionKey(definition) {
  return JSON.stringify([
    definition.symbol,
    definition.timeframe,
    definition.kind,
    definition.condition,
    definition.price ?? null,
    definition.indicator ?? null,
    definition.frequency,
    Date.parse(definition.expiration),
    definition.message,
  ]);
}

/** Pure classification helper used by alerts_sync and focused tests. */
export function classifyAlertPlan(definitions, existingAlerts, replaceAlertIds = []) {
  const replaceIds = new Set(replaceAlertIds.map(String));
  const unchanged = [], missing = [], conflict = [], replace = [];
  const referencedIds = new Set();

  definitions.forEach((definition, index) => {
    const exact = existingAlerts.filter(alert => alert.active !== false && exactDefinition(definition, definitionFromExisting(alert)));
    if (exact.length) {
      exact.forEach(alert => referencedIds.add(String(alert.alert_id)));
      unchanged.push({ index, definition, alert_ids: exact.map(alert => alert.alert_id) });
      return;
    }
    const related = existingAlerts.filter(alert => sameAlertIdentity(definition, definitionFromExisting(alert)));
    if (!related.length) {
      missing.push({ index, definition });
      return;
    }
    related.forEach(alert => referencedIds.add(String(alert.alert_id)));
    const approved = related.filter(alert => replaceIds.has(String(alert.alert_id)));
    const item = {
      index,
      definition,
      existing: related.map(alert => ({ alert_id: alert.alert_id, active: alert.active, definition: definitionFromExisting(alert) })),
    };
    if (approved.length === related.length) {
      replace.push({ ...item, replace_alert_ids: approved.map(alert => alert.alert_id) });
    } else {
      conflict.push({ ...item, approved_replace_alert_ids: approved.map(alert => alert.alert_id) });
    }
  });

  const allReferenced = new Set([...referencedIds]);
  const unrelated = existingAlerts.filter(alert => !allReferenced.has(String(alert.alert_id)));
  const claimedReplacementIds = new Set([
    ...replace.flatMap(item => item.replace_alert_ids.map(String)),
    ...conflict.flatMap(item => item.approved_replace_alert_ids.map(String)),
  ]);
  const unclaimed_replace_alert_ids = replaceAlertIds.filter(id => !claimedReplacementIds.has(String(id)));
  return { unchanged, missing, conflict, replace, unrelated, unclaimed_replace_alert_ids };
}

function validatePlan(alerts, now) {
  if (!Array.isArray(alerts)) {
    throw new AlertCapabilityError('plan_validation', 'invalid_alerts', 'alerts must be an array');
  }
  const definitions = [];
  const failures = [];
  alerts.forEach((alert, index) => {
    try {
      definitions.push(validateAlertDefinition(alert, { now }));
    } catch (err) {
      failures.push({ index, error: { stage: err.stage, code: err.code, message: err.message, ...(err.details || {}) } });
    }
  });
  if (failures.length) {
    throw new AlertCapabilityError(
      'plan_validation',
      'invalid_plan',
      'The alert plan contains invalid definitions; no mutations were made',
      { failed: failures },
    );
  }
  const seen = new Map();
  const duplicates = [];
  definitions.forEach((definition, index) => {
    const key = definitionKey(definition);
    if (seen.has(key)) duplicates.push({ first_index: seen.get(key), duplicate_index: index });
    else seen.set(key, index);
  });
  if (duplicates.length) {
    throw new AlertCapabilityError(
      'plan_validation',
      'duplicate_plan_definitions',
      'The alert plan contains duplicate definitions; no mutations were made',
      { duplicates },
    );
  }
  return definitions;
}

async function getExistingAlerts(deps) {
  if (deps.listAlerts) return deps.listAlerts();
  const raw = await deps.fetchRawAlerts();
  if (!raw?.success) {
    throw new AlertCapabilityError('list', 'list_failed', raw?.error || 'Could not list existing alerts');
  }
  return { success: true, alerts: (raw.alerts || []).map(normalizeListedAlert) };
}

export async function syncAlerts({ alerts, replace_alert_ids = [], dry_run = false, _deps } = {}) {
  const deps = resolveDeps(_deps);
  let definitions;
  try {
    definitions = validatePlan(alerts, deps.now);
    if (!Array.isArray(replace_alert_ids) || replace_alert_ids.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      throw new AlertCapabilityError(
        'plan_validation',
        'invalid_replace_alert_ids',
        'replace_alert_ids must contain positive integer alert IDs',
      );
    }
    replace_alert_ids = [...new Set(replace_alert_ids.map(Number))];

    const listed = await getExistingAlerts(deps);
    if (!listed?.success) throw new AlertCapabilityError('list', 'list_failed', listed?.error || 'Could not list existing alerts');
    const existing = listed.alerts || [];
    const diff = classifyAlertPlan(definitions, existing, replace_alert_ids);
    if (diff.unclaimed_replace_alert_ids.length) {
      throw new AlertCapabilityError(
        'plan_validation',
        'unrelated_replace_ids',
        'Every replace_alert_id must identify a conflicting alert in this exact plan',
        { replace_alert_ids: diff.unclaimed_replace_alert_ids },
      );
    }

    const replacementClaims = new Map();
    for (const item of diff.replace) {
      for (const id of item.replace_alert_ids) {
        const key = String(id);
        if (!replacementClaims.has(key)) replacementClaims.set(key, []);
        replacementClaims.get(key).push(item.index);
      }
    }
    const duplicateReplacementClaims = [...replacementClaims.entries()]
      .filter(([, indexes]) => indexes.length > 1)
      .map(([alert_id, indexes]) => ({ alert_id: Number(alert_id), indexes }));
    if (duplicateReplacementClaims.length) {
      throw new AlertCapabilityError(
        'plan_validation',
        'ambiguous_replace_ids',
        'A replace_alert_id cannot be claimed by more than one planned alert',
        { claims: duplicateReplacementClaims },
      );
    }

    // Resolve every Pine definition before the first mutation, including in a
    // dry-run. Unsupported entries are reported per item, while the diff
    // remains complete and no fallback condition is ever substituted.
    const actionable = [...diff.missing, ...diff.replace];
    const resolutions = new Map();
    const failed = [];
    for (const item of actionable) {
      if (item.definition.kind !== 'indicator') continue;
      try {
        resolutions.set(item.index, await deps.resolveIndicator(item.definition));
      } catch (err) {
        failed.push({ index: item.index, definition: item.definition, stage: err.stage || 'indicator_resolution', error: err.message });
      }
    }

    if (dry_run === true) {
      return {
        success: failed.length === 0,
        action: 'dry_run',
        dry_run: true,
        unchanged: diff.unchanged,
        missing: diff.missing,
        conflicts: diff.conflict,
        replace: diff.replace,
        failed,
        unrelated_preserved: diff.unrelated.map(alert => alert.alert_id),
        mutation_count: 0,
      };
    }

    const failedIndexes = new Set(failed.map(item => item.index));
    const created = [];
    const replaced = [];
    for (const item of diff.missing) {
      if (failedIndexes.has(item.index)) continue;
      try {
        const result = await createValidated(item.definition, deps, resolutions.get(item.index));
        created.push({ alert_id: result.alert_id, definition: item.definition });
      } catch (err) {
        failed.push({ index: item.index, definition: item.definition, stage: err.stage || 'create', error: err.message });
      }
    }
    for (const item of diff.replace) {
      if (failedIndexes.has(item.index)) continue;
      const deleted = await deps.deleteRaw(item.replace_alert_ids);
      if (!deleted?.success) {
        failed.push({
          index: item.index,
          definition: item.definition,
          stage: 'delete_replaced_alert',
          error: deleted?.error || 'Could not delete approved replacement alert',
          replace_alert_ids: item.replace_alert_ids,
        });
        continue;
      }
      try {
        const result = await createValidated(item.definition, deps, resolutions.get(item.index));
        replaced.push({
          alert_id: result.alert_id,
          replaced_alert_ids: item.replace_alert_ids,
          definition: item.definition,
        });
      } catch (err) {
        failed.push({
          index: item.index,
          definition: item.definition,
          stage: err.stage || 'create_replacement',
          error: err.message,
          deleted_alert_ids: item.replace_alert_ids,
        });
      }
    }

    const unchanged = diff.unchanged.map(item => ({ alert_ids: item.alert_ids, definition: item.definition }));
    const final_alert_ids = [
      ...unchanged.flatMap(item => item.alert_ids),
      ...created.map(item => item.alert_id),
      ...replaced.map(item => item.alert_id),
    ];
    return {
      success: failed.length === 0 && diff.conflict.length === 0,
      created,
      unchanged,
      replaced,
      conflicts: diff.conflict,
      failed,
      final_alert_ids: [...new Set(final_alert_ids)],
      unrelated_preserved: diff.unrelated.map(alert => alert.alert_id),
    };
  } catch (err) {
    return errorResult(err, {
      created: [],
      unchanged: [],
      replaced: [],
      conflicts: [],
      failed: err?.details?.failed || [],
      final_alert_ids: [],
    });
  }
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id, _deps } = {}) {
  const deps = resolveDeps(_deps);
  try {
    let ids = [];
    if (Array.isArray(alert_ids)) ids.push(...alert_ids);
    if (alert_id != null) ids.push(alert_id);
    if (delete_all) {
      const listed = await getExistingAlerts(deps);
      if (!listed?.success) throw new AlertCapabilityError('list', 'list_failed', 'Could not list alerts before deletion');
      ids = (listed.alerts || []).map(alert => alert.alert_id);
    }
    ids = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) {
      throw new AlertCapabilityError(
        'validation',
        'missing_alert_ids',
        delete_all ? 'No alerts to delete' : 'Provide alert_id, alert_ids, or delete_all: true',
      );
    }
    const result = await deps.deleteRaw(ids);
    if (!result?.success) {
      throw new AlertCapabilityError('delete', 'delete_failed', result?.error || 'Alert deletion failed');
    }
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  } catch (err) {
    return errorResult(err, { source: 'internal_api' });
  }
}
