import { createHash } from 'node:crypto';

export const CUP_HANDLE_ALERT_SET_SCHEMA_V1 = 'cup-handle-alert-set-v1';
export const CUP_HANDLE_ALERT_SET_MANIFEST_SCHEMA_V1 = 'cup-handle-alert-set-manifest-v1';
export const CUP_HANDLE_ALERT_SET_PLAN_SCHEMA_V1 = 'cup-handle-alert-set-plan-v1';
export const CUP_HANDLE_ALERT_SET_RECEIPT_SCHEMA_V1 = 'cup-handle-alert-set-receipt-v1';
export const CUP_HANDLE_ALERT_SET_MANAGER_V1 = 'cup-handle-alert-set-v1';

export const CUP_HANDLE_ALERT_STAGES_V1 = Object.freeze([
  'rim_approach',
  'handle_forming',
  'handle_ready',
  'breakout_confirmed',
  'invalidated_or_expired',
]);

export const CUP_HANDLE_SUPPORTED_TIMEFRAMES_V1 = Object.freeze(['4H', '1D', '1W']);

export const DEFAULT_CUP_HANDLE_SOURCE_IDENTITY_V1 = Object.freeze({
  pine_script_id: 'USER;5ef3959331454d5c8dbabae491ac3eed',
  pine_version: '2.0',
  pine_source_sha256: '0247dd799161f4cfde61f172f24bbfd5888b8934008d87ded5e922e6e936483e',
  detector_version: '0.2.0-cleanroom',
  policy_id: 'ch-recognition-v1',
});

export const DEFAULT_CUP_HANDLE_PINE_INPUT_IDENTITY_V1 = Object.freeze({
  showGeometry: true,
  showTransitionLabels: true,
  alertRimApproach: true,
  alertHandleForming: true,
  alertHandleReady: false,
  alertPriceBreakout: false,
  alertInvalidated: false,
});

export const DEFAULT_CUP_HANDLE_STAGE_ROUTING_V1 = Object.freeze({
  rim_approach: Object.freeze({
    input_name: 'alertRimApproach',
    condition_name: 'Cup-and-Handle Early Attention',
    enabled: true,
  }),
  handle_forming: Object.freeze({
    input_name: 'alertHandleForming',
    condition_name: 'Cup-and-Handle Early Attention',
    enabled: true,
  }),
  handle_ready: Object.freeze({
    input_name: 'alertHandleReady',
    condition_name: 'Cup-and-Handle Handle Ready',
    enabled: false,
  }),
  breakout_confirmed: Object.freeze({
    input_name: 'alertPriceBreakout',
    condition_name: 'Cup-and-Handle Price Breakout Confirmed',
    enabled: false,
  }),
  invalidated_or_expired: Object.freeze({
    input_name: 'alertInvalidated',
    condition_name: 'Cup-and-Handle Invalidated or Expired',
    enabled: false,
  }),
});

export const DEFAULT_CUP_HANDLE_TARGETS_V1 = Object.freeze([
  Object.freeze({
    target_id: 'NASDAQ_NVDA_1D',
    requested_symbol: 'NASDAQ:NVDA',
    feed_symbol: 'BATS:NVDA',
    display_label: 'NASDAQ:NVDA',
    timeframe: '1D',
  }),
  Object.freeze({
    target_id: 'NASDAQ_TSLA_1W',
    requested_symbol: 'NASDAQ:TSLA',
    feed_symbol: 'BATS:TSLA',
    display_label: 'NASDAQ:TSLA',
    timeframe: '1W',
  }),
  Object.freeze({
    target_id: 'BINANCE_BTCUSDT_4H',
    requested_symbol: 'BINANCE:BTCUSDT',
    feed_symbol: 'BINANCE:BTCUSDT',
    display_label: 'BINANCE:BTCUSDT',
    timeframe: '4H',
  }),
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const SCRIPT_ID = /^USER;[A-Za-z0-9_-]+$/u;
const SYMBOL = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/u;
const ALERT_ID = /^[A-Za-z0-9_-]+$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code, message, details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('malformed_input', `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail('malformed_input', `${label} field membership is invalid`);
  }
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('malformed_input', `${label} must be a nonempty string`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('malformed_input', `${label} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) fail('malformed_input', `${label} is not acyclic JSON`);
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry, index) => canonical(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('malformed_input', `${label} contains a non-plain object`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('malformed_input', `${label}.${key} is undefined`);
    result[key] = canonical(value[key], `${label}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value, label) {
  return JSON.stringify(canonical(value, label));
}

function freeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function iso(value, label, { strictlyAfter = null } = {}) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('malformed_input', `${label} must be a millisecond ISO timestamp`);
  }
  if (strictlyAfter !== null && Date.parse(value) <= Date.parse(strictlyAfter)) {
    fail('expiration_invalid', `${label} must be after ${strictlyAfter}`);
  }
  return value;
}

function exactSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('malformed_input', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') fail('malformed_input', `${label} must be boolean`);
  return value;
}

function normalizeSourceIdentity(value) {
  exactKeys(value, Object.keys(DEFAULT_CUP_HANDLE_SOURCE_IDENTITY_V1), 'source_identity');
  if (!SCRIPT_ID.test(value.pine_script_id)) fail('malformed_input', 'source_identity.pine_script_id is invalid');
  nonempty(value.pine_version, 'source_identity.pine_version');
  exactSha(value.pine_source_sha256, 'source_identity.pine_source_sha256');
  nonempty(value.detector_version, 'source_identity.detector_version');
  nonempty(value.policy_id, 'source_identity.policy_id');
  return {
    pine_script_id: value.pine_script_id,
    pine_version: value.pine_version,
    pine_source_sha256: value.pine_source_sha256,
    detector_version: value.detector_version,
    policy_id: value.policy_id,
  };
}

function normalizeInputs(value) {
  exactKeys(value, Object.keys(DEFAULT_CUP_HANDLE_PINE_INPUT_IDENTITY_V1), 'pine_input_identity');
  const result = {};
  for (const key of Object.keys(DEFAULT_CUP_HANDLE_PINE_INPUT_IDENTITY_V1)) result[key] = exactBoolean(value[key], `pine_input_identity.${key}`);
  return result;
}

function normalizeStageRouting(value, inputs) {
  exactKeys(value, CUP_HANDLE_ALERT_STAGES_V1, 'stage_routing');
  const result = {};
  const inputForStage = {
    rim_approach: 'alertRimApproach',
    handle_forming: 'alertHandleForming',
    handle_ready: 'alertHandleReady',
    breakout_confirmed: 'alertPriceBreakout',
    invalidated_or_expired: 'alertInvalidated',
  };
  for (const stage of CUP_HANDLE_ALERT_STAGES_V1) {
    exactKeys(value[stage], ['input_name', 'condition_name', 'enabled'], `stage_routing.${stage}`);
    if (value[stage].input_name !== inputForStage[stage]) fail('input_identity_mismatch', `stage_routing.${stage}.input_name is not the installed Pine input`);
    nonempty(value[stage].condition_name, `stage_routing.${stage}.condition_name`);
    const enabled = exactBoolean(value[stage].enabled, `stage_routing.${stage}.enabled`);
    if (inputs[inputForStage[stage]] !== enabled) fail('input_identity_mismatch', `stage_routing.${stage}.enabled disagrees with pine_input_identity`);
    result[stage] = {
      input_name: value[stage].input_name,
      condition_name: value[stage].condition_name,
      enabled,
    };
  }
  return result;
}

function normalizeTarget(value, index) {
  exactKeys(value, ['target_id', 'requested_symbol', 'feed_symbol', 'display_label', 'timeframe'], `targets[${index}]`);
  nonempty(value.target_id, `targets[${index}].target_id`);
  if (!SYMBOL.test(value.requested_symbol)) fail('malformed_input', `targets[${index}].requested_symbol is invalid`);
  if (!SYMBOL.test(value.feed_symbol)) fail('malformed_input', `targets[${index}].feed_symbol is invalid`);
  nonempty(value.display_label, `targets[${index}].display_label`);
  if (!CUP_HANDLE_SUPPORTED_TIMEFRAMES_V1.includes(value.timeframe)) fail('unsupported_pair', `targets[${index}].timeframe is unsupported`);
  return {
    target_id: value.target_id,
    requested_symbol: value.requested_symbol,
    feed_symbol: value.feed_symbol,
    display_label: value.display_label,
    timeframe: value.timeframe,
  };
}

function normalizeManifest(value) {
  exactKeys(value, [
    'schema_version', 'manifest_version', 'source_identity', 'pine_input_identity',
    'stage_routing', 'condition_name', 'targets',
  ], 'manifest');
  if (value.schema_version !== CUP_HANDLE_ALERT_SET_MANIFEST_SCHEMA_V1) fail('schema_mismatch', 'manifest schema_version is invalid');
  if (value.manifest_version !== '1.0.0') fail('schema_mismatch', 'manifest_version is invalid');
  const sourceIdentity = normalizeSourceIdentity(value.source_identity);
  const inputIdentity = normalizeInputs(value.pine_input_identity);
  const stageRouting = normalizeStageRouting(value.stage_routing, inputIdentity);
  nonempty(value.condition_name, 'condition_name');
  if (!Array.isArray(value.targets) || value.targets.length === 0) fail('malformed_input', 'manifest.targets must be nonempty');
  const targets = value.targets.map(normalizeTarget);
  const targetIds = new Set();
  const targetPairs = new Set();
  for (const target of targets) {
    if (targetIds.has(target.target_id)) fail('ambiguous_manifest', `duplicate target_id ${target.target_id}`);
    const pair = `${target.requested_symbol}|${target.timeframe}`;
    if (targetPairs.has(pair)) fail('ambiguous_manifest', `duplicate supported pair ${pair}`);
    targetIds.add(target.target_id);
    targetPairs.add(pair);
  }
  return freeze({
    schema_version: CUP_HANDLE_ALERT_SET_MANIFEST_SCHEMA_V1,
    manifest_version: '1.0.0',
    source_identity: sourceIdentity,
    pine_input_identity: inputIdentity,
    stage_routing: stageRouting,
    condition_name: value.condition_name,
    targets: targets.sort((left, right) => left.target_id.localeCompare(right.target_id)),
  });
}

export function createCupHandleAlertManifestV1({
  source_identity = DEFAULT_CUP_HANDLE_SOURCE_IDENTITY_V1,
  pine_input_identity = DEFAULT_CUP_HANDLE_PINE_INPUT_IDENTITY_V1,
  stage_routing = DEFAULT_CUP_HANDLE_STAGE_ROUTING_V1,
  condition_name = 'Cup-and-Handle Early Attention',
  targets = DEFAULT_CUP_HANDLE_TARGETS_V1,
} = {}) {
  return normalizeManifest({
    schema_version: CUP_HANDLE_ALERT_SET_MANIFEST_SCHEMA_V1,
    manifest_version: '1.0.0',
    source_identity,
    pine_input_identity,
    stage_routing,
    condition_name,
    targets,
  });
}

export function validateCupHandleAlertManifestV1(manifest) {
  return normalizeManifest(manifest);
}

export function cupHandleAlertSetSha256V1(value) {
  return sha256(canonicalJson(value, 'hash input'));
}

function desiredAlert(manifest, target) {
  const identity = {
    target_id: target.target_id,
    requested_symbol: target.requested_symbol,
    feed_symbol: target.feed_symbol,
    timeframe: target.timeframe,
    condition_name: manifest.condition_name,
    source_identity: manifest.source_identity,
    pine_input_identity: manifest.pine_input_identity,
    stage_routing: manifest.stage_routing,
  };
  return {
    desired_alert_key: cupHandleAlertSetSha256V1(identity),
    managed_by: CUP_HANDLE_ALERT_SET_MANAGER_V1,
    target_id: target.target_id,
    requested_symbol: target.requested_symbol,
    feed_symbol: target.feed_symbol,
    display_label: target.display_label,
    timeframe: target.timeframe,
    condition_name: manifest.condition_name,
    source_identity: manifest.source_identity,
    pine_input_identity: manifest.pine_input_identity,
    stage_routing: manifest.stage_routing,
  };
}

function normalizeMaximumEvidence(value, label) {
  exactKeys(value, [
    'expiration_policy', 'requested_expiration',
    'platform_maximum_expiration_at_set', 'accepted_expiration',
  ], label);
  if (value.expiration_policy !== 'platform_maximum') fail('maximum_evidence_invalid', `${label}.expiration_policy is not platform_maximum`);
  const requested = iso(value.requested_expiration, `${label}.requested_expiration`);
  const setMaximum = iso(value.platform_maximum_expiration_at_set, `${label}.platform_maximum_expiration_at_set`);
  const accepted = iso(value.accepted_expiration, `${label}.accepted_expiration`);
  if (requested !== setMaximum || setMaximum !== accepted) {
    fail('maximum_evidence_invalid', `${label} does not prove exact maximum-expiry acceptance`);
  }
  return {
    expiration_policy: value.expiration_policy,
    requested_expiration: requested,
    platform_maximum_expiration_at_set: setMaximum,
    accepted_expiration: accepted,
  };
}

function normalizeExistingAlert(value, index) {
  if (!plain(value, `existing_alerts[${index}]`)) return null;
  if (value.managed_by !== CUP_HANDLE_ALERT_SET_MANAGER_V1) return null;
  exactKeys(value, [
    'managed_by', 'alert_id', 'desired_alert_key', 'target_id', 'requested_symbol',
    'feed_symbol', 'display_label', 'timeframe', 'condition_name', 'source_identity',
    'pine_input_identity', 'stage_routing', 'active', 'expiration', 'expiration_policy',
    'requested_expiration', 'platform_maximum_expiration_at_set', 'accepted_expiration',
  ], `existing_alerts[${index}]`);
  if (!ALERT_ID.test(value.alert_id)) fail('malformed_existing_alert', `existing_alerts[${index}].alert_id is invalid`);
  exactSha(value.desired_alert_key, `existing_alerts[${index}].desired_alert_key`);
  nonempty(value.target_id, `existing_alerts[${index}].target_id`);
  if (!SYMBOL.test(value.requested_symbol) || !SYMBOL.test(value.feed_symbol)) fail('malformed_existing_alert', `existing_alerts[${index}] symbol identity is invalid`);
  nonempty(value.display_label, `existing_alerts[${index}].display_label`);
  if (!CUP_HANDLE_SUPPORTED_TIMEFRAMES_V1.includes(value.timeframe)) fail('malformed_existing_alert', `existing_alerts[${index}].timeframe is unsupported`);
  nonempty(value.condition_name, `existing_alerts[${index}].condition_name`);
  const sourceIdentity = normalizeSourceIdentity(value.source_identity);
  const inputIdentity = normalizeInputs(value.pine_input_identity);
  const stageRouting = normalizeStageRouting(value.stage_routing, inputIdentity);
  exactBoolean(value.active, `existing_alerts[${index}].active`);
  const expiration = iso(value.expiration, `existing_alerts[${index}].expiration`);
  const maximumEvidence = normalizeMaximumEvidence({
    expiration_policy: value.expiration_policy,
    requested_expiration: value.requested_expiration,
    platform_maximum_expiration_at_set: value.platform_maximum_expiration_at_set,
    accepted_expiration: value.accepted_expiration,
  }, `existing_alerts[${index}].maximum_evidence`);
  if (expiration !== maximumEvidence.accepted_expiration) fail('maximum_evidence_invalid', `existing_alerts[${index}].expiration differs from accepted_expiration`);
  return {
    managed_by: value.managed_by,
    alert_id: value.alert_id,
    desired_alert_key: value.desired_alert_key,
    target_id: value.target_id,
    requested_symbol: value.requested_symbol,
    feed_symbol: value.feed_symbol,
    display_label: value.display_label,
    timeframe: value.timeframe,
    condition_name: value.condition_name,
    source_identity: sourceIdentity,
    pine_input_identity: inputIdentity,
    stage_routing: stageRouting,
    active: value.active,
    expiration,
    maximum_evidence: maximumEvidence,
  };
}

function expirationForOperation(value, label, now) {
  return iso(value, label, { strictlyAfter: now });
}

export function enforceMaximumExpirationV1({ requested_expiration, platform_maximum_expiration, now }) {
  const requested = expirationForOperation(requested_expiration, 'requested_expiration', now);
  const maximum = expirationForOperation(platform_maximum_expiration, 'platform_maximum_expiration', now);
  if (requested !== maximum) {
    fail('shorter_expiration_rejected', 'created and renewed alerts must request the platform maximum expiration', {
      requested_expiration: requested,
      platform_maximum_expiration: maximum,
    });
  }
  return maximum;
}

function actionRequest(alert, platformMaximumExpiration, now) {
  const expiration = enforceMaximumExpirationV1({
    requested_expiration: platformMaximumExpiration,
    platform_maximum_expiration: platformMaximumExpiration,
    now,
  });
  return {
    managed_by: alert.managed_by,
    desired_alert_key: alert.desired_alert_key,
    target_id: alert.target_id,
    requested_symbol: alert.requested_symbol,
    feed_symbol: alert.feed_symbol,
    display_label: alert.display_label,
    timeframe: alert.timeframe,
    condition_name: alert.condition_name,
    source_identity: alert.source_identity,
    pine_input_identity: alert.pine_input_identity,
    stage_routing: alert.stage_routing,
    expiration_policy: 'platform_maximum',
    expiration,
    requested_expiration: expiration,
    platform_maximum_expiration_at_set: expiration,
  };
}

function existingInventory(existingAlerts) {
  return existingAlerts
    .map(alert => normalizeExistingAlert(alert, 0))
    .filter(Boolean)
    .sort((left, right) => left.alert_id.localeCompare(right.alert_id));
}

function actionForDesired(desired, managedExisting, platformMaximumExpiration, now, renewExpired) {
  const candidates = managedExisting.filter(alert => (
    alert.requested_symbol === desired.requested_symbol && alert.timeframe === desired.timeframe
  ));
  if (candidates.length > 1) fail('ambiguous_duplicate', `multiple managed alerts match ${desired.requested_symbol} ${desired.timeframe}`, {
    target_id: desired.target_id,
    alert_ids: candidates.map(candidate => candidate.alert_id).sort(),
  });
  if (candidates.length === 0) {
    return {
      action: 'create',
      target_id: desired.target_id,
      desired_alert_key: desired.desired_alert_key,
      existing_alert_id: null,
      request: actionRequest(desired, platformMaximumExpiration, now),
    };
  }
  const existing = candidates[0];
  if (existing.feed_symbol !== desired.feed_symbol) fail('feed_identity_drift', `actual feed identity drifted for ${desired.requested_symbol} ${desired.timeframe}`, {
    target_id: desired.target_id,
    expected_feed_symbol: desired.feed_symbol,
    actual_feed_symbol: existing.feed_symbol,
    alert_id: existing.alert_id,
  });
  const sameIdentity = existing.desired_alert_key === desired.desired_alert_key
    && existing.target_id === desired.target_id
    && existing.condition_name === desired.condition_name
    && canonicalJson(existing.source_identity, 'existing source identity') === canonicalJson(desired.source_identity, 'desired source identity')
    && canonicalJson(existing.pine_input_identity, 'existing Pine inputs') === canonicalJson(desired.pine_input_identity, 'desired Pine inputs')
    && canonicalJson(existing.stage_routing, 'existing stage routing') === canonicalJson(desired.stage_routing, 'desired stage routing');
  if (!sameIdentity) fail('alert_identity_drift', `managed alert identity drifted for ${desired.requested_symbol} ${desired.timeframe}`, {
    target_id: desired.target_id,
    alert_id: existing.alert_id,
  });
  if (existing.active !== true) fail('inactive_exact_alert', `exact managed alert is inactive: ${existing.alert_id}`);
  if (Date.parse(existing.expiration) <= Date.parse(now)) {
    if (!renewExpired) fail('expired_exact_alert', `exact managed alert is expired: ${existing.alert_id}`);
    return {
      action: 'renew',
      target_id: desired.target_id,
      desired_alert_key: desired.desired_alert_key,
      existing_alert_id: existing.alert_id,
      request: actionRequest(desired, platformMaximumExpiration, now),
      existing_expiration: existing.expiration,
      maximum_evidence: existing.maximum_evidence,
    };
  }
  return {
    action: 'reuse',
    target_id: desired.target_id,
    desired_alert_key: desired.desired_alert_key,
    existing_alert_id: existing.alert_id,
    request: null,
    existing_expiration: existing.expiration,
    maximum_evidence: existing.maximum_evidence,
  };
}

export function buildCupHandleAlertSetPlanV1({
  manifest,
  existing_alerts,
  now,
  platform_maximum_expiration,
  renew_expired = false,
}) {
  const normalizedManifest = normalizeManifest(manifest);
  const at = iso(now, 'now');
  const maximum = expirationForOperation(platform_maximum_expiration, 'platform_maximum_expiration', at);
  if (!Array.isArray(existing_alerts)) fail('malformed_input', 'existing_alerts must be an array');
  const normalizedExisting = existing_alerts.map(normalizeExistingAlert).filter(Boolean);
  exactBoolean(renew_expired, 'renew_expired');
  const desiredAlerts = normalizedManifest.targets.map(target => desiredAlert(normalizedManifest, target));
  const actions = desiredAlerts
    .map(desired => actionForDesired(desired, normalizedExisting, maximum, at, renew_expired))
    .sort((left, right) => left.target_id.localeCompare(right.target_id));
  const inventory = normalizedExisting.sort((left, right) => left.alert_id.localeCompare(right.alert_id));
  const manifestSha256 = cupHandleAlertSetSha256V1(normalizedManifest);
  const inventorySha256 = cupHandleAlertSetSha256V1(inventory);
  const core = {
    schema_version: CUP_HANDLE_ALERT_SET_PLAN_SCHEMA_V1,
    manifest_sha256: manifestSha256,
    existing_inventory_sha256: inventorySha256,
    now: at,
    platform_maximum_expiration: maximum,
    renew_expired,
    desired_alerts: desiredAlerts,
    actions,
  };
  const planSha256 = cupHandleAlertSetSha256V1(core);
  return freeze({
    ...core,
    transaction_id: `ch-alert-tx-${planSha256}`,
    plan_sha256: planSha256,
    auth: { algorithm: 'sha256', digest: planSha256 },
  });
}

export function verifyCupHandleAlertSetPlanV1(plan) {
  exactKeys(plan, [
    'schema_version', 'manifest_sha256', 'existing_inventory_sha256', 'now',
    'platform_maximum_expiration', 'renew_expired', 'desired_alerts', 'actions',
    'transaction_id', 'plan_sha256', 'auth',
  ], 'plan');
  if (plan.schema_version !== CUP_HANDLE_ALERT_SET_PLAN_SCHEMA_V1) fail('receipt_invalid', 'plan schema_version is invalid');
  exactSha(plan.manifest_sha256, 'plan.manifest_sha256');
  exactSha(plan.existing_inventory_sha256, 'plan.existing_inventory_sha256');
  iso(plan.now, 'plan.now');
  expirationForOperation(plan.platform_maximum_expiration, 'plan.platform_maximum_expiration', plan.now);
  exactBoolean(plan.renew_expired, 'plan.renew_expired');
  if (!Array.isArray(plan.desired_alerts) || !Array.isArray(plan.actions)) fail('receipt_invalid', 'plan arrays are invalid');
  nonempty(plan.transaction_id, 'plan.transaction_id');
  exactSha(plan.plan_sha256, 'plan.plan_sha256');
  exactKeys(plan.auth, ['algorithm', 'digest'], 'plan.auth');
  if (plan.auth.algorithm !== 'sha256' || plan.auth.digest !== plan.plan_sha256) fail('receipt_invalid', 'plan authentication is invalid');
  const core = {
    schema_version: plan.schema_version,
    manifest_sha256: plan.manifest_sha256,
    existing_inventory_sha256: plan.existing_inventory_sha256,
    now: plan.now,
    platform_maximum_expiration: plan.platform_maximum_expiration,
    renew_expired: plan.renew_expired,
    desired_alerts: plan.desired_alerts,
    actions: plan.actions,
  };
  if (cupHandleAlertSetSha256V1(core) !== plan.plan_sha256 || plan.transaction_id !== `ch-alert-tx-${plan.plan_sha256}`) {
    fail('receipt_invalid', 'plan authentication digest does not match its contents');
  }
  return true;
}

function operationResult(value, action, plan) {
  plain(value, `${action.action} result`);
  exactKeys(value, [
    'alert_id', 'desired_alert_key', 'feed_symbol', 'expiration_policy',
    'requested_expiration', 'platform_maximum_expiration_at_set',
    'accepted_expiration', 'transaction_id',
  ], `${action.action} result`);
  if (!ALERT_ID.test(value.alert_id)) fail('malformed_platform_response', `${action.action} result alert_id is invalid`);
  if (value.transaction_id !== plan.transaction_id) fail('transaction_identity_mismatch', `${action.action} result is not bound to the current transaction`);
  if (action.action === 'renew' && value.alert_id !== action.existing_alert_id) fail('identity_mismatch', 'renew returned a different alert ID');
  if (value.desired_alert_key !== action.desired_alert_key) fail('identity_mismatch', `${action.action} result desired_alert_key is not exact`);
  const request = action.request;
  if (value.feed_symbol !== request.feed_symbol) fail('feed_identity_drift', `${action.action} result feed identity is not exact`);
  const requested = enforceMaximumExpirationV1({
    requested_expiration: value.requested_expiration,
    platform_maximum_expiration: plan.platform_maximum_expiration,
    now: plan.now,
  });
  if (value.expiration_policy !== 'platform_maximum') fail('maximum_evidence_invalid', `${action.action} result expiration_policy is not platform_maximum`);
  const setMaximum = expirationForOperation(value.platform_maximum_expiration_at_set, `${action.action} result platform_maximum_expiration_at_set`, plan.now);
  const accepted = expirationForOperation(value.accepted_expiration, `${action.action} result accepted_expiration`, plan.now);
  if (setMaximum !== requested || accepted !== requested) fail('expiration_mismatch', `${action.action} accepted expiration is not exactly the requested platform maximum`);
  return {
    alert_id: value.alert_id,
    accepted_expiration: accepted,
    maximum_evidence: {
      expiration_policy: value.expiration_policy,
      requested_expiration: requested,
      platform_maximum_expiration_at_set: setMaximum,
      accepted_expiration: accepted,
    },
  };
}

function receiptCore(input) {
  const {
    plan,
    status,
    action_results,
    created_alert_ids,
    renewed_alert_ids,
    reused_alert_ids,
    rollback,
    recovery = { required: false, renewed_alert_ids: [], renewals_reverted: true },
  } = input;
  const source = plan ?? input;
  return {
    schema_version: CUP_HANDLE_ALERT_SET_RECEIPT_SCHEMA_V1,
    transaction_id: source.transaction_id,
    plan_sha256: source.plan_sha256,
    manifest_sha256: source.manifest_sha256,
    status,
    now: source.now,
    platform_maximum_expiration: source.platform_maximum_expiration,
    action_results,
    created_alert_ids,
    renewed_alert_ids,
    reused_alert_ids,
    rollback,
    recovery,
  };
}

function makeReceipt(args) {
  const core = receiptCore(args);
  const digest = cupHandleAlertSetSha256V1(core);
  return freeze({
    ...core,
    receipt_sha256: digest,
    auth: { algorithm: 'sha256', digest },
  });
}

export function verifyCupHandleAlertSetReceiptV1(receipt) {
  exactKeys(receipt, [
    'schema_version', 'transaction_id', 'plan_sha256', 'manifest_sha256', 'status',
    'now', 'platform_maximum_expiration', 'action_results', 'created_alert_ids',
    'renewed_alert_ids', 'reused_alert_ids', 'rollback', 'recovery', 'receipt_sha256', 'auth',
  ], 'receipt');
  if (receipt.schema_version !== CUP_HANDLE_ALERT_SET_RECEIPT_SCHEMA_V1) fail('receipt_invalid', 'receipt schema_version is invalid');
  exactSha(receipt.plan_sha256, 'receipt.plan_sha256');
  exactSha(receipt.manifest_sha256, 'receipt.manifest_sha256');
  if (!['committed', 'rolled_back', 'recovery_required'].includes(receipt.status)) fail('receipt_invalid', 'receipt status is invalid');
  iso(receipt.now, 'receipt.now');
  expirationForOperation(receipt.platform_maximum_expiration, 'receipt.platform_maximum_expiration', receipt.now);
  if (!Array.isArray(receipt.action_results) || !Array.isArray(receipt.created_alert_ids)
    || !Array.isArray(receipt.renewed_alert_ids) || !Array.isArray(receipt.reused_alert_ids)) fail('receipt_invalid', 'receipt action arrays are invalid');
  for (const [index, result] of receipt.action_results.entries()) {
    exactKeys(result, ['target_id', 'action', 'alert_id', 'accepted_expiration', 'maximum_evidence'], `receipt.action_results[${index}]`);
    nonempty(result.target_id, `receipt.action_results[${index}].target_id`);
    if (!['create', 'renew', 'reuse'].includes(result.action)) fail('receipt_invalid', `receipt.action_results[${index}].action is invalid`);
    if (!ALERT_ID.test(result.alert_id)) fail('receipt_invalid', `receipt.action_results[${index}].alert_id is invalid`);
    const accepted = iso(result.accepted_expiration, `receipt.action_results[${index}].accepted_expiration`);
    const evidence = normalizeMaximumEvidence(result.maximum_evidence, `receipt.action_results[${index}].maximum_evidence`);
    if (accepted !== evidence.accepted_expiration) fail('receipt_invalid', `receipt.action_results[${index}] accepted expiry is not self-consistent`);
    if (result.action !== 'reuse' && evidence.requested_expiration !== receipt.platform_maximum_expiration) fail('receipt_invalid', `receipt.action_results[${index}] does not prove the current platform maximum`);
  }
  exactKeys(receipt.rollback, ['attempted', 'alert_ids', 'deleted_alert_ids', 'exact'], 'receipt.rollback');
  exactBoolean(receipt.rollback.attempted, 'receipt.rollback.attempted');
  exactBoolean(receipt.rollback.exact, 'receipt.rollback.exact');
  if (!Array.isArray(receipt.rollback.alert_ids) || !Array.isArray(receipt.rollback.deleted_alert_ids)) fail('receipt_invalid', 'receipt.rollback IDs are invalid');
  exactKeys(receipt.recovery, ['required', 'renewed_alert_ids', 'renewals_reverted'], 'receipt.recovery');
  exactBoolean(receipt.recovery.required, 'receipt.recovery.required');
  exactBoolean(receipt.recovery.renewals_reverted, 'receipt.recovery.renewals_reverted');
  if (!Array.isArray(receipt.recovery.renewed_alert_ids)) fail('receipt_invalid', 'receipt.recovery.renewed_alert_ids is invalid');
  if (JSON.stringify([...receipt.recovery.renewed_alert_ids].sort()) !== JSON.stringify([...receipt.renewed_alert_ids].sort())) fail('receipt_invalid', 'receipt recovery renewal IDs are inconsistent');
  if (receipt.status === 'recovery_required') {
    if (receipt.recovery.required !== true || receipt.recovery.renewals_reverted !== false || receipt.recovery.renewed_alert_ids.length === 0) fail('receipt_invalid', 'recovery_required receipt does not identify unreverted renewals');
  } else if (receipt.recovery.required !== false || receipt.recovery.renewals_reverted !== true || receipt.recovery.renewed_alert_ids.length !== 0) {
    fail('receipt_invalid', 'non-recovery receipt has invalid recovery state');
  }
  exactKeys(receipt.auth, ['algorithm', 'digest'], 'receipt.auth');
  exactSha(receipt.receipt_sha256, 'receipt.receipt_sha256');
  if (receipt.auth.algorithm !== 'sha256' || receipt.auth.digest !== receipt.receipt_sha256) fail('receipt_invalid', 'receipt authentication is invalid');
  const core = receiptCore(receipt);
  if (cupHandleAlertSetSha256V1(core) !== receipt.receipt_sha256) fail('receipt_invalid', 'receipt authentication digest does not match its contents');
  return true;
}

function adapterMethod(adapter, name) {
  if (!adapter || typeof adapter[name] !== 'function') fail('adapter_invalid', `adapter.${name} is required`);
  return adapter[name].bind(adapter);
}

export async function reconcileCupHandleAlertSetV1({
  manifest,
  adapter,
  now,
  renew_expired = false,
  requested_expiration = null,
}) {
  const normalizedManifest = normalizeManifest(manifest);
  const at = iso(now, 'now');
  const getMaximumExpiration = adapterMethod(adapter, 'getMaximumExpiration');
  const listAlerts = adapterMethod(adapter, 'listAlerts');
  const createAlert = adapterMethod(adapter, 'createAlert');
  const deleteAlerts = adapterMethod(adapter, 'deleteAlerts');
  const renewAlert = renew_expired ? adapterMethod(adapter, 'renewAlert') : null;
  const platformMaximumExpiration = expirationForOperation(
    await getMaximumExpiration({ manifest: normalizedManifest, now: at }),
    'platform_maximum_expiration',
    at,
  );
  if (requested_expiration !== null) {
    enforceMaximumExpirationV1({
      requested_expiration,
      platform_maximum_expiration: platformMaximumExpiration,
      now: at,
    });
  }
  const existingAlerts = await listAlerts({ manifest: normalizedManifest, now: at });
  const plan = buildCupHandleAlertSetPlanV1({
    manifest: normalizedManifest,
    existing_alerts: existingAlerts,
    now: at,
    platform_maximum_expiration: platformMaximumExpiration,
    renew_expired,
  });
  verifyCupHandleAlertSetPlanV1(plan);
  const createdAlertIds = [];
  const renewedAlertIds = [];
  const reusedAlertIds = [];
  const actionResults = [];
  try {
    for (const action of plan.actions) {
      if (action.action === 'reuse') {
        reusedAlertIds.push(action.existing_alert_id);
        actionResults.push({
          target_id: action.target_id,
          action: action.action,
          alert_id: action.existing_alert_id,
          accepted_expiration: action.existing_expiration,
          maximum_evidence: action.maximum_evidence,
        });
        continue;
      }
      const operation = action.action === 'create' ? createAlert : renewAlert;
      const response = await operation({
        transaction_id: plan.transaction_id,
        action,
        request: action.request,
        manifest: normalizedManifest,
        now: at,
      });
      const accepted = operationResult(response, action, plan);
      if (action.action === 'create') createdAlertIds.push(accepted.alert_id);
      else renewedAlertIds.push(accepted.alert_id);
      actionResults.push({
        target_id: action.target_id,
        action: action.action,
        alert_id: accepted.alert_id,
        accepted_expiration: accepted.accepted_expiration,
        maximum_evidence: accepted.maximum_evidence,
      });
    }
  } catch (cause) {
    const recoveryRequired = renewedAlertIds.length > 0;
    const recovery = {
      required: recoveryRequired,
      renewed_alert_ids: [...renewedAlertIds],
      renewals_reverted: !recoveryRequired,
    };
    let rollback = { attempted: false, alert_ids: [], deleted_alert_ids: [], exact: true };
    if (createdAlertIds.length > 0) {
      rollback = { attempted: true, alert_ids: [...createdAlertIds], deleted_alert_ids: [], exact: false };
      try {
        const deleted = await deleteAlerts({
          transaction_id: plan.transaction_id,
          alert_ids: [...createdAlertIds],
          reason: 'partial_failure_current_transaction',
        });
        if (!plain(deleted, 'rollback result') || !Array.isArray(deleted.deleted_alert_ids)) fail('rollback_incomplete', 'rollback result is malformed');
        const deletedIds = [...deleted.deleted_alert_ids].sort();
        const expectedIds = [...createdAlertIds].sort();
        if (JSON.stringify(deletedIds) !== JSON.stringify(expectedIds)) fail('rollback_incomplete', 'rollback did not delete exactly the current transaction alert IDs');
        rollback = { attempted: true, alert_ids: expectedIds, deleted_alert_ids: deletedIds, exact: true };
      } catch (rollbackCause) {
        const receipt = makeReceipt({
          plan,
          status: recoveryRequired ? 'recovery_required' : 'rolled_back',
          action_results: actionResults,
          created_alert_ids: [...createdAlertIds],
          renewed_alert_ids: [...renewedAlertIds],
          reused_alert_ids: [...reusedAlertIds],
          rollback,
          recovery,
        });
        const error = new Error(recoveryRequired
          ? 'Cup alert-set transaction requires recovery because a renewal was not reverted'
          : 'Cup alert-set transaction failed and exact rollback was not proven');
        error.code = recoveryRequired ? 'recovery_required' : 'rollback_incomplete';
        error.cause = cause;
        error.rollback_cause = rollbackCause;
        error.receipt = receipt;
        throw error;
      }
    }
    const receipt = makeReceipt({
      plan,
      status: recoveryRequired ? 'recovery_required' : 'rolled_back',
      action_results: actionResults,
      created_alert_ids: [...createdAlertIds],
      renewed_alert_ids: [...renewedAlertIds],
      reused_alert_ids: [...reusedAlertIds],
      rollback,
      recovery,
    });
    const error = new Error(recoveryRequired
      ? 'Cup alert-set transaction requires recovery because successful renewals were not reverted'
      : 'Cup alert-set transaction failed; exact current-transaction rollback completed');
    error.code = recoveryRequired ? 'recovery_required' : 'transaction_rolled_back';
    error.cause = cause;
    error.receipt = receipt;
    throw error;
  }
  return makeReceipt({
    plan,
    status: 'committed',
    action_results: actionResults,
    created_alert_ids: [...createdAlertIds],
    renewed_alert_ids: [...renewedAlertIds],
    reused_alert_ids: [...reusedAlertIds],
    rollback: { attempted: false, alert_ids: [], deleted_alert_ids: [], exact: true },
  });
}
