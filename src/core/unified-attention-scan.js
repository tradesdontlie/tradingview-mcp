/**
 * One-pass local attention scan orchestration.
 *
 * The existing SMA/Fib scanner remains the sole owner of chart mutation,
 * leasing, route settlement, and restoration. This module decorates its
 * settled route reader with an exact typed RSI read so both detectors observe
 * the same chart route during one lifecycle. RSI failures are recorded per
 * route and never discard valid SMA/Fib observations.
 */
import { readFileSync } from 'node:fs';

import { evaluate as defaultEvaluate } from '../connection.js';
import { buildAttentionSnapshot } from './attention-snapshot.js';
import {
  readCurrentSmaFibRoute,
  requireExclusiveChartUseConfirmed,
  scanCurrentSmaFibWatchlist,
  scanSmaFibWatchlist,
} from './sma-fib-watchlist-scan.js';
import {
  RSI_EXACT_STUDY_TITLE,
  RSI_SELECTED_SOURCE_SHA256,
  adaptExactRsiStudySnapshot,
  buildExactRsiStudyReadExpression,
} from './rsi-study-adapter.js';

export const UNIFIED_ATTENTION_SCAN_SCHEMA_VERSION = 'investment-attention-scan/v1';
export const RSI_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION = 'rsi-attention-source-binding/v1';
export const RSI_VERIFIED_BINDING_STATUS = 'LIVE_BINDING_VERIFIED';

const RSI_SOURCE_BINDING_CONTRACT_URL = new URL(
  '../../contracts/rsi-attention-source-binding-v1.json',
  import.meta.url,
);
const TIMEFRAMES = Object.freeze(['D', 'W']);
const OBSERVATION_KINDS = Object.freeze(['current', 'last_closed']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function attentionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorRecord(error, fallbackCode = 'rsi_route_failed') {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function scanTimestamp(value) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError('scan timestamp must be a positive integer in milliseconds.');
  }
  return result;
}

function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) {
    throw new TypeError('unified attention routes require exchange-qualified symbols.');
  }
  return symbol;
}

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw new TypeError(`Unsupported unified attention timeframe: ${value}`);
}

function routeKey(symbol, timeframe) {
  return `${normalizeSymbol(symbol)}|${normalizeTimeframe(timeframe)}`;
}

function observationKey(observation) {
  return [
    normalizeSymbol(observation?.symbol),
    normalizeTimeframe(observation?.timeframe),
    observation?.observation_kind,
  ].join('|');
}

function readLocalRsiSourceBindingContract() {
  return JSON.parse(readFileSync(RSI_SOURCE_BINDING_CONTRACT_URL, 'utf8'));
}

/**
 * Resolve source authority only from the fixed, versioned binding contract.
 * A boolean supplied by a scan caller is intentionally not part of this API.
 */
export function assertVerifiedRsiSourceBindingContract(contract) {
  if (contract?.schema_version !== RSI_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION) {
    throw attentionError(
      'rsi_binding_contract_schema_mismatch',
      `RSI source binding must use ${RSI_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION}.`,
    );
  }
  if (contract.status !== RSI_VERIFIED_BINDING_STATUS
    || contract.live_binding?.verified !== true) {
    throw attentionError(
      'rsi_live_binding_unverified',
      'The versioned local contract does not verify the applied RSI source binding.',
    );
  }
  if (contract.selected_local_source?.title !== RSI_EXACT_STUDY_TITLE) {
    throw attentionError(
      'rsi_binding_title_mismatch',
      `The RSI binding contract must select ${RSI_EXACT_STUDY_TITLE}.`,
    );
  }
  if (contract.selected_local_source?.source_sha256 !== RSI_SELECTED_SOURCE_SHA256
    || contract.live_binding?.source_sha256 !== RSI_SELECTED_SOURCE_SHA256) {
    throw attentionError(
      'rsi_binding_source_hash_mismatch',
      'The verified RSI binding contract does not match the selected local source hash.',
    );
  }
  if (!SHA256_PATTERN.test(contract.live_binding?.semantic_inputs_sha256 ?? '')) {
    throw attentionError(
      'rsi_semantic_profile_unverified',
      'The verified RSI binding contract lacks an exact semantic-input profile hash.',
    );
  }
  const scriptId = contract.live_binding?.script_id;
  const scriptVersion = contract.live_binding?.script_version;
  if (typeof scriptId !== 'string' || !scriptId.trim()
    || !((typeof scriptVersion === 'string' && scriptVersion.trim())
      || (Number.isSafeInteger(scriptVersion) && scriptVersion > 0))) {
    throw attentionError(
      'rsi_applied_script_identity_unverified',
      'The verified RSI binding contract lacks an exact applied script ID/version.',
    );
  }
  return Object.freeze({
    schema_version: contract.schema_version,
    status: contract.status,
    source_title: RSI_EXACT_STUDY_TITLE,
    source_sha256: RSI_SELECTED_SOURCE_SHA256,
    semantic_inputs_sha256: contract.live_binding.semantic_inputs_sha256,
    script_id: scriptId,
    script_version: String(scriptVersion),
    verification_method: contract.live_binding.verification_method
      ?? 'versioned_local_source_binding_contract',
    verified_at_utc: contract.live_binding.verified_at_utc ?? null,
  });
}

function resolveRsiBinding(loadContract) {
  try {
    return {
      available: true,
      authority: assertVerifiedRsiSourceBindingContract(loadContract()),
      failure: null,
    };
  } catch (error) {
    return {
      available: false,
      authority: null,
      failure: errorRecord(error, 'rsi_binding_contract_invalid'),
    };
  }
}

function authorizeRsiSnapshot(snapshot, authority) {
  if (snapshot?.study_count !== 1
    || !Array.isArray(snapshot?.studies)
    || snapshot.studies.length !== 1) {
    throw attentionError(
      snapshot?.study_count > 1 ? 'rsi_study_ambiguous' : 'rsi_study_unavailable',
      `Expected exactly one ${RSI_EXACT_STUDY_TITLE} study before source authorization.`,
    );
  }
  const study = snapshot.studies[0];
  if (study?.title !== RSI_EXACT_STUDY_TITLE
    || study?.observed_identity?.script_id !== authority.script_id
    || String(study?.observed_identity?.script_version) !== authority.script_version) {
    throw attentionError(
      'rsi_applied_script_identity_mismatch',
      'The observed RSI study script ID/version does not match the verified local binding.',
    );
  }
  return {
    ...snapshot,
    studies: [{
      ...study,
      source_binding: {
        verified: true,
        source_sha256: authority.source_sha256,
        verification_method: authority.verification_method,
        binding_contract_schema_version: authority.schema_version,
        script_id: authority.script_id,
        script_version: authority.script_version,
        verified_at_utc: authority.verified_at_utc,
      },
    }],
  };
}

function canonicalizeRsiSnapshotRoute(snapshot, route, smaFibReading) {
  const requestedSymbol = normalizeSymbol(route.symbol);
  const observedSymbol = normalizeSymbol(snapshot?.symbol);
  const requestedTimeframe = normalizeTimeframe(route.timeframe);
  const observedTimeframe = normalizeTimeframe(snapshot?.timeframe);
  const exactSymbol = observedSymbol === requestedSymbol;
  const provedAlias = smaFibReading?.match_mode === 'bats_alias'
    && normalizeSymbol(smaFibReading?.resolved_symbol) === observedSymbol;
  if (!exactSymbol && !provedAlias) {
    throw attentionError(
      'rsi_route_symbol_mismatch',
      `Typed RSI route resolved to ${observedSymbol}, expected ${requestedSymbol}.`,
    );
  }
  if (observedTimeframe !== requestedTimeframe) {
    throw attentionError(
      'rsi_route_timeframe_mismatch',
      `Typed RSI route resolved to ${observedTimeframe}, expected ${requestedTimeframe}.`,
    );
  }
  return {
    snapshot: {
      ...snapshot,
      symbol: requestedSymbol,
      timeframe: requestedTimeframe,
    },
    route_identity: {
      requested_symbol: requestedSymbol,
      resolved_symbol: observedSymbol,
      match_mode: exactSymbol ? 'exact' : 'bats_alias',
      timeframe: requestedTimeframe,
    },
  };
}

function markObservationSourceVerified(observation, authority, routeIdentity) {
  return {
    ...observation,
    source: {
      ...observation.source,
      applied_live_binding_verified: true,
      binding_contract_schema_version: authority.schema_version,
      semantic_inputs_sha256: authority.semantic_inputs_sha256,
      requested_symbol: routeIdentity.requested_symbol,
      resolved_symbol: routeIdentity.resolved_symbol,
      match_mode: routeIdentity.match_mode,
    },
  };
}

function buildJoinCoverage(symbols, smaFibCurrent, smaFibLastClosed, rsiCurrent, rsiLastClosed) {
  const smaFib = new Map(
    [...smaFibCurrent, ...smaFibLastClosed].map(observation => [
      observationKey(observation),
      observation,
    ]),
  );
  const rsi = new Map(
    [...rsiCurrent, ...rsiLastClosed].map(observation => [
      observationKey(observation),
      observation,
    ]),
  );
  const expected = symbols.flatMap(symbol => TIMEFRAMES.flatMap(timeframe => (
    OBSERVATION_KINDS.map(kind => `${symbol}|${timeframe}|${kind}`)
  )));
  const missingSmaFib = expected.filter(key => !smaFib.has(key));
  const missingRsi = expected.filter(key => !rsi.has(key));
  const barTimeMismatches = expected.flatMap(key => {
    const smaFibObservation = smaFib.get(key);
    const rsiObservation = rsi.get(key);
    if (!smaFibObservation || !rsiObservation
      || smaFibObservation.data_bar_time_ms === rsiObservation.data_bar_time_ms) return [];
    return [{
      route: key,
      sma_fib_data_bar_time_ms: smaFibObservation.data_bar_time_ms,
      rsi_data_bar_time_ms: rsiObservation.data_bar_time_ms,
    }];
  });
  const exactJoinCount = expected.filter(key => {
    const smaFibObservation = smaFib.get(key);
    const rsiObservation = rsi.get(key);
    return smaFibObservation
      && rsiObservation
      && smaFibObservation.data_bar_time_ms === rsiObservation.data_bar_time_ms;
  }).length;
  return {
    expected_observation_count: expected.length,
    exact_join_count: exactJoinCount,
    missing_sma_fib: missingSmaFib,
    missing_rsi: missingRsi,
    bar_time_mismatches: barTimeMismatches,
    complete: missingSmaFib.length === 0
      && missingRsi.length === 0
      && barTimeMismatches.length === 0,
  };
}

function settledRsiSnapshotSignature(snapshot) {
  const study = snapshot.studies[0];
  return JSON.stringify({
    symbol: normalizeSymbol(snapshot.symbol),
    timeframe: normalizeTimeframe(snapshot.timeframe),
    current_bar_closed: snapshot.current_bar_closed,
    current_bar_time_ms: snapshot.current_bar_time_ms,
    last_closed_bar_time_ms: snapshot.last_closed_bar_time_ms,
    observed_identity: study.observed_identity,
    source_symbol: normalizeSymbol(study.source_symbol),
    source_timeframe: normalizeTimeframe(study.source_timeframe),
    turnaround: study.turnaround,
    current_study_bar_time_ms: study.current_bar_time_ms,
    last_closed_study_bar_time_ms: study.last_closed_bar_time_ms,
    semantic_inputs: study.semantic_inputs,
    machine_outputs: study.machine_outputs,
  });
}

function assertSettledRsiSnapshot(snapshot, route, smaFibReading, authority) {
  const canonicalRoute = canonicalizeRsiSnapshotRoute(snapshot, route, smaFibReading);
  if (snapshot?.main_loading !== false
    || !Number.isSafeInteger(snapshot?.main_bar_count)
    || snapshot.main_bar_count < 2) {
    throw attentionError('rsi_main_series_unsettled', 'The RSI chart main series is not settled.');
  }
  if (snapshot.bar_close_signal_valid !== true
    || typeof snapshot.current_bar_closed !== 'boolean') {
    throw attentionError(
      'rsi_bar_status_unverified',
      'TradingView server time and target-bar close time did not prove RSI bar status.',
    );
  }
  if (snapshot.study_count !== 1
    || !Array.isArray(snapshot.studies)
    || snapshot.studies.length !== 1) {
    throw attentionError(
      snapshot?.study_count > 1 ? 'rsi_study_ambiguous' : 'rsi_study_unavailable',
      `Expected exactly one ${RSI_EXACT_STUDY_TITLE} study.`,
    );
  }
  const study = snapshot.studies[0];
  if (study.title !== RSI_EXACT_STUDY_TITLE
    || study.observed_identity?.script_id !== authority.script_id
    || String(study.observed_identity?.script_version) !== authority.script_version) {
    throw attentionError(
      'rsi_applied_script_identity_mismatch',
      'The settled RSI study ID/version does not match the verified source binding.',
    );
  }
  if (study.loading !== false || study.restarting !== false || study.completed !== true) {
    throw attentionError('rsi_study_unsettled', 'The exact RSI study is loading or incomplete.');
  }
  if (normalizeSymbol(study.source_symbol) !== canonicalRoute.route_identity.resolved_symbol
    || normalizeTimeframe(study.source_timeframe) !== canonicalRoute.route_identity.timeframe) {
    throw attentionError(
      'rsi_study_source_route_mismatch',
      'The exact RSI study source has not moved to the requested chart route.',
    );
  }
  if (study.current_bar_time_ms !== snapshot.current_bar_time_ms
    || study.last_closed_bar_time_ms !== snapshot.last_closed_bar_time_ms) {
    throw attentionError(
      'rsi_study_bar_time_mismatch',
      'The exact RSI machine rows are not aligned with the main chart bars.',
    );
  }
  return snapshot;
}

export async function readSettledRsiRouteSnapshot({
  route,
  smaFibReading,
  authority,
  evaluate,
  pause,
  timeoutMs = 5_000,
  pollIntervalMs = 200,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('RSI settle timeout and poll interval must be positive integers.');
  }
  const maximumPolls = Math.max(2, Math.ceil(timeoutMs / pollIntervalMs));
  const expression = buildExactRsiStudyReadExpression();
  let latest = null;
  let latestError = null;
  let stableSignature = null;
  let stablePolls = 0;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await evaluate(expression);
    try {
      assertSettledRsiSnapshot(latest, route, smaFibReading, authority);
      const signature = settledRsiSnapshotSignature(latest);
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      latestError = null;
      if (stablePolls >= 2) return latest;
    } catch (error) {
      latestError = error;
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  const error = attentionError(
    latestError?.code ?? 'rsi_route_settle_timeout',
    `RSI route did not settle twice on the exact source and bars: ${latestError?.message ?? 'unknown state'}`,
  );
  error.latest_snapshot = latest;
  throw error;
}

function scannerDeps(deps, readRoute, scanAsOfTimeMs) {
  const forwarded = { ...deps, readRoute, now: () => scanAsOfTimeMs };
  for (const key of [
    'scanExplicit',
    'scanCurrent',
    'smaFibReadRoute',
    'readRsiRouteSnapshot',
    'loadRsiSourceBindingContract',
    'adaptRsiStudySnapshot',
  ]) delete forwarded[key];
  return forwarded;
}

/**
 * Scan either an explicit exchange-qualified universe (`symbols`) or the
 * complete active watchlist (omit `symbols`). No Pine, alert, or cloud writes
 * occur. `_deps` is reserved for deterministic local tests.
 */
export async function scanUnifiedAttention({
  symbols,
  priceBufferPct = 5,
  alignmentTolerancePct = 0,
  maBufferPct,
  fibBufferPct,
  query,
  staleAfterMs,
  exclusiveChartUseConfirmed,
  _deps = {},
} = {}) {
  requireExclusiveChartUseConfirmed(exclusiveChartUseConfirmed);
  const now = _deps.now ?? Date.now;
  const scanAsOfTimeMs = scanTimestamp(typeof now === 'function' ? now() : now);
  const scanExplicit = _deps.scanExplicit ?? scanSmaFibWatchlist;
  const scanCurrent = _deps.scanCurrent ?? scanCurrentSmaFibWatchlist;
  const evaluate = _deps.evaluate ?? defaultEvaluate;
  const pause = _deps.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const smaFibReadRoute = _deps.smaFibReadRoute
    ?? _deps.readRoute
    ?? (route => readCurrentSmaFibRoute({
      requestedSymbol: route.symbol,
      timeframe: route.timeframe,
      previousRouteMarker: route.previousRouteMarker,
      requireSourceTransition: route.requireSourceTransition,
      timeoutMs: _deps.routeTimeoutMs,
      pollIntervalMs: _deps.pollIntervalMs,
      _deps: {
        evaluate,
        pause: _deps.pause,
        sourceAuthority: route.sourceAuthority ?? null,
        allowMainOnly: route.allowMainOnly === true,
      },
    }));
  const adaptRsiStudySnapshot = _deps.adaptRsiStudySnapshot
    ?? adaptExactRsiStudySnapshot;
  const binding = resolveRsiBinding(
    _deps.loadRsiSourceBindingContract ?? readLocalRsiSourceBindingContract,
  );
  const readRsiRouteSnapshot = _deps.readRsiRouteSnapshot
    ?? (route => readSettledRsiRouteSnapshot({
      route,
      smaFibReading: route.smaFibReading,
      authority: binding.authority,
      evaluate,
      pause,
      timeoutMs: _deps.rsiTimeoutMs,
      pollIntervalMs: _deps.rsiPollIntervalMs,
    }));
  const rsiByRoute = new Map();
  const rsiFailureByRoute = new Map();

  const recordRsiFailure = (route, error, stage = 'rsi_route_read') => {
    const symbol = normalizeSymbol(route.symbol);
    const timeframe = normalizeTimeframe(route.timeframe);
    const key = routeKey(symbol, timeframe);
    rsiFailureByRoute.set(key, {
      symbol,
      timeframe,
      stage,
      ...errorRecord(error),
    });
  };

  const readUnifiedRoute = async route => {
    let smaFibReading;
    try {
      smaFibReading = await smaFibReadRoute(route);
    } catch (error) {
      recordRsiFailure(
        route,
        attentionError(
          'rsi_shared_route_unavailable',
          'RSI was not read because the shared chart route did not settle for SMA/Fib.',
        ),
        'shared_route_settlement',
      );
      throw error;
    }
    if (!binding.available) {
      recordRsiFailure(route, Object.assign(
        new Error(binding.failure.message),
        { code: binding.failure.code },
      ), 'source_binding');
      return smaFibReading;
    }
    try {
      const rawSnapshot = await readRsiRouteSnapshot({
        symbol: normalizeSymbol(route.symbol),
        timeframe: normalizeTimeframe(route.timeframe),
        smaFibReading,
      });
      const canonicalRoute = canonicalizeRsiSnapshotRoute(
        rawSnapshot,
        route,
        smaFibReading,
      );
      const adapted = adaptRsiStudySnapshot(
        authorizeRsiSnapshot(canonicalRoute.snapshot, binding.authority),
        {
          expectedSourceSha256: binding.authority.source_sha256,
          expectedSemanticInputsSha256: binding.authority.semantic_inputs_sha256,
          scanAsOfTimeMs,
        },
      );
      const key = routeKey(route.symbol, route.timeframe);
      if (rsiByRoute.has(key)) {
        throw attentionError('rsi_route_duplicate', `RSI route was collected twice: ${key}`);
      }
      rsiByRoute.set(key, {
        current: markObservationSourceVerified(
          adapted.current,
          binding.authority,
          canonicalRoute.route_identity,
        ),
        last_closed: markObservationSourceVerified(
          adapted.last_closed,
          binding.authority,
          canonicalRoute.route_identity,
        ),
      });
      // An exact-V2 attempt can fail before the SMA/Fib scanner retries the
      // same route in main-series-only mode. A successful typed RSI read on
      // that retry supersedes the earlier shared-route failure receipt.
      rsiFailureByRoute.delete(key);
    } catch (error) {
      recordRsiFailure(route, error);
    }
    return smaFibReading;
  };

  const commonScanOptions = {
    priceBufferPct,
    alignmentTolerancePct,
    maBufferPct,
    fibBufferPct,
    exclusiveChartUseConfirmed: true,
    _deps: scannerDeps(_deps, readUnifiedRoute, scanAsOfTimeMs),
  };
  const mode = symbols === undefined ? 'active_watchlist' : 'explicit_symbols';
  const smaFibScan = mode === 'active_watchlist'
    ? await scanCurrent(commonScanOptions)
    : await scanExplicit({ ...commonScanOptions, symbols });

  const requestedSymbols = smaFibScan.requested_symbols.map(normalizeSymbol);
  for (const symbol of requestedSymbols) {
    for (const timeframe of TIMEFRAMES) {
      const key = routeKey(symbol, timeframe);
      if (rsiByRoute.has(key) || rsiFailureByRoute.has(key)) continue;
      const reason = binding.available
        ? attentionError(
            'rsi_route_not_collected',
            'The shared SMA/Fib scan did not reach this route for a typed RSI read.',
          )
        : Object.assign(new Error(binding.failure.message), { code: binding.failure.code });
      recordRsiFailure(
        { symbol, timeframe },
        reason,
        binding.available ? 'shared_route_coverage' : 'source_binding',
      );
    }
  }

  const rsiCurrent = [...rsiByRoute.values()].map(value => value.current);
  const rsiLastClosed = [...rsiByRoute.values()].map(value => value.last_closed);
  const routeRsiFailures = [...rsiFailureByRoute.values()].sort((left, right) => (
    left.symbol.localeCompare(right.symbol) || left.timeframe.localeCompare(right.timeframe)
  ));
  const rsiFailures = !binding.available && requestedSymbols.length === 0
    ? [{
        symbol: null,
        timeframe: null,
        stage: 'source_binding',
        ...binding.failure,
      }]
    : routeRsiFailures;
  const effectiveQuery = query === undefined
    ? { minimumFamilyCount: 1, observationKinds: ['current'] }
    : { observationKinds: ['current'], ...query };
  const snapshot = buildAttentionSnapshot(smaFibScan, {
    generatedAtMs: scanAsOfTimeMs,
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    rsiObservations: rsiCurrent,
    rsiLastClosedObservations: rsiLastClosed,
    rsiFailures,
    attentionQuery: effectiveQuery,
  });
  const joinCoverage = buildJoinCoverage(
    requestedSymbols,
    smaFibScan.observations,
    smaFibScan.last_closed_observations,
    rsiCurrent,
    rsiLastClosed,
  );
  const complete = binding.available
    && snapshot.coverage.complete
    && joinCoverage.complete;

  return {
    schema_version: UNIFIED_ATTENTION_SCAN_SCHEMA_VERSION,
    success: true,
    status: complete ? 'complete' : 'degraded',
    persistent_writes: false,
    alerts_modified: false,
    transient_chart_mutation: smaFibScan.transient_chart_mutation,
    scan_as_of_time_ms: scanAsOfTimeMs,
    universe: snapshot.universe,
    source_binding: {
      sma_fib: smaFibScan.preflight?.source_binding ?? {
        verified: false,
        failure: {
          code: 'sma_fib_source_binding_missing',
          message: 'The SMA/Fib scan did not return a source-binding receipt.',
        },
      },
      rsi: binding.available
        ? { verified: true, ...binding.authority }
        : { verified: false, failure: binding.failure },
    },
    coverage: snapshot.coverage,
    join_coverage: joinCoverage,
    detectors: {
      sma_fib: {
        current: smaFibScan.observations,
        last_closed: smaFibScan.last_closed_observations,
        failures: snapshot.coverage.detectors.sma_fib.failures,
      },
      rsi: {
        current: rsiCurrent,
        last_closed: rsiLastClosed,
        failures: rsiFailures,
      },
    },
    attention_cards: snapshot.attention_cards,
    query_result: {
      ...snapshot.attention_query_result,
      defaulted_to_active_families: query === undefined,
    },
    snapshot,
    sma_fib_scan: smaFibScan,
  };
}
