import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disconnect, evaluateAsync } from '../src/connection.js';
import {
  DEFAULT_ATTENTION_STATE_DIR,
  SOURCE_BINDINGS,
} from '../src/core/investment-attention-config.js';
import {
  buildInvestmentAttentionHealthInput,
  classifyInvestmentAttentionAlert,
} from '../src/core/investment-attention-live-snapshot.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = resolve(repoRoot, 'analysis/runtime');

const LIVE_SCRIPT_IDS = Object.freeze({
  sma_fib: 'USER;a4bbd841edfc4444a2253c71953105bf',
  rsi_scanner_s1: 'USER;53eb4225f4f44cb4a9c7d5022fd50419',
  rsi_scanner_s2: 'USER;7a48561c91f14232aec86357d70a37e4',
  cup_and_handle: 'USER;5ef3959331454d5c8dbabae491ac3eed',
});

const BINDING_BY_SCRIPT_ID = Object.freeze(Object.fromEntries([
  [LIVE_SCRIPT_IDS.sma_fib, SOURCE_BINDINGS.sma_fib],
  [LIVE_SCRIPT_IDS.rsi_scanner_s1, SOURCE_BINDINGS.rsi_scanner_s1],
  [LIVE_SCRIPT_IDS.rsi_scanner_s2, SOURCE_BINDINGS.rsi_scanner_s2],
  [LIVE_SCRIPT_IDS.cup_and_handle, SOURCE_BINDINGS.cup_and_handle],
]));

const ACCEPTED_RSI_SHARDS = new Set([
  'metals-rsi-0mkj-v1',
  'metals-rsi-ati-v1',
  'metals-rsi-emet-v1',
  'metals-rsi-aii-v1',
  'metals-rsi-gvzcls-v1',
  'metals-rsi-g01-v1',
  'metals-rsi-g03-v1',
  'metals-rsi-g04-v1',
  'metals-rsi-g05-v1',
  'metals-rsi-g06-v1',
  'metals-rsi-g07-v1',
  'metals-s02-v1',
]);

function sha256(value) {
  return createHash('sha256')
    .update(String(value).replace(/\r\n/gu, '\n'), 'utf8')
    .digest('hex');
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function responseBody(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed with HTTP ${result?.status ?? 'unknown'}`);
  }
  if (!result.body || typeof result.body !== 'object') {
    throw new Error(`${label} returned a non-JSON response`);
  }
  return result.body;
}

async function pageJson(url) {
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, ok: response.ok, body };
  })()`;
  return evaluateAsync(expression);
}

function alertRows(body) {
  if (body.s !== 'ok' || !Array.isArray(body.r)) {
    throw new Error(`TradingView alert inventory returned an unexpected response: ${body.errmsg ?? body.s ?? 'unknown'}`);
  }
  return body.r;
}

function scriptRows(body) {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body.r) ? body.r
      : Array.isArray(body.scripts) ? body.scripts : [];
  return rows.map(row => ({
    script_id: row.scriptIdPart ?? row.script_id ?? row.id ?? null,
    version: row.version ?? row.scriptVersion ?? null,
    title: row.scriptTitle ?? row.scriptName ?? row.title ?? null,
  })).filter(row => row.script_id);
}

function sanitizeSeries(series) {
  return {
    type: series?.type ?? null,
    study: series?.study ?? null,
    pine_id: series?.pine_id ?? series?.script_id ?? null,
    pine_version: series?.pine_version ?? series?.script_version ?? null,
    inputs: series?.inputs && typeof series.inputs === 'object' ? series.inputs : {},
    offsets_by_plot: series?.offsets_by_plot && typeof series.offsets_by_plot === 'object'
      ? series.offsets_by_plot : {},
    alert_cond_id: series?.alert_cond_id ?? null,
  };
}

function sanitizeAlert(alert) {
  const condition = alert.condition ?? alert.conditions?.[0] ?? {};
  return {
    alert_id: String(alert.alert_id),
    name: alert.name ?? null,
    symbol: alert.symbol ?? null,
    type: alert.type ?? null,
    active: alert.active === true,
    condition: {
      type: condition.type ?? null,
      frequency: condition.frequency ?? null,
      series: Array.isArray(condition.series) ? condition.series.map(sanitizeSeries) : [],
      cross_interval: condition.cross_interval ?? null,
      resolution: condition.resolution ?? null,
    },
    resolution: alert.resolution ?? null,
    frequency: alert.frequency ?? null,
    created: alert.create_time ?? alert.created ?? null,
    last_fired: alert.last_fire_time ?? alert.last_fired ?? null,
    last_fire_bar_time: alert.last_fire_bar_time ?? null,
    expiration: alert.expiration ?? null,
    popup: alert.popup === true,
    mobile_push: alert.mobile_push === true,
    email: alert.email === true,
    sms_over_email: alert.sms_over_email === true,
    web_hook: alert.web_hook == null ? null : { configured: true },
    auto_deactivate: alert.auto_deactivate === true,
    sound_file: alert.sound_file ?? null,
    sound_duration: alert.sound_duration ?? 0,
    last_error: alert.last_error ?? null,
    last_stop_reason: alert.last_stop_reason ?? null,
  };
}

function scopedRows(rows) {
  return rows.map(sanitizeAlert).filter(alert => {
    const classification = classifyInvestmentAttentionAlert(alert);
    if (!classification) return false;
    if (classification.family === 'sma_fib') {
      return classification.script.script_id === LIVE_SCRIPT_IDS.sma_fib
        && (classification.profile === 'D' || classification.profile === 'W')
        && (classification.shard === 1 || classification.shard === 2);
    }
    if (classification.family === 'rsi') {
      return (classification.script.script_id === LIVE_SCRIPT_IDS.rsi_scanner_s1
        || classification.script.script_id === LIVE_SCRIPT_IDS.rsi_scanner_s2)
        && ACCEPTED_RSI_SHARDS.has(classification.shard);
    }
    return classification.script.script_id === LIVE_SCRIPT_IDS.cup_and_handle
      && /^(?:NASDAQ_NVDA_1D|NASDAQ_TSLA_1W|BINANCE_BTCUSDT_4H)\|(early|terminal)$/u.test(
        classification.route_id ?? '',
      );
  });
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sourceForScript(scriptId, scripts) {
  const entry = scripts.find(script => script.script_id === scriptId);
  const binding = BINDING_BY_SCRIPT_ID[scriptId];
  if (!binding) throw new Error(`No release binding exists for live script ${scriptId}`);
  const version = entry?.version ?? '1.0';
  return { entry, binding, version };
}

async function fetchScriptSource(scriptId, scripts) {
  const { entry, binding, version } = sourceForScript(scriptId, scripts);
  const url = `https://pine-facade.tradingview.com/pine-facade/get/${encodeURIComponent(scriptId)}/${encodeURIComponent(version)}`;
  const body = responseBody(await pageJson(url), `Pine source ${scriptId} v${version}`);
  const source = typeof body.source === 'string'
    ? body.source
    : typeof body.script_source === 'string' ? body.script_source
      : typeof body.r?.source === 'string' ? body.r.source : null;
  if (!source) throw new Error(`Pine source ${scriptId} v${version} did not include source text`);
  return {
    script_id: scriptId,
    version,
    title: entry?.title ?? null,
    source_sha256: sha256(source),
    expected_source_sha256: binding.source_sha256,
    exact_source_match: sha256(source) === binding.source_sha256,
    source_bytes: Buffer.byteLength(source, 'utf8'),
  };
}

async function main() {
  const capturedAt = new Date().toISOString();
  const alertResponse = responseBody(
    await pageJson('https://pricealerts.tradingview.com/list_alerts'),
    'TradingView alert inventory',
  );
  const allRows = alertRows(alertResponse);
  const scoped = scopedRows(allRows);
  if (scoped.length === 0) {
    throw new Error('The authenticated inventory contained no accepted Investment Attention alerts');
  }

  const healthInputPath = resolve(stateDir, 'alert-health-input.json');
  const previousHealthInput = readJson(healthInputPath);
  if (!Array.isArray(previousHealthInput?.expected_alerts) || previousHealthInput.expected_alerts.length < 31) {
    throw new Error('The installed health input lacks the frozen accepted alert expectation set; refusing to refresh it');
  }

  const scriptResponse = responseBody(
    await pageJson('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved'),
    'TradingView saved Pine inventory',
  );
  const scripts = scriptRows(scriptResponse);
  const sourceRows = await Promise.all(Object.values(LIVE_SCRIPT_IDS).map(scriptId => fetchScriptSource(scriptId, scripts)));
  const sourceShaByScriptId = Object.fromEntries(sourceRows.map(row => [row.script_id, row.source_sha256]));
  const definitionByScriptId = Object.fromEntries(sourceRows.map(row => [
    row.script_id,
    BINDING_BY_SCRIPT_ID[row.script_id].definition_version,
  ]));
  const observedHealthInput = buildInvestmentAttentionHealthInput(scoped, {
    sourceShaByScriptId,
    definitionByScriptId,
  });
  const healthInput = {
    ...observedHealthInput,
    expected_alerts: [
      ...new Map([
        ...(previousHealthInput.expected_alerts ?? []),
        ...(observedHealthInput.expected_alerts ?? []),
      ].map(row => [row.expected_key, row])).values(),
    ],
    excluded_routes: previousHealthInput.excluded_routes ?? [],
  };

  const snapshot = {
    schema_version: 'investment-attention-scoped-alert-snapshot/v1',
    captured_at: capturedAt,
    source: 'authenticated TradingView Desktop REST list via loopback CDP; read-only inventory refresh',
    total_alerts: allRows.length,
    rows: allRows.map(sanitizeAlert),
  };
  const snapshotPath = resolve(stateDir, 'scoped-alert-snapshot.json');
  const receiptPath = resolve(repoRoot, 'analysis/investment-attention-live-refresh-receipt-v1.json');
  atomicWriteJson(snapshotPath, snapshot);
  atomicWriteJson(healthInputPath, healthInput);
  atomicWriteJson(receiptPath, {
    schema_version: 'investment-attention-live-refresh-receipt/v1',
    captured_at_utc: capturedAt,
    environment: {
      local_release_worktree: repoRoot,
      live_surface: 'authenticated TradingView Desktop session through loopback CDP',
      mutation: 'read_only',
    },
    inventory: {
      endpoint: 'https://pricealerts.tradingview.com/list_alerts',
      http_status: 200,
      total_alerts: allRows.length,
      scoped_target_count: scoped.length,
      frozen_expected_target_count: healthInput.expected_alerts.length,
      scoped_target_ids: scoped.map(alert => alert.alert_id).sort(),
      refresh_filter: 'accepted live script IDs, accepted SMA D/W shards, accepted RSI shards, and the bounded Cup NVDA/TSLA/BTCUSDT early-or-terminal routes; unrelated alerts remain in the full inventory only.',
    },
    saved_pine_inventory: {
      endpoint: 'https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',
      matched_scoped_script_count: sourceRows.length,
      scripts: sourceRows,
    },
    outputs: {
      snapshot_path: 'analysis/runtime/scoped-alert-snapshot.json',
      health_input_path: 'analysis/runtime/alert-health-input.json',
    },
    capabilities: {
      live_alert_inventory_refresh: true,
      source_version_refresh: true,
      fired_event_payload_collection: false,
      fired_event_payload_reason: 'TradingView alert_list exposes last_fired metadata but no complete fired payload history, stable cursor/order, retention contract, restart recovery, or idempotent polling.',
      ledger_query: 'Separate local collector/ledger path; this command does not ingest or notify.',
    },
    source_drift: sourceRows.filter(row => !row.exact_source_match).map(row => ({
      script_id: row.script_id,
      version: row.version,
      actual_source_sha256: row.source_sha256,
      expected_source_sha256: row.expected_source_sha256,
    })),
  });

  console.log(JSON.stringify({
    refreshed_at_utc: capturedAt,
    total_alerts: allRows.length,
    scoped_target_count: scoped.length,
    source_rows: sourceRows,
    snapshot_path: snapshotPath,
    health_input_path: healthInputPath,
    fired_event_payload_collection: false,
  }));
}

try {
  if (!existsSync(DEFAULT_ATTENTION_STATE_DIR)) mkdirSync(DEFAULT_ATTENTION_STATE_DIR, { recursive: true });
  await main();
} finally {
  await disconnect();
}
