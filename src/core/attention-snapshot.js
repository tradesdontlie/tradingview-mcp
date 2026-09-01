/** Versioned, read-only consumer contract for dashboards and other local tools. */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { buildAttentionCards, queryAttentionCards } from './attention-router.js';
import { RSI_SELECTED_SOURCE_SHA256 } from './rsi-study-adapter.js';

export const ATTENTION_SNAPSHOT_SCHEMA_VERSION = 'investment-attention-snapshot/v1';
export const ATTENTION_SNAPSHOT_FILENAME = 'investment-attention-snapshot.json';

const RSI_SOURCE_BINDING_SCHEMA_VERSION = 'rsi-attention-source-binding/v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireTimestamp(value, label) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer in milliseconds.`);
  }
  return result;
}

function normalizedSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) return null;
  return symbol;
}

function normalizedTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  return null;
}

function requestedUniverse(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('scanResult must include the exact requested_symbols universe.');
  }
  const symbols = [];
  const seen = new Set();
  const duplicates = [];
  const invalid = [];
  rows.forEach((row, index) => {
    const symbol = normalizedSymbol(typeof row === 'string' ? row : row?.symbol);
    if (!symbol) {
      invalid.push(index);
      return;
    }
    if (seen.has(symbol)) duplicates.push(symbol);
    else {
      seen.add(symbol);
      symbols.push(symbol);
    }
  });
  return {
    symbols: symbols.sort(),
    duplicates: [...new Set(duplicates)].sort(),
    invalid_indexes: invalid,
    exact: duplicates.length === 0 && invalid.length === 0,
  };
}

function expectedKeys(symbols, observationKind = null) {
  return symbols.flatMap(symbol => ['D', 'W'].map(timeframe => (
    observationKind
      ? `${symbol}|${timeframe}|${observationKind}`
      : `${symbol}|${timeframe}`
  ))).sort();
}

function collectionReceipt(rows, expected, { observationKind = null } = {}) {
  const seen = new Set();
  const duplicates = [];
  const unexpected = [];
  rows.forEach((row, index) => {
    const symbol = normalizedSymbol(row?.requested_symbol ?? row?.symbol);
    const timeframe = normalizedTimeframe(row?.timeframe);
    const kind = observationKind ? row?.observation_kind : null;
    if (!symbol || !timeframe || (observationKind && kind !== observationKind)) {
      unexpected.push(`invalid_row_${index}`);
      return;
    }
    const key = observationKind
      ? `${symbol}|${timeframe}|${kind}`
      : `${symbol}|${timeframe}`;
    if (!expected.includes(key)) unexpected.push(key);
    else if (seen.has(key)) duplicates.push(key);
    else seen.add(key);
  });
  const missing = expected.filter(key => !seen.has(key));
  return {
    expected_count: expected.length,
    returned_count: rows.length,
    missing,
    unexpected: [...new Set(unexpected)].sort(),
    duplicates: [...new Set(duplicates)].sort(),
    exact: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0,
  };
}

function coveredCollectionRows(rows, expected, { observationKind = null } = {}) {
  const keys = rows.map(row => {
    const symbol = normalizedSymbol(row?.requested_symbol ?? row?.symbol);
    const timeframe = normalizedTimeframe(row?.timeframe);
    const kind = observationKind ? row?.observation_kind : null;
    if (!symbol || !timeframe || (observationKind && kind !== observationKind)) return null;
    const key = observationKind
      ? `${symbol}|${timeframe}|${kind}`
      : `${symbol}|${timeframe}`;
    return expected.includes(key) ? key : null;
  });
  const counts = new Map();
  keys.forEach(key => {
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return rows.filter((_row, index) => {
    const key = keys[index];
    return key !== null && counts.get(key) === 1;
  });
}

function routeFailure(route) {
  if (!route || typeof route !== 'object') return true;
  return route.status === 'unavailable'
    || route.status === 'active_pair_contract_invalid'
    || route.status === 'insufficient_history'
    || route.status === 'partial_fib_unavailable';
}

function routeFailureFamily(route) {
  if (route?.status === 'partial_fib_unavailable') return 'fib';
  return null;
}

function collectionAnomalyCount(receipt) {
  return receipt.missing.length
    + receipt.unexpected.length
    + receipt.duplicates.length;
}

function collectionFailure(scope, receipt) {
  if (receipt.exact) return null;
  return {
    scope,
    code: 'coverage_collection_mismatch',
    missing: receipt.missing,
    unexpected: receipt.unexpected,
    duplicates: receipt.duplicates,
  };
}

function labeledFailure(detector, failure) {
  if (failure && typeof failure === 'object' && !Array.isArray(failure)) {
    return { ...failure, detector };
  }
  return {
    detector,
    reason: failure == null ? null : String(failure),
  };
}

function familyObservationEvaluable(observation, family) {
  const value = observation?.[family];
  if (!value || typeof value !== 'object') return false;
  if (family === 'ma') return value.available === true;
  return value.available === true
    || (value.status === 'no_active_pair' && value.eligible === false);
}

function familyUnevaluableCount(rows, family) {
  return rows.filter(row => !familyObservationEvaluable(row, family)).length;
}

function familyObservationFailure(currentRows, lastClosedRows, family) {
  const currentCount = familyUnevaluableCount(currentRows, family);
  const lastClosedCount = familyUnevaluableCount(lastClosedRows, family);
  if (currentCount + lastClosedCount === 0) return null;
  return {
    family,
    scope: 'family_observations',
    code: 'family_observation_unevaluable',
    current_count: currentCount,
    last_closed_count: lastClosedCount,
    count: currentCount + lastClosedCount,
  };
}

function rsiAuthorityFailedChecks(observation) {
  return [
    ...(observation?.source?.applied_live_binding_verified === true
      ? [] : ['applied_live_binding_verified']),
    ...(observation?.source?.source_sha256 === RSI_SELECTED_SOURCE_SHA256
      ? [] : ['source_sha256']),
    ...(observation?.source?.binding_contract_schema_version
      === RSI_SOURCE_BINDING_SCHEMA_VERSION
      ? [] : ['binding_contract_schema_version']),
    ...(SHA256_PATTERN.test(observation?.source?.semantic_inputs_sha256 ?? '')
      ? [] : ['semantic_inputs_sha256']),
  ];
}

function rsiAuthorityFailure(observation, scope, rowIndex) {
  const failedChecks = rsiAuthorityFailedChecks(observation);
  if (failedChecks.length === 0) return null;
  return {
    scope,
    code: 'rsi_observation_authority_unverified',
    row_index: rowIndex,
    symbol: normalizedSymbol(observation?.requested_symbol ?? observation?.symbol),
    timeframe: normalizedTimeframe(observation?.timeframe),
    observation_kind: observation?.observation_kind ?? null,
    failed_checks: failedChecks,
  };
}

function rsiAuthorityVerified(observation) {
  return rsiAuthorityFailedChecks(observation).length === 0;
}

/** Build a compact snapshot without chart baselines, credentials, or alert state. */
export function buildAttentionSnapshot(scanResult, {
  generatedAtMs = scanResult?.scan_as_of_time_ms ?? Date.now(),
  staleAfterMs = 6 * 60 * 60 * 1000,
  rsiObservations,
  rsiLastClosedObservations,
  rsiFailures = [],
  attentionQuery,
} = {}) {
  if (!scanResult || typeof scanResult !== 'object' || scanResult.success !== true) {
    throw new TypeError('scanResult must be a successful scan result.');
  }
  if (!Array.isArray(scanResult.routes)
    || !Array.isArray(scanResult.observations)
    || !Array.isArray(scanResult.last_closed_observations)) {
    throw new TypeError('scanResult lacks the versioned attention collections.');
  }
  const generated = requireTimestamp(generatedAtMs, 'generatedAtMs');
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new TypeError('staleAfterMs must be a positive integer.');
  }
  const rsiRequested = rsiObservations !== undefined
    || rsiLastClosedObservations !== undefined;
  if (rsiRequested
    && (!Array.isArray(rsiObservations) || !Array.isArray(rsiLastClosedObservations))) {
    throw new TypeError('RSI snapshot coverage requires both current and last-closed arrays.');
  }
  if (!Array.isArray(rsiFailures)) throw new TypeError('rsiFailures must be an array.');
  const universeReceipt = requestedUniverse(scanResult.requested_symbols);
  const symbols = universeReceipt.symbols;
  const expectedRouteCount = symbols.length * 2;
  const routeFailures = scanResult.routes.filter(routeFailure).map(route => ({
    symbol: route?.requested_symbol ?? route?.symbol ?? null,
    timeframe: route?.timeframe ?? null,
    status: route?.status ?? 'missing',
    reason: route?.unavailable_reason ?? route?.error?.code ?? null,
    ...(routeFailureFamily(route) ? { family: routeFailureFamily(route) } : {}),
  }));
  const detectorFailures = Array.isArray(scanResult.detector_failures)
    ? scanResult.detector_failures.map(failure => ({
        family: failure?.detector ?? null,
        code: failure?.code ?? 'detector_unavailable',
        message: failure?.message ?? null,
      }))
    : [];
  const smaFibSourceBinding = scanResult.preflight?.source_binding;
  if (smaFibSourceBinding?.verified !== true) {
    const bindingFailure = smaFibSourceBinding?.failure ?? {
      code: 'sma_fib_source_binding_missing',
      message: 'The SMA/Fib scan did not return a verified source-binding receipt.',
    };
    if (!detectorFailures.some(failure => (
      failure.family === 'fib' && failure.code === bindingFailure.code
    ))) {
      detectorFailures.push({
        family: 'fib',
        code: bindingFailure.code,
        message: bindingFailure.message ?? null,
      });
    }
  }
  const universe = scanResult.watchlist
    ? {
        mode: 'active_watchlist',
        list_id: scanResult.watchlist.list_id ?? null,
        list_name: scanResult.watchlist.list_name,
        declared_count: scanResult.watchlist.count,
        symbols,
      }
    : {
        mode: 'explicit_symbols',
        list_id: null,
        list_name: null,
        declared_count: symbols.length,
        symbols,
      };
  const declaredUniverseComplete = universeReceipt.exact
    && (!scanResult.watchlist || scanResult.watchlist.count === symbols.length)
    && (!scanResult.watchlist?.symbols
      || JSON.stringify([...scanResult.watchlist.symbols].map(value => String(value).toUpperCase()).sort())
        === JSON.stringify(symbols));
  const routeCollection = collectionReceipt(
    scanResult.routes,
    expectedKeys(symbols),
  );
  const currentCollection = collectionReceipt(
    scanResult.observations,
    expectedKeys(symbols, 'current'),
    { observationKind: 'current' },
  );
  const lastClosedCollection = collectionReceipt(
    scanResult.last_closed_observations,
    expectedKeys(symbols, 'last_closed'),
    { observationKind: 'last_closed' },
  );
  const smaFibCollectionFailures = [
    collectionFailure('routes', routeCollection),
    collectionFailure('current_observations', currentCollection),
    collectionFailure('last_closed_observations', lastClosedCollection),
  ].filter(Boolean);
  const sharedSmaFibCollectionComplete = declaredUniverseComplete
    && routeCollection.exact
    && currentCollection.exact
    && lastClosedCollection.exact;
  const sharedMissingObservationCount = currentCollection.missing.length
    + lastClosedCollection.missing.length;
  const sharedCollectionAnomalyCount = collectionAnomalyCount(routeCollection)
    + collectionAnomalyCount(currentCollection)
    + collectionAnomalyCount(lastClosedCollection);
  const maUnevaluableCount = familyUnevaluableCount(scanResult.observations, 'ma')
    + familyUnevaluableCount(scanResult.last_closed_observations, 'ma');
  const fibUnevaluableCount = familyUnevaluableCount(scanResult.observations, 'fib')
    + familyUnevaluableCount(scanResult.last_closed_observations, 'fib');
  const familyObservationFailures = [
    familyObservationFailure(
      scanResult.observations,
      scanResult.last_closed_observations,
      'ma',
    ),
    familyObservationFailure(
      scanResult.observations,
      scanResult.last_closed_observations,
      'fib',
    ),
  ].filter(Boolean);
  const smaFibFailures = [
    ...routeFailures,
    ...detectorFailures,
    ...smaFibCollectionFailures,
    ...familyObservationFailures,
  ];
  const familyFailureCount = family => detectorFailures
    .filter(failure => failure.family === family).length;
  const familyRouteFailureCount = family => routeFailures
    .filter(failure => failure.family === family).length;
  const uncoveredFamilyRouteFailureCount = (family, unevaluableCount) => Math.max(
    0,
    familyRouteFailureCount(family) - unevaluableCount,
  );
  const maComplete = sharedSmaFibCollectionComplete
    && familyFailureCount('ma') === 0
    && familyRouteFailureCount('ma') === 0
    && maUnevaluableCount === 0;
  const fibComplete = sharedSmaFibCollectionComplete
    && familyFailureCount('fib') === 0
    && familyRouteFailureCount('fib') === 0
    && fibUnevaluableCount === 0;
  const smaFibComplete = maComplete && fibComplete;
  const normalizedRsiCurrent = rsiObservations ?? [];
  const normalizedRsiLastClosed = rsiLastClosedObservations ?? [];
  const rsiCurrentCollection = collectionReceipt(
    normalizedRsiCurrent,
    expectedKeys(symbols, 'current'),
    { observationKind: 'current' },
  );
  const rsiLastClosedCollection = collectionReceipt(
    normalizedRsiLastClosed,
    expectedKeys(symbols, 'last_closed'),
    { observationKind: 'last_closed' },
  );
  const rsiCollectionFailures = rsiRequested
    ? [
        collectionFailure('current_observations', rsiCurrentCollection),
        collectionFailure('last_closed_observations', rsiLastClosedCollection),
      ].filter(Boolean)
    : [];
  const rsiAuthorityFailures = rsiRequested
    ? [
        ...normalizedRsiCurrent.map((observation, index) => (
          rsiAuthorityFailure(observation, 'current_observation_authority', index)
        )),
        ...normalizedRsiLastClosed.map((observation, index) => (
          rsiAuthorityFailure(observation, 'last_closed_observation_authority', index)
        )),
      ].filter(Boolean)
    : [];
  const rsiCoverageFailures = [
    ...rsiFailures,
    ...rsiCollectionFailures,
    ...rsiAuthorityFailures,
  ];
  const rsiComplete = rsiRequested
    && rsiCurrentCollection.exact
    && rsiLastClosedCollection.exact
    && rsiFailures.length === 0
    && rsiAuthorityFailures.length === 0;
  const failures = [
    ...smaFibFailures.map(failure => labeledFailure('sma_fib', failure)),
    ...rsiCoverageFailures.map(failure => labeledFailure('rsi', failure)),
  ];
  const coveredSmaFibCurrent = coveredCollectionRows(
    scanResult.observations,
    expectedKeys(symbols, 'current'),
    { observationKind: 'current' },
  );
  const coveredSmaFibLastClosed = coveredCollectionRows(
    scanResult.last_closed_observations,
    expectedKeys(symbols, 'last_closed'),
    { observationKind: 'last_closed' },
  );
  const coveredRsiCurrent = coveredCollectionRows(
    normalizedRsiCurrent,
    expectedKeys(symbols, 'current'),
    { observationKind: 'current' },
  ).filter(rsiAuthorityVerified);
  const coveredRsiLastClosed = coveredCollectionRows(
    normalizedRsiLastClosed,
    expectedKeys(symbols, 'last_closed'),
    { observationKind: 'last_closed' },
  ).filter(rsiAuthorityVerified);
  const currentCards = buildAttentionCards({
    smaFibObservations: coveredSmaFibCurrent,
    rsiObservations: coveredRsiCurrent,
  });
  const lastClosedCards = buildAttentionCards({
    smaFibObservations: coveredSmaFibLastClosed,
    rsiObservations: coveredRsiLastClosed,
  });
  const allCards = [...currentCards, ...lastClosedCards];
  const attentionQueryMatches = attentionQuery === undefined
    ? []
    : queryAttentionCards(allCards, attentionQuery);

  return {
    schema_version: ATTENTION_SNAPSHOT_SCHEMA_VERSION,
    generated_at_ms: generated,
    generated_at_utc: new Date(generated).toISOString(),
    stale_after_ms: generated + staleAfterMs,
    stale_after_utc: new Date(generated + staleAfterMs).toISOString(),
    read_only: true,
    universe,
    coverage: {
      expected_route_count: expectedRouteCount,
      returned_route_count: scanResult.routes.length,
      current_observation_count: scanResult.observations.length,
      last_closed_observation_count: scanResult.last_closed_observations.length,
      failure_count: failures.length,
      sma_fib_failure_count: smaFibFailures.length,
      sma_fib_failures: smaFibFailures,
      requested_detectors: rsiRequested ? ['sma_fib', 'rsi'] : ['sma_fib'],
      requested_families: rsiRequested ? ['ma', 'fib', 'rsi'] : ['ma', 'fib'],
      complete: smaFibComplete && (!rsiRequested || rsiComplete),
      failures,
      universe_receipt: {
        declared_complete: declaredUniverseComplete,
        duplicates: universeReceipt.duplicates,
        invalid_indexes: universeReceipt.invalid_indexes,
      },
      route_collection: routeCollection,
      current_collection: currentCollection,
      last_closed_collection: lastClosedCollection,
      detectors: {
        sma_fib: {
          requested: true,
          current_observation_count: scanResult.observations.length,
          last_closed_observation_count: scanResult.last_closed_observations.length,
          failure_count: smaFibFailures.length,
          failures: smaFibFailures,
          complete: smaFibComplete,
          route_collection_complete: routeCollection.exact,
          current_collection_complete: currentCollection.exact,
          last_closed_collection_complete: lastClosedCollection.exact,
          evaluability_complete: smaFibComplete,
          families: {
            ma: {
              requested: true,
              complete: maComplete,
              failure_count: familyFailureCount('ma')
                + maUnevaluableCount
                + sharedCollectionAnomalyCount
                + uncoveredFamilyRouteFailureCount('ma', maUnevaluableCount),
              missing_observation_count: sharedMissingObservationCount,
              collection_anomaly_count: sharedCollectionAnomalyCount,
            },
            fib: {
              requested: true,
              complete: fibComplete,
              failure_count: familyFailureCount('fib')
                + fibUnevaluableCount
                + sharedCollectionAnomalyCount
                + uncoveredFamilyRouteFailureCount('fib', fibUnevaluableCount),
              missing_observation_count: sharedMissingObservationCount,
              collection_anomaly_count: sharedCollectionAnomalyCount,
            },
          },
        },
        rsi: {
          requested: rsiRequested,
          current_observation_count: normalizedRsiCurrent.length,
          last_closed_observation_count: normalizedRsiLastClosed.length,
          failure_count: rsiCoverageFailures.length,
          complete: rsiComplete,
          failures: rsiCoverageFailures,
          current_collection: rsiCurrentCollection,
          last_closed_collection: rsiLastClosedCollection,
        },
      },
    },
    criteria: scanResult.attention_criteria ?? null,
    current: scanResult.observations,
    last_closed: scanResult.last_closed_observations,
    rsi_current: normalizedRsiCurrent,
    rsi_last_closed: normalizedRsiLastClosed,
    attention_cards: {
      current: currentCards,
      last_closed: lastClosedCards,
    },
    sma_fib_query_result: scanResult.query_result ?? null,
    attention_query_result: {
      applied: attentionQuery !== undefined,
      criteria: attentionQuery ?? null,
      match_count: attentionQueryMatches.length,
      matches: attentionQueryMatches,
    },
  };
}

function assertSafeTarget(path, allowedRoot) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new TypeError('snapshotPath must be an absolute path.');
  }
  if (typeof allowedRoot !== 'string' || !isAbsolute(allowedRoot)) {
    throw new TypeError('allowedRoot must be an absolute path.');
  }
  if (basename(path) !== ATTENTION_SNAPSHOT_FILENAME) {
    throw new TypeError(`snapshot filename must be ${ATTENTION_SNAPSHOT_FILENAME}.`);
  }
  const rootPath = resolve(allowedRoot);
  if (dirname(rootPath) === rootPath) {
    throw new TypeError('allowedRoot must be a dedicated directory, not a filesystem root.');
  }
  const rootMetadata = lstatSync(rootPath);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`snapshot root is unsafe: ${rootPath}`);
  }
  const canonicalRoot = realpathSync(rootPath);
  if (canonicalRoot !== rootPath) {
    throw new Error('snapshot root path must be canonical and contain no symlink ancestors.');
  }
  const parent = dirname(path);
  const relativeParent = relative(rootPath, resolve(parent));
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new Error('snapshotPath must stay inside allowedRoot.');
  }
  const canonicalParent = realpathSync(parent);
  const canonicalRelativeParent = relative(canonicalRoot, canonicalParent);
  if (canonicalRelativeParent === '..'
    || canonicalRelativeParent.startsWith(`..${sep}`)
    || isAbsolute(canonicalRelativeParent)) {
    throw new Error('snapshotPath resolves outside allowedRoot.');
  }
  let cursor = rootPath;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`snapshot ancestor is unsafe: ${cursor}`);
    }
  }
  const parentMetadata = lstatSync(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`snapshot parent is unsafe: ${parent}`);
  }
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`snapshot target is unsafe: ${path}`);
    }
    let existing;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    if (existing?.schema_version !== ATTENTION_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error('refusing to replace a non-snapshot file.');
    }
  }
  return parent;
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('snapshot durable write made no forward progress.');
    }
    offset += written;
  }
}

/** Atomically replace one explicitly chosen local snapshot file. */
export function writeAttentionSnapshotAtomic(snapshot, snapshotPath, { allowedRoot } = {}) {
  if (snapshot?.schema_version !== ATTENTION_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`snapshot must use ${ATTENTION_SNAPSHOT_SCHEMA_VERSION}.`);
  }
  const parent = assertSafeTarget(snapshotPath, allowedRoot);
  const temporary = join(parent, `.${basename(snapshotPath)}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertSafeTarget(snapshotPath, allowedRoot);
    renameSync(temporary, snapshotPath);
    const parentDescriptor = openSync(parent, 'r');
    try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return {
    path: snapshotPath,
    bytes: bytes.length,
    schema_version: snapshot.schema_version,
    generated_at_ms: snapshot.generated_at_ms,
  };
}
