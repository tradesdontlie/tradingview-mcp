import { createHash } from 'node:crypto';

export const SMA_FIB_ALERT_SCANNER_SCHEMA_VERSION = 'sma-fib-watchlist-alert-scanner/v1';
export const SMA_FIB_ALERT_MESSAGE_SCHEMA_VERSION = 'sma-fib-watchlist-alert-message/v1';
export const SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD = 30;
export const SMA_FIB_ALERT_MAX_MESSAGE_BYTES = 40_960;

export const SMA_FIB_ALERT_EVENT_BITS = Object.freeze({
  MA_APPROACH: 1,
  MA_TOUCH: 2,
  MA_CROSS_UP: 4,
  MA_CROSS_DOWN: 8,
  FIB_APPROACH: 16,
  FIB_TOUCH: 32,
  FIB_INSIDE: 64,
});

const EVENT_ENTRIES = Object.freeze(Object.entries(SMA_FIB_ALERT_EVENT_BITS));
const ALL_EVENT_BITS = EVENT_ENTRIES.reduce((mask, [, bit]) => mask + bit, 0);
const EXCHANGE_QUALIFIED_SYMBOL = /^[A-Z0-9_]+:[A-Z0-9][A-Z0-9._!\-/]*$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveFinite(value) {
  return finite(value) && value > 0;
}

function requireNonNegativePercent(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new TypeError(`${label} must be a finite, non-negative percentage.`);
  }
  return result;
}

function normalizeProfile(value) {
  const profile = String(value ?? '').trim().toUpperCase();
  if (profile === 'D' || profile === '1D') return '1D';
  if (profile === 'W' || profile === '1W') return '1W';
  throw new TypeError(`Unsupported scanner profile: ${value}`);
}

function normalizeSymbol(value, index) {
  if (typeof value !== 'string') {
    throw new TypeError(`Scanner symbol at index ${index} must be a string.`);
  }
  const symbol = value.trim().toUpperCase();
  if (!EXCHANGE_QUALIFIED_SYMBOL.test(symbol)) {
    throw new TypeError(`Scanner symbol at index ${index} must be exchange-qualified: ${value}`);
  }
  if (symbol.length > 80) {
    throw new RangeError(`Scanner symbol at index ${index} is too long.`);
  }
  return symbol;
}

export function normalizeScannerUniverse(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new TypeError('Scanner universe must contain at least one symbol.');
  }
  const seen = new Set();
  const normalized = symbols.map((value, index) => {
    const symbol = normalizeSymbol(value, index);
    if (seen.has(symbol)) throw new Error(`Duplicate scanner symbol: ${symbol}`);
    seen.add(symbol);
    return symbol;
  });
  return Object.freeze(normalized);
}

export function partitionScannerUniverse(
  symbols,
  maxSymbolsPerShard = SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD,
) {
  const universe = normalizeScannerUniverse(symbols);
  if (!Number.isInteger(maxSymbolsPerShard)
    || maxSymbolsPerShard < 1
    || maxSymbolsPerShard > SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD) {
    throw new RangeError(`maxSymbolsPerShard must be between 1 and ${SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD}.`);
  }
  const shards = [];
  for (let start = 0; start < universe.length; start += maxSymbolsPerShard) {
    shards.push(Object.freeze(universe.slice(start, start + maxSymbolsPerShard)));
  }
  return Object.freeze(shards);
}

export function verifyScannerCoverage(symbols, shards) {
  const universe = normalizeScannerUniverse(symbols);
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new TypeError('Scanner shards must be a non-empty array.');
  }
  const flattened = shards.flat();
  if (flattened.length !== universe.length) {
    throw new Error(`Scanner shard coverage mismatch: expected ${universe.length}, found ${flattened.length}.`);
  }
  const normalizedFlattened = normalizeScannerUniverse(flattened);
  for (let index = 0; index < universe.length; index += 1) {
    if (normalizedFlattened[index] !== universe[index]) {
      throw new Error(`Scanner shard order mismatch at index ${index}.`);
    }
  }
  if (shards.some(shard => shard.length > SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD)) {
    throw new Error(`Scanner shard exceeds ${SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD} symbols.`);
  }
  return true;
}

function percentDistanceToRange(value, low, high) {
  if (![value, low, high].every(positiveFinite)) return null;
  const minimum = Math.min(low, high);
  const maximum = Math.max(low, high);
  if (value >= minimum && value <= maximum) return 0;
  const nearest = value < minimum ? minimum : maximum;
  return Math.abs(value - nearest) / nearest * 100;
}

function percentDistanceBetweenRanges(firstLow, firstHigh, secondLow, secondHigh) {
  if (![firstLow, firstHigh, secondLow, secondHigh].every(positiveFinite)) return null;
  const aLow = Math.min(firstLow, firstHigh);
  const aHigh = Math.max(firstLow, firstHigh);
  const bLow = Math.min(secondLow, secondHigh);
  const bHigh = Math.max(secondLow, secondHigh);
  if (aHigh >= bLow && aLow <= bHigh) return 0;
  if (aHigh < bLow) return (bLow - aHigh) / bLow * 100;
  return (aLow - bHigh) / bHigh * 100;
}

function normalizeBar(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} bar is required.`);
  const close = Number(value.close);
  const high = Number(value.high);
  const low = Number(value.low);
  if (![close, high, low].every(positiveFinite) || low > high || close < low || close > high) {
    throw new TypeError(`${label} bar needs positive low <= close <= high values.`);
  }
  const priorSma = positiveFinite(value.prior_sma) ? value.prior_sma : null;
  const pairEligible = value.pair_eligible === true || value.pair_eligible === 1;
  let pair = null;
  if (pairEligible) {
    const pocketLow = Number(value.golden_bottom ?? value.pocket_low);
    const pocketHigh = Number(value.golden_top ?? value.pocket_high);
    const lowPivotTime = Number(value.low_pivot_time_ms);
    const highPivotTime = Number(value.high_pivot_time_ms);
    if (![pocketLow, pocketHigh].every(positiveFinite) || pocketLow >= pocketHigh) {
      throw new TypeError(`${label} eligible Fib pair needs ordered golden-pocket bounds.`);
    }
    if (![lowPivotTime, highPivotTime].every(Number.isSafeInteger)
      || lowPivotTime <= 0
      || highPivotTime <= lowPivotTime) {
      throw new TypeError(`${label} eligible Fib pair needs ordered positive pivot times.`);
    }
    pair = Object.freeze({
      pocket_low: pocketLow,
      pocket_high: pocketHigh,
      low_pivot_time_ms: lowPivotTime,
      high_pivot_time_ms: highPivotTime,
      id: `${lowPivotTime}-${highPivotTime}`,
    });
  }
  return Object.freeze({ close, high, low, prior_sma: priorSma, pair });
}

function barConditions(bar, { maBufferPct, fibBufferPct }) {
  const maAvailable = positiveFinite(bar.prior_sma);
  const maRangeDistance = maAvailable
    ? percentDistanceBetweenRanges(bar.low, bar.high, bar.prior_sma, bar.prior_sma)
    : null;
  const maNear = maAvailable && maRangeDistance <= maBufferPct;
  const maTouch = maAvailable && bar.low <= bar.prior_sma && bar.high >= bar.prior_sma;

  const fibAvailable = Boolean(bar.pair);
  const fibRangeDistance = fibAvailable
    ? percentDistanceBetweenRanges(
      bar.low,
      bar.high,
      bar.pair.pocket_low,
      bar.pair.pocket_high,
    )
    : null;
  const fibNear = fibAvailable && fibRangeDistance <= fibBufferPct;
  const fibTouch = fibAvailable
    && bar.low <= bar.pair.pocket_high
    && bar.high >= bar.pair.pocket_low;
  const fibInside = fibAvailable
    && percentDistanceToRange(bar.close, bar.pair.pocket_low, bar.pair.pocket_high) === 0;

  return Object.freeze({
    ma_available: maAvailable,
    ma_near: maNear,
    ma_touch: maTouch,
    fib_available: fibAvailable,
    fib_near: fibNear,
    fib_touch: fibTouch,
    fib_inside: fibInside,
    confluence: maNear && fibNear,
  });
}

function setBit(mask, active, bit) {
  return active ? mask + bit : mask;
}

export function decodeSmaFibAlertMask(mask) {
  if (!Number.isSafeInteger(mask) || mask < 0 || mask > ALL_EVENT_BITS) {
    throw new RangeError(`Invalid SMA/Fib alert event mask: ${mask}`);
  }
  return Object.freeze(EVENT_ENTRIES
    .filter(([, bit]) => Math.floor(mask / bit) % 2 === 1)
    .map(([name]) => name));
}

/**
 * Reference per-slot dedupe/bootstrapping model. The generated Pine mirrors this
 * policy with persistent per-slot arrays.
 */
export function reconcileSmaFibScannerSlot(previousState, poll) {
  if (!poll || typeof poll !== 'object') throw new TypeError('Scanner slot poll is required.');
  const closedTargetTime = requireTimestamp(
    poll.closed_target_time_ms,
    'closed_target_time_ms',
  );
  const closedMask = Number(poll.closed_event_mask ?? 0);
  decodeSmaFibAlertMask(closedMask);
  const provisionalTargetTime = poll.provisional_target_time_ms == null
    ? null
    : requireTimestamp(poll.provisional_target_time_ms, 'provisional_target_time_ms');
  const provisionalMask = Number(poll.provisional_event_mask ?? 0);
  decodeSmaFibAlertMask(provisionalMask);

  if (!previousState?.initialized) {
    return Object.freeze({
      events: Object.freeze([]),
      state: Object.freeze({
        initialized: true,
        closed_target_time_ms: closedTargetTime,
        provisional_target_time_ms: provisionalTargetTime,
        provisional_seen_mask: provisionalMask,
      }),
    });
  }

  const events = [];
  let nextClosedTime = previousState.closed_target_time_ms;
  let nextProvisionalTime = previousState.provisional_target_time_ms ?? null;
  let seenMask = Number(previousState.provisional_seen_mask ?? 0);
  decodeSmaFibAlertMask(seenMask);
  if (closedTargetTime !== previousState.closed_target_time_ms) {
    nextClosedTime = closedTargetTime;
    // A provisional pulse for this exact target/episode may already have been
    // delivered. The closed transition is a state upgrade, not a second
    // notification for the same event bits.
    const closedWasProvisional = nextProvisionalTime === closedTargetTime;
    const closedFreshMask = closedWasProvisional
      ? closedMask & ~seenMask & ALL_EVENT_BITS
      : closedMask;
    if (closedFreshMask > 0) {
      events.push(Object.freeze({ path: 'CLOSED', event_mask: closedFreshMask }));
    }
  }

  if (provisionalTargetTime !== null) {
    if (provisionalTargetTime !== nextProvisionalTime) {
      nextProvisionalTime = provisionalTargetTime;
      seenMask = 0;
    }
    const freshMask = provisionalMask & ~seenMask & ALL_EVENT_BITS;
    if (freshMask > 0) {
      events.push(Object.freeze({ path: 'PROVISIONAL', event_mask: freshMask }));
      seenMask |= freshMask;
    }
  }

  return Object.freeze({
    events: Object.freeze(events),
    state: Object.freeze({
      initialized: true,
      closed_target_time_ms: nextClosedTime,
      provisional_target_time_ms: nextProvisionalTime,
      provisional_seen_mask: seenMask,
    }),
  });
}

/**
 * Pure closed-bar reference classifier for the generated Pine contract.
 * Confluence is returned as annotation and is deliberately never an event gate.
 */
export function classifySmaFibClosedEvents({
  previous,
  current,
  maBufferPct = 5,
  fibBufferPct = 5,
}) {
  const maBuffer = requireNonNegativePercent(maBufferPct, 'maBufferPct');
  const fibBuffer = requireNonNegativePercent(fibBufferPct, 'fibBufferPct');
  const previousBar = normalizeBar(previous, 'Previous');
  const currentBar = normalizeBar(current, 'Current');
  const previousConditions = barConditions(previousBar, {
    maBufferPct: maBuffer,
    fibBufferPct: fibBuffer,
  });
  const currentConditions = barConditions(currentBar, {
    maBufferPct: maBuffer,
    fibBufferPct: fibBuffer,
  });

  const samePair = Boolean(
    previousBar.pair
    && currentBar.pair
    && previousBar.pair.id === currentBar.pair.id,
  );
  const previousFibNear = samePair && previousConditions.fib_near;
  const previousFibTouch = samePair && previousConditions.fib_touch;
  const previousFibInside = samePair && previousConditions.fib_inside;
  const crossUp = previousBar.prior_sma !== null
    && currentBar.prior_sma !== null
    && previousBar.close < previousBar.prior_sma
    && currentBar.close >= currentBar.prior_sma;
  const crossDown = previousBar.prior_sma !== null
    && currentBar.prior_sma !== null
    && previousBar.close > previousBar.prior_sma
    && currentBar.close <= currentBar.prior_sma;

  let eventMask = 0;
  eventMask = setBit(
    eventMask,
    currentConditions.ma_near && !previousConditions.ma_near,
    SMA_FIB_ALERT_EVENT_BITS.MA_APPROACH,
  );
  eventMask = setBit(
    eventMask,
    currentConditions.ma_touch && !previousConditions.ma_touch,
    SMA_FIB_ALERT_EVENT_BITS.MA_TOUCH,
  );
  eventMask = setBit(eventMask, crossUp, SMA_FIB_ALERT_EVENT_BITS.MA_CROSS_UP);
  eventMask = setBit(eventMask, crossDown, SMA_FIB_ALERT_EVENT_BITS.MA_CROSS_DOWN);
  eventMask = setBit(
    eventMask,
    currentConditions.fib_near && !previousFibNear,
    SMA_FIB_ALERT_EVENT_BITS.FIB_APPROACH,
  );
  eventMask = setBit(
    eventMask,
    currentConditions.fib_touch && !previousFibTouch,
    SMA_FIB_ALERT_EVENT_BITS.FIB_TOUCH,
  );
  eventMask = setBit(
    eventMask,
    currentConditions.fib_inside && !previousFibInside,
    SMA_FIB_ALERT_EVENT_BITS.FIB_INSIDE,
  );

  return Object.freeze({
    event_mask: eventMask,
    events: decodeSmaFibAlertMask(eventMask),
    conditions: currentConditions,
    confluence: currentConditions.confluence,
    pair_id: currentBar.pair?.id ?? null,
  });
}

function priceText(value) {
  if (!finite(value)) return 'na';
  return value.toFixed(8).replace(/\.?0+$/, '').slice(0, 24);
}

function requireTimestamp(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer in milliseconds.`);
  }
  return result;
}

export function formatSmaFibScannerAlert({ profile, shard, triggers }) {
  const normalizedProfile = normalizeProfile(profile);
  if (!Number.isSafeInteger(shard) || shard < 1) {
    throw new TypeError('Scanner shard must be a positive integer.');
  }
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new TypeError('At least one scanner trigger is required.');
  }
  if (triggers.length > SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD * 2) {
    throw new RangeError(`A scanner alert cannot contain more than ${SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD * 2} closed/provisional lines.`);
  }
  const seenPaths = new Set();
  const seenSymbols = new Set();
  const lines = triggers.map((trigger, index) => {
    const symbol = normalizeSymbol(trigger?.symbol, index);
    const path = trigger.provisional === true ? 'PROVISIONAL' : 'CLOSED';
    const pathKey = `${symbol}:${path}`;
    if (seenPaths.has(pathKey)) throw new Error(`Duplicate scanner trigger path: ${pathKey}`);
    seenPaths.add(pathKey);
    seenSymbols.add(symbol);
    if (seenSymbols.size > SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD) {
      throw new RangeError(`A scanner alert cannot represent more than ${SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD} symbols.`);
    }
    const eventMask = Number(trigger.event_mask);
    const events = decodeSmaFibAlertMask(eventMask);
    if (events.length === 0) throw new Error(`Scanner trigger ${symbol} has no event bits.`);
    const hasMaEvent = events.some(event => event.startsWith('MA_'));
    const hasFibEvent = events.some(event => event.startsWith('FIB_'));
    const targetTime = requireTimestamp(trigger.target_bar_time_ms, 'target_bar_time_ms');
    const targetCloseTime = requireTimestamp(
      trigger.target_bar_close_time_ms,
      'target_bar_close_time_ms',
    );
    const candidatePairId = typeof trigger.pair_id === 'string' && trigger.pair_id.length > 0
      ? trigger.pair_id
      : 'na';
    if (!/^[0-9]+-[0-9]+$|^na$/.test(candidatePairId)) throw new TypeError('Invalid Fib pair id.');
    if (hasFibEvent && candidatePairId === 'na') {
      throw new TypeError(`Scanner trigger ${symbol} has Fib events without a pair id.`);
    }
    const pairId = hasFibEvent ? candidatePairId : 'na';
    const maEpisodeStart = hasMaEvent
      ? trigger.ma_episode_start_time_ms == null
        ? targetTime
        : requireTimestamp(trigger.ma_episode_start_time_ms, 'ma_episode_start_time_ms')
      : null;
    const maEpisodeText = maEpisodeStart ?? 'na';
    const eventKey = `${symbol}:${normalizedProfile}:${path}:${maEpisodeText}:${pairId}:${targetTime}:${eventMask}`;
    const targetCloseUtc = new Date(targetCloseTime).toISOString().slice(0, 16).replace('T', ' ');
    return [
      symbol,
      path,
      `EVENTS=${events.join('+')}`,
      `MASK=${eventMask}`,
      `KEY=${eventKey}`,
      `MA_EP=${maEpisodeText}`,
      `PAIR=${pairId}`,
      `STAGE_TIME=${targetTime}`,
      `CONF=${trigger.confluence === true ? 1 : 0}`,
      `TARGET_CLOSE_UTC=${targetCloseUtc}`,
      `C=${priceText(trigger.close)}`,
      `SMA=${priceText(trigger.prior_sma)}`,
      `GP=${priceText(trigger.pocket_low)}-${priceText(trigger.pocket_high)}`,
    ].join('|');
  });
  const message = `SMA_FIB_ATTENTION|V1|PROFILE=${normalizedProfile}|SHARD=${shard}\n${lines.join('\n')}`;
  const bytes = Buffer.byteLength(message, 'utf8');
  if (bytes >= SMA_FIB_ALERT_MAX_MESSAGE_BYTES) {
    throw new RangeError(`Scanner alert message is ${bytes} bytes; limit is ${SMA_FIB_ALERT_MAX_MESSAGE_BYTES}.`);
  }
  return message;
}

export function buildSmaFibScannerManifest({
  symbols,
  source,
  sourcePath,
  universeSource,
  maBufferPct = 5,
  fibBufferPct = 5,
  provenance = [],
  status = 'LOCAL_ONLY_UNCOMPILED',
}) {
  const universe = normalizeScannerUniverse(symbols);
  const shards = partitionScannerUniverse(universe);
  verifyScannerCoverage(universe, shards);
  if (typeof source !== 'string' || source.length === 0) throw new TypeError('Generated Pine source is required.');
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) throw new TypeError('Generated Pine source path is required.');
  if (!universeSource || typeof universeSource !== 'object') throw new TypeError('Universe source metadata is required.');
  const maBuffer = requireNonNegativePercent(maBufferPct, 'maBufferPct');
  const fibBuffer = requireNonNegativePercent(fibBufferPct, 'fibBufferPct');
  const normalizedProvenance = provenance.map(entry => Object.freeze({ ...entry }));
  const externalUntrackedProvenance = normalizedProvenance.filter(entry => (
    entry.access === 'read_only_user_owned_untracked_reference'
  ));
  const measuredWorstCaseMessageBytes = Math.max(...shards.map((shard, shardIndex) => {
    const message = formatSmaFibScannerAlert({
      profile: '1W',
      shard: shardIndex + 1,
      triggers: shard.flatMap((symbol, symbolIndex) => [false, true].map(provisional => ({
        symbol,
        provisional,
        event_mask: ALL_EVENT_BITS,
        target_bar_time_ms: 4_102_444_800_000 + symbolIndex,
        target_bar_close_time_ms: 4_102_531_200_000 + symbolIndex,
        pair_id: '4100000000000-4101000000000',
        ma_episode_start_time_ms: 4_102_400_000_000 + symbolIndex,
        confluence: true,
        close: 999_999_999_999_999.125,
        prior_sma: 999_999_999_999_998.125,
        pocket_low: 999_999_999_999_996.125,
        pocket_high: 999_999_999_999_997.125,
      }))),
    });
    return Buffer.byteLength(message, 'utf8');
  }));

  return Object.freeze({
    schema_version: SMA_FIB_ALERT_SCANNER_SCHEMA_VERSION,
    status,
    activation_authorized: false,
    source_path: sourcePath,
    source_sha256: sha256(source),
    universe: Object.freeze({
      ...universeSource,
      current_active_watchlist_verified: false,
      ordered_symbols: universe,
      unique_symbol_count: universe.length,
      ordered_symbols_sha256: sha256(universe.join('\n')),
      shard_sizes: Object.freeze(shards.map(shard => shard.length)),
      shards_sha256: sha256(JSON.stringify(shards)),
      candidate_universe_shard_coverage_verified: true,
      coverage_scope: 'exact partitioning of this local candidate universe only; not current-active-watchlist parity',
      duplicate_count: 0,
      omission_count: 0,
    }),
    execution: Object.freeze({
      pine_version: 6,
      target_profiles: Object.freeze(['1D', '1W']),
      one_target_profile_per_instance: true,
      host_symbol: 'BINANCE:BTCUSDT',
      host_timeframe: '60',
      host_chart_type: 'standard_candles',
      max_symbols_per_shard: SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD,
      request_contexts_per_symbol: 1,
      request_tuple_elements: 31,
      request_tuple_limit: 127,
      required_native_alerts: shards.length * 2,
      required_native_alert_formula: '2 * ceil(unique_symbol_count / 30)',
    }),
    signal: Object.freeze({
      ma_type: 'SMA',
      ma_length: 200,
      prior_sma_expression: 'ta.sma(close[1], MA_LENGTH)',
      prior_sma_excludes_current_target_close: true,
      prior_sma_open_target_bar_realtime_safe: true,
      ma_buffer_pct: maBuffer,
      fib_buffer_pct: fibBuffer,
      pivot_left_bars: 5,
      pivot_right_bars: 5,
      golden_pocket_ratios: Object.freeze([0.618, 0.650]),
      independent_event_bits: SMA_FIB_ALERT_EVENT_BITS,
      confluence_role: 'annotation_only_never_a_gate',
      closed_path: 'current_target_time_close_at_host_close_with_shifted_[1]_recovery',
      provisional_path: 'separately_labeled_realtime_only_with_prior_target_context',
      bootstrap_policy: 'seed_without_emitting_pre_existing_closed_or_provisional_conditions',
      runtime_finality_verified: false,
    }),
    alert: Object.freeze({
      mechanism: 'one_aggregate_alert_call_per_instance',
      call_count_in_source: 1,
      alertcondition_count: 0,
      strategy_count: 0,
      max_message_bytes_exclusive: SMA_FIB_ALERT_MAX_MESSAGE_BYTES,
      max_lines_per_aggregate: SMA_FIB_ALERT_MAX_SYMBOLS_PER_SHARD * 2,
      measured_worst_case_exact_universe_bytes: measuredWorstCaseMessageBytes,
      message_budget_verified: measuredWorstCaseMessageBytes < SMA_FIB_ALERT_MAX_MESSAGE_BYTES,
      simultaneous_events: 'preserved_in_one_per_symbol_bitmask',
      event_key: 'symbol:profile:path:ma_episode_start:fib_pair_id:stage_target_time:event_mask',
      runtime_dedupe_verified: false,
    }),
    provenance: Object.freeze(normalizedProvenance),
    reproducibility: Object.freeze({
      clean_checkout_complete: externalUntrackedProvenance.length === 0,
      external_untracked_reference_count: externalUntrackedProvenance.length,
      external_untracked_reference_roles: Object.freeze(
        externalUntrackedProvenance.map(entry => entry.role),
      ),
      required_resolution: externalUntrackedProvenance.length === 0
        ? null
        : 'Vendor a frozen read-only snapshot or replace the external reference with tracked, independently reproducible evidence before live readiness.',
    }),
    unresolved_gates: Object.freeze([
      'Reconcile the generated candidate universe against a fresh complete active-watchlist read.',
      'Compile exact source bytes in authenticated TradingView Pine v6.',
      'Verify closed and provisional parity across daily and weekly mixed-exchange fixtures.',
      'Create native alerts only after separate exact approval.',
    ]),
  });
}
