import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disconnect, evaluate, evaluateAsync } from '../src/connection.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = resolve(repoRoot, 'analysis/investment-attention-readable-alert-migration-receipt-v1.json');

const RELEASES = Object.freeze({
  'USER;a4bbd841edfc4444a2253c71953105bf': Object.freeze({
    family: 'sma_fib',
    old_version: '4.0',
    new_version: '5.0',
    source_sha256: '857af9158cfaf63a0b8d52ea65008809c9dda3cef7ca3d68cad4c58d1f7a1564',
  }),
  'USER;53eb4225f4f44cb4a9c7d5022fd50419': Object.freeze({
    family: 'rsi',
    old_version: '1.0',
    new_version: '2.0',
    source_sha256: 'a53aa4fe99d765870978ea70180f28047fb44da3de8104e9ef6a408679d01ba1',
  }),
  'USER;7a48561c91f14232aec86357d70a37e4': Object.freeze({
    family: 'rsi',
    old_version: '1.0',
    new_version: '2.0',
    source_sha256: '03e31aeaa57b62a0292573eb2f90745bfadbf670351d3ada9792ed4fe36f08c0',
  }),
  'USER;5ef3959331454d5c8dbabae491ac3eed': Object.freeze({
    family: 'cup_and_handle',
    old_version: '1.0',
    new_version: '2.0',
    source_sha256: '0247dd799161f4cfde61f172f24bbfd5888b8934008d87ded5e922e6e936483e',
  }),
});

const EXPECTED_COUNTS = Object.freeze({ sma_fib: 4, rsi: 24, cup_and_handle: 6 });

function sha256(value) {
  return createHash('sha256').update(String(value).replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function exact(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}

async function pageJson(url) {
  return evaluateAsync(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, ok: response.ok, body };
  })()`);
}

async function listAlerts() {
  const response = await pageJson('https://pricealerts.tradingview.com/list_alerts');
  if (!response?.ok || response.body?.s !== 'ok' || !Array.isArray(response.body.r)) {
    throw new Error(`TradingView alert inventory failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.body.r;
}

async function listScripts() {
  const response = await pageJson('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved');
  if (!response?.ok || !Array.isArray(response.body)) {
    throw new Error(`TradingView saved-script inventory failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.body;
}

async function fetchScriptSource(scriptId, version) {
  const url = `https://pine-facade.tradingview.com/pine-facade/get/${encodeURIComponent(scriptId)}/${encodeURIComponent(version)}`;
  const response = await pageJson(url);
  if (!response?.ok || typeof response.body?.source !== 'string') {
    throw new Error(`TradingView Pine source read failed for ${scriptId} v${version}`);
  }
  return response.body.source;
}

function conditionOf(alert) {
  return alert.conditions?.[0] ?? alert.condition ?? null;
}

function studyOf(alert) {
  return conditionOf(alert)?.series?.[0] ?? null;
}

function releaseOf(alert) {
  return RELEASES[studyOf(alert)?.pine_id] ?? null;
}

function stableAlertProjection(alert) {
  return {
    alert_id: String(alert.alert_id),
    symbol: alert.symbol ?? null,
    resolution: alert.resolution ?? null,
    condition: conditionOf(alert),
    message: alert.message ?? '',
    sound_file: alert.sound_file ?? null,
    sound_duration: alert.sound_duration ?? 0,
    popup: alert.popup === true,
    auto_deactivate: alert.auto_deactivate === true,
    email: alert.email === true,
    sms_over_email: alert.sms_over_email === true,
    mobile_push: alert.mobile_push === true,
    web_hook: alert.web_hook ?? null,
    name: alert.name ?? null,
    expiration: alert.expiration ?? null,
    active: alert.active === true,
  };
}

function clonePayload(alert, newVersion) {
  const condition = structuredClone(conditionOf(alert));
  if (!condition || !Array.isArray(condition.series) || condition.series.length !== 1) {
    throw new Error(`Alert ${alert.alert_id} does not have one exact study series`);
  }
  condition.series[0].pine_version = newVersion;
  return {
    conditions: [condition],
    symbol: alert.symbol,
    resolution: alert.resolution,
    message: alert.message ?? '',
    sound_file: alert.sound_file ?? null,
    sound_duration: alert.sound_duration ?? 0,
    popup: alert.popup === true,
    auto_deactivate: alert.auto_deactivate === true,
    email: alert.email === true,
    sms_over_email: alert.sms_over_email === true,
    mobile_push: alert.mobile_push === true,
    web_hook: alert.web_hook ?? null,
    name: alert.name ?? null,
    expiration: alert.expiration,
    active: true,
    ignore_warnings: true,
  };
}

function expectedProjection(oldAlert, payload) {
  return {
    symbol: payload.symbol,
    resolution: payload.resolution,
    condition: payload.conditions[0],
    message: payload.message,
    sound_file: payload.sound_file,
    sound_duration: payload.sound_duration,
    popup: payload.popup,
    auto_deactivate: payload.auto_deactivate,
    email: payload.email,
    sms_over_email: payload.sms_over_email,
    mobile_push: payload.mobile_push,
    web_hook: payload.web_hook,
    name: payload.name,
    expiration: payload.expiration,
    active: true,
    predecessor_alert_id: String(oldAlert.alert_id),
  };
}

function observedProjection(alert, predecessorAlertId) {
  return {
    symbol: alert.symbol ?? null,
    resolution: alert.resolution ?? null,
    condition: conditionOf(alert),
    message: alert.message ?? '',
    sound_file: alert.sound_file ?? null,
    sound_duration: alert.sound_duration ?? 0,
    popup: alert.popup === true,
    auto_deactivate: alert.auto_deactivate === true,
    email: alert.email === true,
    sms_over_email: alert.sms_over_email === true,
    mobile_push: alert.mobile_push === true,
    web_hook: alert.web_hook ?? null,
    name: alert.name ?? null,
    expiration: alert.expiration ?? null,
    active: alert.active === true,
    predecessor_alert_id: String(predecessorAlertId),
  };
}

async function post(path, payload) {
  return evaluate(`(() => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ${JSON.stringify(`https://pricealerts.tradingview.com/${path}`)}, false);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.send(${JSON.stringify(JSON.stringify({ payload }))});
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      return { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 && body?.s === 'ok', body };
    } catch (error) {
      return { status: 0, ok: false, error: String(error?.message ?? error) };
    }
  })()`);
}

async function createAlert(payload) {
  const response = await post('create_alert', payload);
  const alertId = response?.body?.r?.alert_id ?? null;
  if (!response?.ok || alertId == null) {
    throw new Error(`TradingView alert creation failed: ${response?.body?.errmsg ?? response?.error ?? response?.status ?? 'unknown'}`);
  }
  return alertId;
}

async function deleteAlert(alertId) {
  const response = await post('delete_alerts', { alert_ids: [alertId] });
  if (!response?.ok) {
    throw new Error(`TradingView alert deletion failed for ${alertId}: ${response?.body?.errmsg ?? response?.error ?? response?.status ?? 'unknown'}`);
  }
}

async function waitForExactCreatedAlert({ alertId, predecessor, expected, timeoutMs = 12_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = null;
  while (Date.now() < deadline) {
    const inventory = await listAlerts();
    const created = inventory.find(alert => String(alert.alert_id) === String(alertId)) ?? null;
    if (created) {
      lastObserved = observedProjection(created, predecessor.alert_id);
      if (exact(lastObserved, expected)) return created;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const error = new Error(`Created alert ${alertId} did not become an exact active replacement for ${predecessor.alert_id}`);
  error.last_observed = lastObserved;
  throw error;
}

async function verifySavedReleases() {
  const scripts = await listScripts();
  const results = [];
  for (const [scriptId, release] of Object.entries(RELEASES)) {
    const script = scripts.find(row => (row.scriptIdPart ?? row.id) === scriptId);
    const observedVersion = String(script?.version ?? '');
    if (observedVersion !== release.new_version) {
      throw new Error(`Saved script ${scriptId} is v${observedVersion || 'missing'}, expected v${release.new_version}`);
    }
    const source = await fetchScriptSource(scriptId, release.new_version);
    const observedSha = sha256(source);
    if (observedSha !== release.source_sha256) {
      throw new Error(`Saved script ${scriptId} source SHA differs from the accepted release`);
    }
    results.push({ script_id: scriptId, family: release.family, version: observedVersion, source_sha256: observedSha });
  }
  return results;
}

async function main() {
  const startedAt = new Date().toISOString();
  const savedReleases = await verifySavedReleases();
  const before = await listAlerts();
  const targets = before.filter(alert => alert.active === true && releaseOf(alert));
  const counts = targets.reduce((out, alert) => {
    out[releaseOf(alert).family] += 1;
    return out;
  }, { sma_fib: 0, rsi: 0, cup_and_handle: 0 });
  if (!exact(counts, EXPECTED_COUNTS) || targets.length !== 34) {
    throw new Error(`Expected exactly 34 managed active alerts (4 SMA, 24 RSI, 6 Cup); observed ${JSON.stringify(counts)}`);
  }
  for (const alert of targets) {
    const release = releaseOf(alert);
    if (String(studyOf(alert)?.pine_version ?? '') !== release.old_version) {
      throw new Error(`Alert ${alert.alert_id} is not on the expected predecessor version ${release.old_version}`);
    }
  }

  const targetIds = new Set(targets.map(alert => String(alert.alert_id)));
  const unrelatedBefore = before
    .filter(alert => !targetIds.has(String(alert.alert_id)))
    .map(stableAlertProjection)
    .sort((a, b) => a.alert_id.localeCompare(b.alert_id));
  const mappings = [];

  for (let index = 0; index < targets.length; index += 1) {
    const oldAlert = targets[index];
    const release = releaseOf(oldAlert);
    const payload = clonePayload(oldAlert, release.new_version);
    const expected = expectedProjection(oldAlert, payload);
    const newAlertId = await createAlert(payload);
    let created = null;
    try {
      created = await waitForExactCreatedAlert({
        alertId: newAlertId,
        predecessor: oldAlert,
        expected,
      });
    } catch (error) {
      await deleteAlert(newAlertId);
      throw error;
    }

    await deleteAlert(oldAlert.alert_id);
    const afterDelete = await listAlerts();
    const oldStillPresent = afterDelete.some(alert => String(alert.alert_id) === String(oldAlert.alert_id));
    const newStillActive = afterDelete.some(alert => String(alert.alert_id) === String(newAlertId) && alert.active === true);
    if (oldStillPresent || !newStillActive) {
      throw new Error(`Post-delete proof failed for predecessor ${oldAlert.alert_id} and replacement ${newAlertId}`);
    }

    mappings.push({
      sequence: index + 1,
      family: release.family,
      name: oldAlert.name ?? null,
      symbol: oldAlert.symbol ?? null,
      resolution: oldAlert.resolution ?? null,
      old_alert_id: String(oldAlert.alert_id),
      new_alert_id: String(newAlertId),
      old_version: release.old_version,
      new_version: release.new_version,
      popup: created.popup === true,
      mobile_push: created.mobile_push === true,
      email: created.email === true,
      sms_over_email: created.sms_over_email === true,
      webhook_configured: created.web_hook != null,
      expiration: created.expiration ?? null,
      exact: true,
    });
    console.log(JSON.stringify({ migrated: index + 1, total: targets.length, family: release.family, old_alert_id: String(oldAlert.alert_id), new_alert_id: String(newAlertId) }));
  }

  const after = await listAlerts();
  const activeManaged = after.filter(alert => alert.active === true && releaseOf(alert));
  const finalCounts = activeManaged.reduce((out, alert) => {
    out[releaseOf(alert).family] += 1;
    return out;
  }, { sma_fib: 0, rsi: 0, cup_and_handle: 0 });
  const allCurrent = activeManaged.every(alert => String(studyOf(alert)?.pine_version ?? '') === releaseOf(alert).new_version);
  const unrelatedAfter = after
    .filter(alert => !activeManaged.some(target => String(target.alert_id) === String(alert.alert_id)))
    .filter(alert => !targetIds.has(String(alert.alert_id)))
    .map(stableAlertProjection)
    .sort((a, b) => a.alert_id.localeCompare(b.alert_id));
  if (activeManaged.length !== 34 || !exact(finalCounts, EXPECTED_COUNTS) || !allCurrent) {
    throw new Error(`Final managed inventory is not exact: count=${activeManaged.length}, families=${JSON.stringify(finalCounts)}, all_current=${allCurrent}`);
  }
  if (!exact(unrelatedAfter, unrelatedBefore)) {
    throw new Error('Unrelated alert configuration changed during the managed migration');
  }

  const receipt = {
    schema_version: 'investment-attention-readable-alert-migration-receipt/v1',
    started_at_utc: startedAt,
    completed_at_utc: new Date().toISOString(),
    environment: 'authenticated TradingView production session through loopback CDP',
    status: 'committed',
    scope: {
      alert_delivery: 'TradingView popup and mobile push only; no webhook or collector added',
      migrated_active_alert_count: mappings.length,
      unrelated_alerts_mutated: false,
      chart_mutated: false,
      saved_scripts: savedReleases,
    },
    final_inventory: {
      active_managed_alert_count: activeManaged.length,
      family_counts: finalCounts,
      all_bound_to_current_saved_versions: allCurrent,
    },
    mappings,
  };
  atomicWriteJson(receiptPath, receipt);
  console.log(JSON.stringify({ status: receipt.status, migrated: mappings.length, final_counts: finalCounts, receipt_path: receiptPath }));
}

try {
  await main();
} finally {
  await disconnect();
}
