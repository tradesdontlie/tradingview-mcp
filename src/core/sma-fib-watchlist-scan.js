/**
 * Read-only SMA/Fib watchlist proximity scan.
 *
 * The scanner changes only the active chart's symbol/timeframe while it reads
 * the already-installed V2 study. It snapshots and restores the original
 * symbol, timeframe, and visible range. It never creates studies or alerts.
 */
import { readFileSync } from 'node:fs';

import { evaluate as defaultEvaluate } from '../connection.js';
import {
  setTimeframe as defaultSetTimeframe,
  setVisibleRange as defaultSetVisibleRange,
} from './chart.js';
import { get as defaultGetWatchlist } from './watchlist.js';
import { withChartControlLease as defaultWithChartControlLease } from './chart-control-lease.js';
import {
  buildSmaFibObservation,
  querySmaFibObservations,
  rankSmaFibObservations,
} from './sma-fib-attention.js';

export const SMA_FIB_WATCH_STUDY_TITLE =
  'SMA/Fib Confluence Alerts + Anchor [200D/200W]';
export const SMA_FIB_SELECTED_SOURCE_SHA256 =
  'a6157850ff55cce7c4c539ab59d0b337a1db553327a8cc8f3ef0147aa9d12ec0';
export const SMA_FIB_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION =
  'sma-fib-attention-source-binding/v1';
export const SMA_FIB_VERIFIED_BINDING_STATUS = 'LIVE_BINDING_VERIFIED';

export const SMA_FIB_WATCH_TIMEFRAMES = Object.freeze(['D', 'W']);

export const SMA_FIB_WATCH_PLOTS = Object.freeze({
  profile_code: Object.freeze({ title: 'SFC Profile Code', index: 1 }),
  prior_sma: Object.freeze({ title: 'SFC Prior 200 SMA', index: 2 }),
  pair_eligible: Object.freeze({ title: 'SFC Pair Eligible', index: 5 }),
  fib_low: Object.freeze({ title: 'SFC Fib Low Price', index: 6 }),
  fib_high: Object.freeze({ title: 'SFC Fib High Price', index: 7 }),
  fib_low_pivot_time_ms: Object.freeze({ title: 'SFC Fib Low Pivot Time ms', index: 8 }),
  fib_high_pivot_time_ms: Object.freeze({ title: 'SFC Fib High Pivot Time ms', index: 9 }),
  fib_high_confirmation_time_ms: Object.freeze({ title: 'SFC Fib High Confirmation Time ms', index: 10 }),
  golden_top: Object.freeze({ title: 'SFC Fib 0.618', index: 12 }),
  golden_bottom: Object.freeze({ title: 'SFC Fib 0.650', index: 13 }),
});

const PROFILE_BY_TIMEFRAME = Object.freeze({
  D: Object.freeze({ code: 1, label: '200D' }),
  W: Object.freeze({ code: 2, label: '200W' }),
});

const DAY_MS = 86_400_000;
const MA_LENGTH = 200;
const BAR_CLOSE_GRACE_MS = 5_000;
const GOLDEN_TOP_RATIO = 0.618;
const GOLDEN_BOTTOM_RATIO = 0.650;
const GOLDEN_LEVEL_ABSOLUTE_TOLERANCE = 1e-8;
const US_CONSOLIDATED_REQUEST_EXCHANGES = new Set(['NYSE', 'NASDAQ']);
const US_CONSOLIDATED_OBSERVED_EXCHANGE = 'BATS';
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SYMBOL_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_TIMEOUT_MS = 15_000;
const DEFAULT_RESTORE_TIMEOUT_MS = 15_000;
const CHART_CONTROL_LEASE_OWNER = 'sma-fib-watchlist-scan';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SMA_FIB_SOURCE_BINDING_CONTRACT_URL = new URL(
  '../../contracts/sma-fib-attention-source-binding-v1.json',
  import.meta.url,
);

// The active chart is shared process state. Serialize this scan with itself so
// two simultaneous tool calls cannot interleave symbol changes and restore the
// wrong baseline. Other chart-mutating tools still need an integration-level
// lease if they may run at the same time.
let scanLock = Promise.resolve();

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sourceBindingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readLocalSmaFibSourceBindingContract() {
  return JSON.parse(readFileSync(SMA_FIB_SOURCE_BINDING_CONTRACT_URL, 'utf8'));
}

export function assertVerifiedSmaFibSourceBindingContract(contract) {
  if (contract?.schema_version !== SMA_FIB_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION) {
    throw sourceBindingError(
      'sma_fib_binding_contract_schema_mismatch',
      `SMA/Fib source binding must use ${SMA_FIB_SOURCE_BINDING_CONTRACT_SCHEMA_VERSION}.`,
    );
  }
  if (contract.status !== SMA_FIB_VERIFIED_BINDING_STATUS
    || contract.live_binding?.verified !== true) {
    throw sourceBindingError(
      'sma_fib_live_binding_unverified',
      'The versioned local contract does not verify the applied SMA/Fib V2 source.',
    );
  }
  if (contract.selected_local_source?.title !== SMA_FIB_WATCH_STUDY_TITLE
    || contract.selected_local_source?.source_sha256 !== SMA_FIB_SELECTED_SOURCE_SHA256
    || contract.live_binding?.source_sha256 !== SMA_FIB_SELECTED_SOURCE_SHA256) {
    throw sourceBindingError(
      'sma_fib_binding_source_mismatch',
      'The verified binding contract does not match the selected local SMA/Fib V2 source.',
    );
  }
  const scriptId = contract.live_binding?.script_id;
  const scriptVersion = contract.live_binding?.script_version;
  if (typeof scriptId !== 'string' || !scriptId.trim()
    || !((typeof scriptVersion === 'string' && scriptVersion.trim())
      || (Number.isSafeInteger(scriptVersion) && scriptVersion > 0))
    || !SHA256_PATTERN.test(contract.live_binding.source_sha256)) {
    throw sourceBindingError(
      'sma_fib_applied_script_identity_unverified',
      'The verified SMA/Fib binding lacks an exact applied script ID/version/source hash.',
    );
  }
  return Object.freeze({
    verified: true,
    schema_version: contract.schema_version,
    status: contract.status,
    source_title: SMA_FIB_WATCH_STUDY_TITLE,
    source_sha256: SMA_FIB_SELECTED_SOURCE_SHA256,
    script_id: scriptId,
    script_version: String(scriptVersion),
    verification_method: contract.live_binding.verification_method
      ?? 'versioned_local_source_binding_contract',
    verified_at_utc: contract.live_binding.verified_at_utc ?? null,
  });
}

function resolveSmaFibSourceAuthority(deps = {}) {
  if (deps.sourceAuthority) return Object.freeze({ ...deps.sourceAuthority, verified: true });
  const loadContract = deps.loadSourceBindingContract
    ?? readLocalSmaFibSourceBindingContract;
  return assertVerifiedSmaFibSourceBindingContract(loadContract());
}

function positiveFinite(value) {
  return finite(value) && value > 0;
}

function requirePercent(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new TypeError(`${label} must be a finite, non-negative percentage.`);
  }
  return result;
}

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  return timeframe;
}

function normalizeSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function errorRecord(error, fallbackCode = 'route_failed') {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function roundMetric(value) {
  return finite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function roundEight(value) {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function goldenLevelMatches(actual, expected) {
  if (!positiveFinite(actual) || !positiveFinite(expected)) return false;
  const floatingPointTolerance = Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected)) * 32;
  return Math.abs(actual - expected)
    <= Math.max(GOLDEN_LEVEL_ABSOLUTE_TOLERANCE, floatingPointTolerance);
}

function scanTimestamp(value = Date.now()) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError('scan timestamp must be a positive integer in milliseconds.');
  }
  return result;
}

function stableValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function percentDistanceToLevel(value, level) {
  if (!positiveFinite(value) || !positiveFinite(level)) return null;
  return Math.abs(value - level) / level * 100;
}

/**
 * Percentage distance from a point to an inclusive range.
 *
 * A point inside the range has zero distance. Outside the range, the
 * denominator is the nearest range edge, matching ordinary "within X% of
 * this level" semantics.
 */
export function percentDistanceToRange(value, firstEdge, secondEdge) {
  if (![value, firstEdge, secondEdge].every(positiveFinite)) return null;
  const low = Math.min(firstEdge, secondEdge);
  const high = Math.max(firstEdge, secondEdge);
  if (value >= low && value <= high) return 0;
  const nearestEdge = value < low ? low : high;
  return Math.abs(value - nearestEdge) / nearestEdge * 100;
}

/** Accept either an array of strings/rows or a watchlist_get-style result. */
export function normalizeWatchlistSymbols(input) {
  const rows = Array.isArray(input) ? input : input?.symbols;
  if (!Array.isArray(rows)) {
    throw new TypeError('symbols must be an array or an object with a symbols array.');
  }
  const seen = new Set();
  const symbols = [];
  rows.forEach((row, index) => {
    const raw = typeof row === 'string' ? row : row?.symbol;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new TypeError(`symbols[${index}] must contain a non-empty symbol.`);
    }
    const symbol = raw.trim();
    const key = symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      symbols.push(symbol);
    }
  });
  return symbols;
}

function qualifiedSymbolParts(value) {
  const normalized = normalizeSymbol(value);
  const separator = normalized.indexOf(':');
  if (separator <= 0 || separator === normalized.length - 1) return null;
  return {
    full: normalized,
    exchange: normalized.slice(0, separator),
    ticker: normalized.slice(separator + 1),
  };
}

/** Resolve against only the authoritative chart identity, never base-name aliases. */
function resolveSymbolIdentity(requestedSymbol, reading) {
  const requested = qualifiedSymbolParts(requestedSymbol);
  const resolved = qualifiedSymbolParts(reading?.chart_symbol);
  if (!requested || !resolved) return null;
  if (resolved.full === requested.full) {
    return { requested_symbol: requested.full, resolved_symbol: resolved.full, match_mode: 'exact' };
  }
  if (US_CONSOLIDATED_REQUEST_EXCHANGES.has(requested.exchange)
    && resolved.exchange === US_CONSOLIDATED_OBSERVED_EXCHANGE
    && resolved.ticker === requested.ticker) {
    return { requested_symbol: requested.full, resolved_symbol: resolved.full, match_mode: 'bats_alias' };
  }
  return null;
}

function symbolIdentityMatches(requestedSymbol, reading) {
  return resolveSymbolIdentity(requestedSymbol, reading) !== null;
}

function routeBase(symbol, timeframe) {
  return {
    symbol,
    timeframe,
    profile: PROFILE_BY_TIMEFRAME[timeframe].label,
  };
}

function unavailableRoute(symbol, timeframe, reason, error) {
  return {
    ...routeBase(symbol, timeframe),
    requested_symbol: normalizeSymbol(symbol),
    resolved_symbol: null,
    match_mode: null,
    status: 'unavailable',
    available: false,
    match: false,
    unavailable_reason: reason,
    error: errorRecord(error),
  };
}

function timingContext(reading, scanAsOfTimeMs) {
  const dataTimeMs = finite(reading.current_bar_time_s) ? reading.current_bar_time_s * 1000 : null;
  const confirmedMs = reading.fib_high_confirmation_time_ms;
  const dataBarOpenAgeDays = finite(dataTimeMs)
    ? Math.max(0, (scanAsOfTimeMs - dataTimeMs) / DAY_MS)
    : null;
  const anchor = finite(dataTimeMs) && finite(confirmedMs) && confirmedMs <= dataTimeMs
    ? {
        reference: 'fib_high_confirmation',
        confirmation_time_ms: confirmedMs,
        as_of_scan_calendar_days: roundMetric(Math.max(0, (scanAsOfTimeMs - confirmedMs) / DAY_MS)),
        as_of_data_bar_calendar_days: roundMetric((dataTimeMs - confirmedMs) / DAY_MS),
      }
    : null;
  return {
    scan_as_of_time_ms: scanAsOfTimeMs,
    data_as_of_time_ms: dataTimeMs,
    data_bar_open_age_calendar_days: roundMetric(dataBarOpenAgeDays),
    anchor_age: anchor,
  };
}

function activePairContractInvalid(base, reason, message, extra = {}) {
  return {
    ...base,
    ...extra,
    status: 'active_pair_contract_invalid',
    available: false,
    match: false,
    active_pair_contract_valid: false,
    active_pair_contract_invalid_reason: reason,
    unavailable_reason: reason,
    error: {
      code: 'active_pair_contract_invalid',
      reason,
      message,
    },
  };
}

/**
 * Turn one settled V2 reading into an explicit scan result.
 */
export function assessSmaFibRoute(reading, {
  priceBufferPct = 5,
  alignmentTolerancePct = 0,
  scanAsOfTimeMs = Date.now(),
} = {}) {
  const priceBuffer = requirePercent(priceBufferPct, 'priceBufferPct');
  const alignmentTolerance = requirePercent(alignmentTolerancePct, 'alignmentTolerancePct');
  const asOfTimeMs = scanTimestamp(scanAsOfTimeMs);
  const timeframe = normalizeTimeframe(reading?.timeframe);
  if (!PROFILE_BY_TIMEFRAME[timeframe]) throw new TypeError(`Unsupported timeframe: ${reading?.timeframe}`);
  const symbol = reading?.requested_symbol || reading?.symbol || reading?.chart_symbol;
  if (typeof symbol !== 'string' || !symbol.trim()) throw new TypeError('reading needs a symbol.');
  const identityResolution = resolveSymbolIdentity(symbol, reading);
  const timing = timingContext(reading, asOfTimeMs);
  const base = {
    ...routeBase(symbol.trim(), timeframe),
    requested_symbol: normalizeSymbol(symbol),
    resolved_symbol: identityResolution?.resolved_symbol ?? null,
    match_mode: identityResolution?.match_mode ?? null,
    chart_symbol: reading.chart_symbol ?? null,
    available: true,
    study_title: SMA_FIB_WATCH_STUDY_TITLE,
    study_visible: reading.study_visible === true,
    current_price: positiveFinite(reading.current_price) ? reading.current_price : null,
    current_low: positiveFinite(reading.current_low) ? reading.current_low : null,
    current_high: positiveFinite(reading.current_high) ? reading.current_high : null,
    current_bar_time_s: finite(reading.current_bar_time_s) ? reading.current_bar_time_s : null,
    scan_as_of_time_ms: timing.scan_as_of_time_ms,
    data_as_of_time_ms: timing.data_as_of_time_ms,
    data_bar_open_age_calendar_days: timing.data_bar_open_age_calendar_days,
    data_bar_open_age_basis: 'current_chart_bar_open_time',
    main_bar_count: Number.isSafeInteger(reading.main_bar_count) ? reading.main_bar_count : null,
    pair_eligible: reading.pair_eligible === true || reading.pair_eligible === 1,
    prior_sma: positiveFinite(reading.prior_sma) ? reading.prior_sma : null,
    fib_low: positiveFinite(reading.fib_low) ? reading.fib_low : null,
    fib_high: positiveFinite(reading.fib_high) ? reading.fib_high : null,
    fib_low_pivot_time_ms: finite(reading.fib_low_pivot_time_ms) ? reading.fib_low_pivot_time_ms : null,
    fib_high_pivot_time_ms: finite(reading.fib_high_pivot_time_ms) ? reading.fib_high_pivot_time_ms : null,
    fib_high_confirmation_time_ms: finite(reading.fib_high_confirmation_time_ms)
      ? reading.fib_high_confirmation_time_ms
      : null,
    golden_pocket: null,
    anchor_age: timing.anchor_age,
    match: false,
  };

  if (!positiveFinite(reading.current_price)) {
    return {
      ...base,
      status: 'unavailable',
      available: false,
      unavailable_reason: 'current_price_unavailable',
      error: { code: 'current_price_unavailable', message: 'Current chart price is unavailable.' },
    };
  }

  if (!positiveFinite(reading.prior_sma)) {
    return {
      ...base,
      status: 'insufficient_history',
      unavailable_reason: 'prior_200_sma_unavailable',
    };
  }

  if (!base.pair_eligible) {
    return { ...base, status: 'no_active_pair' };
  }

  if (![reading.golden_bottom, reading.golden_top, reading.fib_low, reading.fib_high]
    .every(positiveFinite)) {
    return activePairContractInvalid(
      base,
      'active_pair_values_unavailable',
      'V2 reports an active pair but one or more pocket/anchor values are unavailable.',
    );
  }

  const pocketLow = Math.min(reading.golden_bottom, reading.golden_top);
  const pocketHigh = Math.max(reading.golden_bottom, reading.golden_top);
  const dataAsOfTimeMs = base.data_as_of_time_ms;
  const geometryValid = reading.fib_low < reading.fib_high
    && pocketLow < pocketHigh
    && pocketLow >= reading.fib_low
    && pocketHigh <= reading.fib_high;
  if (!geometryValid) {
    return activePairContractInvalid(
      base,
      'invalid_active_pair_geometry',
      'Active V2 geometry must have Fib low < Fib high with the ordered pocket inside that range.',
      { golden_pocket: { low: pocketLow, high: pocketHigh } },
    );
  }
  const fibRange = reading.fib_high - reading.fib_low;
  const expectedGoldenTop = roundEight(reading.fib_high - GOLDEN_TOP_RATIO * fibRange);
  const expectedGoldenBottom = roundEight(reading.fib_high - GOLDEN_BOTTOM_RATIO * fibRange);
  const derivationValid = goldenLevelMatches(reading.golden_top, expectedGoldenTop)
    && goldenLevelMatches(reading.golden_bottom, expectedGoldenBottom);
  if (!derivationValid) {
    return activePairContractInvalid(
      base,
      'invalid_active_pair_golden_derivation',
      'Active V2 golden levels do not match the 0.618 and 0.650 Fib derivations.',
      {
        golden_pocket: { low: pocketLow, high: pocketHigh },
        expected_golden_pocket: { low: expectedGoldenBottom, high: expectedGoldenTop },
      },
    );
  }
  const timestampsValid = [
    reading.fib_low_pivot_time_ms,
    reading.fib_high_pivot_time_ms,
    reading.fib_high_confirmation_time_ms,
    dataAsOfTimeMs,
  ].every(positiveFinite)
    && reading.fib_low_pivot_time_ms < reading.fib_high_pivot_time_ms
    && reading.fib_high_pivot_time_ms < reading.fib_high_confirmation_time_ms
    && reading.fib_high_confirmation_time_ms < dataAsOfTimeMs;
  if (!timestampsValid) {
    return activePairContractInvalid(
      { ...base, anchor_age: null },
      'invalid_active_pair_timestamps',
      'Active V2 timestamps must satisfy low pivot < high pivot < confirmation < data bar.',
      { golden_pocket: { low: pocketLow, high: pocketHigh } },
    );
  }
  const smaToPocketRaw = percentDistanceToRange(reading.prior_sma, pocketLow, pocketHigh);
  const priceToSmaRaw = percentDistanceToLevel(reading.current_price, reading.prior_sma);
  const priceToPocketRaw = percentDistanceToRange(reading.current_price, pocketLow, pocketHigh);
  const jointRaw = Math.max(priceToSmaRaw, priceToPocketRaw);
  const alignmentWithinTolerance = smaToPocketRaw <= alignmentTolerance;
  const priceWithinBuffer = jointRaw <= priceBuffer;
  const match = alignmentWithinTolerance && priceWithinBuffer;
  const status = match
    ? 'match'
    : !alignmentWithinTolerance
      ? 'outside_alignment_tolerance'
      : 'outside_price_buffer';

  return {
    ...base,
    status,
    match,
    active_pair_contract_valid: true,
    golden_pocket: { low: pocketLow, high: pocketHigh },
    sma_to_pocket_pct: roundMetric(smaToPocketRaw),
    price_to_sma_pct: roundMetric(priceToSmaRaw),
    price_to_pocket_pct: roundMetric(priceToPocketRaw),
    joint_distance_pct: roundMetric(jointRaw),
    alignment_within_tolerance: alignmentWithinTolerance,
    price_within_buffer: priceWithinBuffer,
  };
}

function readExpression() {
  const title = key => JSON.stringify(SMA_FIB_WATCH_PLOTS[key].title);
  const requiredTitles = JSON.stringify(Object.values(SMA_FIB_WATCH_PLOTS).map(plot => plot.title));
  return `(function(){/* sma-fib-watchlist-scan:read-v1 */
    function numberOrNull(value){return typeof value==='number'&&Number.isFinite(value)?value:null}
    function unwrap(value){try{return value&&typeof value.value==='function'?value.value():value}catch(error){return null}}
    function scalar(value){value=unwrap(value);if(value===null||value===undefined)return null;if(typeof value==='number'||typeof value==='string'||typeof value==='boolean')return value;try{return JSON.stringify(value)}catch(error){return String(value)}}
    var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!w)return {chart_available:false};
    var c=w._chartWidget;var main=c.model().mainSeries();var bars=main.bars();
    var sources=c.model().model().dataSources();var matches=sources.filter(function(source){try{return source.metaInfo().description===${JSON.stringify(SMA_FIB_WATCH_STUDY_TITLE)}}catch(error){return false}});
    var study=matches.length===1?matches[0]:null;var data=study&&study.data();var meta=study?study.metaInfo():null;
    var plotIndex={};var plotCounts={};var plots=meta&&Array.isArray(meta.plots)?meta.plots:[];
    for(var pi=0;pi<plots.length;pi+=1){var plot=plots[pi]||{};var style=meta.styles&&meta.styles[plot.id];var title=style&&style.title||plot.title;if(title){plotCounts[title]=(plotCounts[title]||0)+1;plotIndex[title]=pi+1}}
    var requiredTitles=${requiredTitles};var missingPlotTitles=requiredTitles.filter(function(title){return !Number.isInteger(plotIndex[title])});var duplicatePlotTitles=requiredTitles.filter(function(title){return plotCounts[title]>1});
    function plotValue(row,title){var index=plotIndex[title];return row&&Number.isInteger(index)?numberOrNull(row[index]):null}
    function priorSmaAt(index){if(!bars||!Number.isInteger(index)||index<${MA_LENGTH})return null;var sum=0;for(var offset=1;offset<=${MA_LENGTH};offset+=1){var row=bars.valueAt(index-offset),close=row&&numberOrNull(row[4]);if(close===null)return null;sum+=close}return sum/${MA_LENGTH}}
    var mainLastIndex=bars&&bars.size()?bars.lastIndex():null;
    var mainLast=Number.isInteger(mainLastIndex)?bars.valueAt(mainLastIndex):null;
    var mainPrevious=bars&&bars.size()>1?bars.valueAt(bars.lastIndex()-1):null;
    var attentionPriorSma=priorSmaAt(mainLastIndex),previousAttentionPriorSma=priorSmaAt(Number.isInteger(mainLastIndex)?mainLastIndex-1:null);
    var lastBarCloseTimeS=Number(main.barCloseTime&&main.barCloseTime()),tradingViewServerTimeMs=Number(window.ChartApiInstance&&window.ChartApiInstance.serverTime&&window.ChartApiInstance.serverTime()),barCloseSignalValid=Number.isFinite(lastBarCloseTimeS)&&Number.isFinite(tradingViewServerTimeMs),currentBarClosed=barCloseSignalValid?tradingViewServerTimeMs>=lastBarCloseTimeS*1000+${BAR_CLOSE_GRACE_MS}:null;
    var studyLast=data&&!data.isEmpty()?data.valueAt(data.lastIndex()):null;
    var studyPrevious=data&&!data.isEmpty()&&data.lastIndex()>0?data.valueAt(data.lastIndex()-1):null;
    var info=main.symbolInfo()||{};var visible=null;var sourceHidden=null;var showGoldenPocket=null;var showGoldenPocketInputCount=0;var showStatusTable=null;var showStatusTableInputCount=0;var source=null;var studySourceSymbol=null;var studySourceInterval=null;var studyTurnaround=null;var studyLoading=null;var studyRestarting=null;var graphicsViewsReady=null;var statusTableCollectionAccessible=false;var statusTableCells=[];
    if(study){
      try{visible=study.properties().visible.value()}catch(error){}
      if(visible===null){try{var id=typeof study.id==='function'?study.id():study.id;var apiStudy=w.getStudyById(id);visible=apiStudy?apiStudy.isVisible():null}catch(error){}}
      try{sourceHidden=typeof study.isSourceHidden==='function'?!!study.isSourceHidden():null}catch(error){}
      try{var exactInputs=meta&&Array.isArray(meta.inputs)?meta.inputs:[];var goldenInputs=exactInputs.filter(function(input){return input&&input.name==='Show Golden Pocket'});showGoldenPocketInputCount=goldenInputs.length;var statusInputs=exactInputs.filter(function(input){return input&&input.name==='Show Research Status Table'});showStatusTableInputCount=statusInputs.length;var inputChildren=study.properties().childs().inputs.childs();var goldenProperty=goldenInputs.length===1&&inputChildren?inputChildren[goldenInputs[0].id]:null;var statusProperty=statusInputs.length===1&&inputChildren?inputChildren[statusInputs[0].id]:null;showGoldenPocket=goldenProperty&&typeof goldenProperty.value==='function'?!!goldenProperty.value():null;showStatusTable=statusProperty&&typeof statusProperty.value==='function'?!!statusProperty.value():null}catch(error){}
      try{source=study.symbolSource();studySourceSymbol=scalar(source&&typeof source.symbol==='function'?source.symbol():source&&source.symbol);studySourceInterval=scalar(source&&typeof source.interval==='function'?source.interval():source&&source.interval)}catch(error){}
      try{studyLoading=!!study.isLoading()}catch(error){}
      try{studyRestarting=!!study.isRestarting()}catch(error){}
      try{studyTurnaround=scalar(study.turnaround())}catch(error){}
      try{graphicsViewsReady=typeof study.graphicsViewsReady==='function'?!!study.graphicsViewsReady():null}catch(error){}
      try{var tableOuter=study._graphics&&study._graphics._primitivesCollection&&study._graphics._primitivesCollection.dwgtablecells;var tableHolder=tableOuter&&tableOuter.get('tableCells');var nestedTableCollection=tableHolder&&typeof tableHolder.get==='function'?tableHolder.get(false):null;var tableCollection=nestedTableCollection&&nestedTableCollection._primitivesDataById&&nestedTableCollection._primitivesDataById.size>0?nestedTableCollection:tableHolder&&tableHolder._primitivesDataById?tableHolder:nestedTableCollection&&nestedTableCollection._primitivesDataById?nestedTableCollection:null;statusTableCollectionAccessible=!!tableCollection;if(tableCollection)tableCollection._primitivesDataById.forEach(function(cell){if(cell&&typeof cell.t==='string')statusTableCells.push({row:cell.row,col:cell.col,text:cell.t})});statusTableCells.sort(function(a,b){return a.row-b.row||a.col-b.col||a.text.localeCompare(b.text)})}catch(error){}
    }
    return {
      chart_available:true,chart_type:Number(w.chartType()),chart_is_standard:[0,1,2,3,9].indexOf(Number(w.chartType()))!==-1,chart_symbol:info.full_name||w.symbol(),chart_symbol_readback:w.symbol(),
      symbol_identity:{full_name:info.full_name||null,pro_name:info.pro_name||null,base_name:info.base_name||[],name:info.name||null,exchange:info.exchange||null},
      timeframe:String(w.resolution()),main_loading:!!main.isLoading(),main_bar_count:bars?bars.size():0,
      bar_close_signal_valid:barCloseSignalValid,last_bar_close_time_s:barCloseSignalValid?lastBarCloseTimeS:null,tradingview_server_time_ms:barCloseSignalValid?tradingViewServerTimeMs:null,current_bar_closed:currentBarClosed,
      main_last_time_s:mainLast?numberOrNull(mainLast[0]):null,current_open:mainLast?numberOrNull(mainLast[1]):null,current_high:mainLast?numberOrNull(mainLast[2]):null,current_low:mainLast?numberOrNull(mainLast[3]):null,current_price:mainLast?numberOrNull(mainLast[4]):null,current_volume:mainLast?numberOrNull(mainLast[5]):null,
      previous_main_time_s:mainPrevious?numberOrNull(mainPrevious[0]):null,previous_open:mainPrevious?numberOrNull(mainPrevious[1]):null,previous_high:mainPrevious?numberOrNull(mainPrevious[2]):null,previous_low:mainPrevious?numberOrNull(mainPrevious[3]):null,previous_price:mainPrevious?numberOrNull(mainPrevious[4]):null,previous_volume:mainPrevious?numberOrNull(mainPrevious[5]):null,
      attention_prior_sma:attentionPriorSma,previous_attention_prior_sma:previousAttentionPriorSma,
      study_match_count:matches.length,study_visible:visible,study_source_hidden:sourceHidden,study_observed_identity:{script_id:meta?scalar(meta.scriptIdPart):null,script_version:meta&&meta.version!==null&&meta.version!==undefined?String(meta.version):null},show_golden_pocket:showGoldenPocket,show_golden_pocket_input_count:showGoldenPocketInputCount,show_status_table:showStatusTable,show_status_table_input_count:showStatusTableInputCount,study_complete:!!(study&&study.isCompleted()),study_last_time_s:studyLast?numberOrNull(studyLast[0]):null,
      study_source_symbol:studySourceSymbol,study_source_timeframe:studySourceInterval,study_loading:studyLoading,study_restarting:studyRestarting,study_turnaround:studyTurnaround,
      graphics_views_ready:graphicsViewsReady,status_table_collection_accessible:statusTableCollectionAccessible,status_table_cells:statusTableCells,
      missing_plot_titles:missingPlotTitles,
      duplicate_plot_titles:duplicatePlotTitles,
      previous_study_time_s:studyPrevious?numberOrNull(studyPrevious[0]):null,
      profile_code:plotValue(studyLast,${title('profile_code')}),
      prior_sma:plotValue(studyLast,${title('prior_sma')}),
      pair_eligible:plotValue(studyLast,${title('pair_eligible')}),
      fib_low:plotValue(studyLast,${title('fib_low')}),
      fib_high:plotValue(studyLast,${title('fib_high')}),
      fib_low_pivot_time_ms:plotValue(studyLast,${title('fib_low_pivot_time_ms')}),
      fib_high_pivot_time_ms:plotValue(studyLast,${title('fib_high_pivot_time_ms')}),
      fib_high_confirmation_time_ms:plotValue(studyLast,${title('fib_high_confirmation_time_ms')}),
      golden_top:plotValue(studyLast,${title('golden_top')}),
      golden_bottom:plotValue(studyLast,${title('golden_bottom')}),
      previous_profile_code:plotValue(studyPrevious,${title('profile_code')}),
      previous_prior_sma:plotValue(studyPrevious,${title('prior_sma')}),
      previous_pair_eligible:plotValue(studyPrevious,${title('pair_eligible')}),
      previous_fib_low:plotValue(studyPrevious,${title('fib_low')}),
      previous_fib_high:plotValue(studyPrevious,${title('fib_high')}),
      previous_fib_low_pivot_time_ms:plotValue(studyPrevious,${title('fib_low_pivot_time_ms')}),
      previous_fib_high_pivot_time_ms:plotValue(studyPrevious,${title('fib_high_pivot_time_ms')}),
      previous_fib_high_confirmation_time_ms:plotValue(studyPrevious,${title('fib_high_confirmation_time_ms')}),
      previous_golden_top:plotValue(studyPrevious,${title('golden_top')}),
      previous_golden_bottom:plotValue(studyPrevious,${title('golden_bottom')})
    };
  })()`;
}

function assertExactStudyContract(observed, sourceAuthority = null) {
  if (!observed?.chart_available) {
    const error = new Error('TradingView chart is unavailable.');
    error.code = 'chart_unavailable';
    throw error;
  }
  if (observed.chart_is_standard !== true) {
    const error = new Error('The attention scanner requires a standard-candles chart; synthetic chart OHLC would change MA/Fib semantics.');
    error.code = 'nonstandard_chart_unsupported';
    throw error;
  }
  if (observed.study_match_count !== 1) {
    const error = new Error(`Expected one exact V2 study, found ${observed.study_match_count ?? 0}.`);
    error.code = observed.study_match_count > 1 ? 'study_ambiguous' : 'study_unavailable';
    throw error;
  }
  if (observed.study_visible !== true) {
    const error = new Error(`The exact V2 study is hidden or its visibility cannot be proved: ${SMA_FIB_WATCH_STUDY_TITLE}`);
    error.code = 'study_hidden';
    throw error;
  }
  if (observed.study_source_hidden !== false) {
    const error = new Error(`The exact V2 study source is hidden or its visibility cannot be proved: ${SMA_FIB_WATCH_STUDY_TITLE}`);
    error.code = observed.study_source_hidden === true
      ? 'study_source_hidden'
      : 'study_source_visibility_unproved';
    throw error;
  }
  if (observed.show_golden_pocket_input_count !== 1) {
    const error = new Error('The exact V2 study must expose one Show Golden Pocket input.');
    error.code = 'study_visual_contract_mismatch';
    throw error;
  }
  if (observed.show_golden_pocket !== true) {
    const error = new Error('The exact V2 study has Show Golden Pocket disabled or its value cannot be proved.');
    error.code = 'study_golden_pocket_hidden';
    throw error;
  }
  if (observed.show_status_table_input_count !== 1) {
    const error = new Error('The exact V2 study must expose one Show Research Status Table input.');
    error.code = 'study_visual_contract_mismatch';
    throw error;
  }
  if (typeof observed.show_status_table !== 'boolean') {
    const error = new Error('The exact V2 Show Research Status Table value cannot be proved.');
    error.code = 'study_status_table_visibility_unproved';
    throw error;
  }
  if (observed.missing_plot_titles?.length) {
    const error = new Error(`The exact V2 study is missing required machine values: ${observed.missing_plot_titles.join(', ')}`);
    error.code = 'study_plot_contract_mismatch';
    throw error;
  }
  if (observed.duplicate_plot_titles?.length) {
    const error = new Error(`The exact V2 study duplicates required machine values: ${observed.duplicate_plot_titles.join(', ')}`);
    error.code = 'study_plot_contract_mismatch';
    throw error;
  }
  if (sourceAuthority) {
    if (sourceAuthority.source_title !== SMA_FIB_WATCH_STUDY_TITLE
      || sourceAuthority.source_sha256 !== SMA_FIB_SELECTED_SOURCE_SHA256
      || typeof sourceAuthority.script_id !== 'string'
      || !sourceAuthority.script_id
      || typeof sourceAuthority.script_version !== 'string'
      || !sourceAuthority.script_version) {
      throw sourceBindingError(
        'sma_fib_source_authority_invalid',
        'The supplied SMA/Fib source authority is incomplete or selects another source.',
      );
    }
    if (observed.study_observed_identity?.script_id !== sourceAuthority.script_id
      || String(observed.study_observed_identity?.script_version) !== sourceAuthority.script_version) {
      throw sourceBindingError(
        'sma_fib_applied_script_identity_mismatch',
        'The observed SMA/Fib study ID/version does not match the verified source binding.',
      );
    }
  }
}

/** Fail-fast contract check performed once before any chart route changes. */
export async function preflightSmaFibWatchStudy({ _deps } = {}) {
  const evaluate = _deps?.evaluate ?? defaultEvaluate;
  let sourceAuthority = null;
  let sourceBindingFailure = null;
  try {
    sourceAuthority = resolveSmaFibSourceAuthority(_deps);
  } catch (error) {
    sourceBindingFailure = errorRecord(error, 'sma_fib_binding_contract_invalid');
  }
  const observed = await evaluate(readExpression());
  assertExactStudyContract(observed, sourceAuthority);
  return {
    study_title: SMA_FIB_WATCH_STUDY_TITLE,
    study_match_count: 1,
    study_visible: true,
    study_source_hidden: false,
    show_golden_pocket: true,
    show_golden_pocket_input_count: 1,
    show_status_table: observed.show_status_table,
    show_status_table_input_count: 1,
    source_binding: sourceAuthority ?? {
      verified: false,
      source_title: SMA_FIB_WATCH_STUDY_TITLE,
      source_sha256: SMA_FIB_SELECTED_SOURCE_SHA256,
      failure: sourceBindingFailure,
    },
    required_plot_titles: Object.values(SMA_FIB_WATCH_PLOTS).map(plot => plot.title),
  };
}

/**
 * Resolve the two detector surfaces independently. A malformed, hidden, or
 * absent V2 study makes Fib unavailable, but it must not suppress the prior-200
 * MA that is computed directly from the standard main-series bars.
 */
export async function preflightSmaFibAttentionSources({ _deps } = {}) {
  try {
    const exact = await preflightSmaFibWatchStudy({ _deps });
    return {
      ...exact,
      study_contract_available: true,
      study_failure: null,
    };
  } catch (error) {
    if (error?.code === 'chart_unavailable'
      || error?.code === 'nonstandard_chart_unsupported') throw error;

    let sourceAuthority = null;
    let sourceBindingFailure = null;
    try {
      sourceAuthority = resolveSmaFibSourceAuthority(_deps);
    } catch (bindingError) {
      sourceBindingFailure = errorRecord(
        bindingError,
        'sma_fib_binding_contract_invalid',
      );
    }
    return {
      study_title: SMA_FIB_WATCH_STUDY_TITLE,
      study_contract_available: false,
      study_failure: errorRecord(error, 'sma_fib_study_unavailable'),
      source_binding: sourceAuthority ?? {
        verified: false,
        source_title: SMA_FIB_WATCH_STUDY_TITLE,
        source_sha256: SMA_FIB_SELECTED_SOURCE_SHA256,
        failure: sourceBindingFailure,
      },
      required_plot_titles: Object.values(SMA_FIB_WATCH_PLOTS).map(plot => plot.title),
    };
  }
}

/**
 * Switch symbols without the generic DOM-header readiness heuristic. This wait
 * proves only chart-API identity; readCurrentSmaFibRoute proves study readiness.
 */
export async function setSmaFibRouteSymbol({
  symbol,
  timeoutMs = DEFAULT_SYMBOL_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  _deps,
} = {}) {
  if (!qualifiedSymbolParts(symbol)) {
    throw new TypeError('symbol must be an exchange-qualified TradingView symbol ID.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be positive.');
  }
  const evaluate = _deps?.evaluate ?? defaultEvaluate;
  const pause = _deps?.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  await evaluate(`(function(){/* sma-fib-watchlist-scan:switch-symbol-v1 */
    var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!w)throw new Error('TradingView chart is unavailable.');w.setSymbol(${JSON.stringify(symbol.trim())},{});return true;
  })()`);

  const maximumPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let latest = null;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await evaluate(`(function(){/* sma-fib-watchlist-scan:read-symbol-identity-v1 */
      var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
      if(!w)return {chart_available:false};var main=w._chartWidget.model().mainSeries();var info=main.symbolInfo()||{};
      return {chart_available:true,chart_symbol:info.full_name||w.symbol(),symbol_identity:{full_name:info.full_name||null,pro_name:info.pro_name||null,base_name:info.base_name||[],name:info.name||null,exchange:info.exchange||null}};
    })()`);
    const identityResolution = latest?.chart_available
      ? resolveSymbolIdentity(symbol, latest)
      : null;
    if (identityResolution) {
      return {
        success: true,
        ...identityResolution,
        identity_poll_count: attempt + 1,
      };
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  const error = new Error(`Timed out waiting for chart identity ${symbol}: ${JSON.stringify(latest)}`);
  error.code = 'symbol_identity_settle_timeout';
  throw error;
}

/** Capture the route generation immediately before a symbol/timeframe change. */
export async function captureSmaFibRouteMarker({
  timeoutMs = 5_000,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  _deps,
} = {}) {
  const evaluate = _deps?.evaluate ?? defaultEvaluate;
  const pause = _deps?.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const sourceAuthority = _deps?.sourceAuthority ?? null;
  const allowMainOnly = _deps?.allowMainOnly === true;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be positive.');
  }
  const maximumPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let latest = null;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await evaluate(readExpression());
    if (!allowMainOnly) {
      try {
        assertExactStudyContract(latest, sourceAuthority);
      } catch (error) {
        const transient = error.code === 'study_unavailable'
          || error.code === 'chart_unavailable'
          || (error.code === 'study_hidden' && latest?.study_visible === null);
        if (!transient) throw error;
        if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
        continue;
      }
    } else if (!latest?.chart_available
      || latest.chart_is_standard !== true
      || latest.main_loading !== false
      || !qualifiedSymbolParts(latest.chart_symbol)
      || !normalizeTimeframe(latest.timeframe)) {
      if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
      continue;
    }
    if (allowMainOnly || (qualifiedSymbolParts(latest.study_source_symbol)
      && normalizeTimeframe(latest.study_source_timeframe))) {
      return {
        chart_symbol: latest.chart_symbol,
        chart_symbol_readback: latest.chart_symbol_readback,
        symbol_identity: latest.symbol_identity,
        timeframe: latest.timeframe,
        study_source_symbol: allowMainOnly ? null : latest.study_source_symbol,
        study_source_timeframe: allowMainOnly ? null : latest.study_source_timeframe,
        study_turnaround: stableValue(latest.study_turnaround),
        marker_mode: allowMainOnly ? 'main_series' : 'exact_v2_study',
      };
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  const error = new Error(allowMainOnly
    ? 'Could not capture a settled main-series identity before changing the chart route.'
    : 'Could not capture the V2 study source identity before changing the chart route.');
  error.code = allowMainOnly
    ? 'main_route_marker_unavailable'
    : 'route_marker_unavailable';
  throw error;
}

/**
 * Read the authoritative chart route and viewport used for interference
 * fencing. The viewport fields are deliberately captured in the same page
 * evaluation as the route so restoration is never authorized by a torn read.
 */
export async function readSmaFibChartControlRoute({ evaluate = defaultEvaluate } = {}) {
  const state = await evaluate(`(function(){/* sma-fib-watchlist-scan:control-state-v2 */
    var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!w)return null;var main=w._chartWidget&&w._chartWidget.model&&w._chartWidget.model().mainSeries();var info=main&&main.symbolInfo?main.symbolInfo()||{}:{};
    var range=w.getVisibleRange&&w.getVisibleRange();var timeScale=w.getTimeScale&&w.getTimeScale();
    return {symbol:info.full_name||w.symbol(),timeframe:String(w.resolution()),chart_type:Number(w.chartType()),visible_range:range?{from:Number(range.from),to:Number(range.to)}:null,time_scale:timeScale?{bar_spacing:Number(timeScale.barSpacing()),right_offset:Number(timeScale.rightOffset()),width:Number(timeScale.width())}:null};
  })()`);
  if (typeof state?.symbol !== 'string' || !state.symbol.trim()
    || typeof state?.timeframe !== 'string' || !state.timeframe.trim()) {
    const error = new Error('TradingView chart route is unavailable for chart-control verification.');
    error.code = 'chart_control_route_unavailable';
    throw error;
  }
  try {
    validateChartControlViewport(state);
  } catch (cause) {
    const error = new Error(`TradingView chart viewport is unavailable for chart-control verification: ${cause.message}`);
    error.code = 'chart_control_viewport_unavailable';
    throw error;
  }
  return {
    symbol: normalizeSymbol(state.symbol),
    timeframe: String(state.timeframe),
    chart_type: Number(state.chart_type),
    visible_range: {
      from: Number(state.visible_range.from),
      to: Number(state.visible_range.to),
    },
    time_scale: {
      bar_spacing: Number(state.time_scale.bar_spacing),
      right_offset: Number(state.time_scale.right_offset),
      width: Number(state.time_scale.width),
    },
  };
}

function chartControlRouteMatches(expected, observed) {
  if (typeof expected?.symbol !== 'string' || typeof expected?.timeframe !== 'string') return false;
  const observedSymbol = observed?.symbol ?? observed?.chart_symbol;
  const symbolMatches = symbolIdentityMatches(expected.symbol, {
    chart_symbol: observedSymbol,
  }) || normalizeSymbol(expected.symbol) === normalizeSymbol(observedSymbol);
  return symbolMatches
    && normalizeTimeframe(observed?.timeframe) === normalizeTimeframe(expected.timeframe);
}

function validateChartControlViewport(state) {
  if (!Number.isSafeInteger(state?.chart_type)
    || state.chart_type < 0
    || state.chart_type > 9) {
    throw new Error('chart type is missing or invalid.');
  }
  if (!finite(state?.visible_range?.from)
    || !finite(state?.visible_range?.to)
    || state.visible_range.from >= state.visible_range.to) {
    throw new Error('visible range is missing or invalid.');
  }
  validateTimeScaleGeometry(state.time_scale);
}

function chartControlViewportMismatches(expected, observed) {
  try {
    validateChartControlViewport(expected);
    validateChartControlViewport(observed);
  } catch (error) {
    return [error.message];
  }
  const mismatches = [];
  if (expected.chart_type !== observed.chart_type) {
    mismatches.push(`chart type ${observed.chart_type} != ${expected.chart_type}`);
  }
  const rangeTolerance = 1;
  if (Math.abs(expected.visible_range.from - observed.visible_range.from) > rangeTolerance
    || Math.abs(expected.visible_range.to - observed.visible_range.to) > rangeTolerance) {
    mismatches.push(
      `visible range ${JSON.stringify(observed.visible_range)} != ${JSON.stringify(expected.visible_range)}`,
    );
  }
  for (const key of ['bar_spacing', 'right_offset', 'width']) {
    if (observed.time_scale[key] !== expected.time_scale[key]) {
      mismatches.push(
        `time-scale ${key} ${observed.time_scale[key]} != ${expected.time_scale[key]}`,
      );
    }
  }
  return mismatches;
}

function chartControlLeaseRoute(state) {
  return {
    symbol: normalizeSymbol(state.symbol),
    timeframe: String(state.timeframe),
  };
}

export class ChartControlInterferenceError extends Error {
  constructor(message, {
    phase,
    expected,
    observed = null,
    verificationError = null,
  } = {}) {
    super(message);
    this.name = 'ChartControlInterferenceError';
    this.code = 'chart_control_interference';
    this.phase = phase ?? null;
    this.expected_route = expected?.symbol && expected?.timeframe
      ? chartControlLeaseRoute(expected)
      : null;
    this.observed_route = observed?.symbol && observed?.timeframe
      ? chartControlLeaseRoute(observed)
      : null;
    const sameRoute = expected && observed && chartControlRouteMatches(expected, observed);
    const viewportMismatches = expected && observed
      ? chartControlViewportMismatches(expected, observed)
      : [];
    if (sameRoute && viewportMismatches.length) {
      this.interference_kind = 'viewport';
      this.viewport_mismatches = viewportMismatches;
      this.expected_viewport = {
        visible_range: expected.visible_range ?? null,
        time_scale: expected.time_scale ?? null,
      };
      this.observed_viewport = {
        visible_range: observed.visible_range ?? null,
        time_scale: observed.time_scale ?? null,
      };
    } else {
      this.interference_kind = 'route_or_unverifiable_state';
    }
    if (verificationError) this.verification_error = errorRecord(verificationError);
  }
}

async function readProvableChartControlState(dependencies, lease) {
  lease?.assertOwned?.();
  const observed = await dependencies.readChartControlRoute();
  if (typeof observed?.symbol !== 'string' || !observed.symbol.trim()
    || typeof observed?.timeframe !== 'string' || !observed.timeframe.trim()) {
    const error = new Error('TradingView chart route is unavailable for chart-control verification.');
    error.code = 'chart_control_route_unavailable';
    throw error;
  }
  try {
    validateChartControlViewport(observed);
  } catch (cause) {
    const error = new Error(`TradingView chart viewport is unavailable for chart-control verification: ${cause.message}`);
    error.code = 'chart_control_viewport_unavailable';
    throw error;
  }
  return {
    symbol: normalizeSymbol(observed.symbol),
    timeframe: String(observed.timeframe),
    chart_type: Number(observed.chart_type),
    visible_range: {
      from: Number(observed.visible_range.from),
      to: Number(observed.visible_range.to),
    },
    time_scale: {
      bar_spacing: Number(observed.time_scale.bar_spacing),
      right_offset: Number(observed.time_scale.right_offset),
      width: Number(observed.time_scale.width),
    },
  };
}

async function verifyScannerOwnedChartRoute(dependencies, lease, expected, phase) {
  try {
    validateChartControlViewport(expected);
  } catch (error) {
    throw new ChartControlInterferenceError(
      `Scanner has no provable owned viewport before ${phase}; stale restoration is unsafe.`,
      { phase, expected, verificationError: error },
    );
  }
  lease?.assertOwned?.();
  let observed;
  try {
    observed = await readProvableChartControlState(dependencies, lease);
  } catch (error) {
    throw new ChartControlInterferenceError(
      `Scanner could not verify chart ownership before ${phase}; stale restoration is unsafe.`,
      { phase, expected, verificationError: error },
    );
  }
  if (!chartControlRouteMatches(expected, observed)) {
    throw new ChartControlInterferenceError(
      `TradingView chart route changed outside this scanner before ${phase}.`,
      { phase, expected, observed },
    );
  }
  const viewportMismatches = chartControlViewportMismatches(expected, observed);
  if (viewportMismatches.length) {
    throw new ChartControlInterferenceError(
      `TradingView chart viewport changed outside this scanner before ${phase}.`,
      { phase, expected, observed },
    );
  }
  return observed;
}

async function runGuardedChartMutation({
  dependencies,
  lease,
  expected,
  intended,
  phase,
  mutate,
}) {
  await verifyScannerOwnedChartRoute(dependencies, lease, expected, phase);
  let mutationError = null;
  try {
    await mutate();
  } catch (error) {
    mutationError = error;
  }
  if (!mutationError) {
    let observed;
    try {
      observed = await readProvableChartControlState(dependencies, lease);
    } catch (verificationError) {
      throw new ChartControlInterferenceError(
        `Scanner could not prove chart state after ${phase}; stale restoration is unsafe.`,
        { phase, expected: intended, verificationError },
      );
    }
    if (!chartControlRouteMatches(intended, observed)) {
      throw new ChartControlInterferenceError(
        `TradingView chart did not reach the scanner-owned route after ${phase}.`,
        { phase, expected: intended, observed },
      );
    }
    lease?.update?.({ phase, last_owned_chart_route: chartControlLeaseRoute(observed) });
    return { state: observed, error: null };
  }
  // A setter can time out after TradingView already accepted the requested
  // route. Adopt only the old or intended route; any third route belongs to
  // another actor and must fence restoration.
  let observed;
  try {
    lease?.assertOwned?.();
    observed = await readProvableChartControlState(dependencies, lease);
  } catch (verificationError) {
    throw new ChartControlInterferenceError(
      `Scanner lost a provable chart route after ${phase} failed.`,
      { phase, expected, verificationError },
    );
  }
  if (chartControlRouteMatches(expected, observed)) {
    const viewportMismatches = chartControlViewportMismatches(expected, observed);
    if (viewportMismatches.length) {
      throw new ChartControlInterferenceError(
        `TradingView chart viewport changed while ${phase} failed.`,
        { phase, expected, observed },
      );
    }
    return { state: observed, error: mutationError };
  }
  if (chartControlRouteMatches(intended, observed)) {
    lease?.update?.({
      phase: `${phase}_accepted_before_error`,
      last_owned_chart_route: chartControlLeaseRoute(observed),
    });
    return { state: observed, error: mutationError };
  }
  throw new ChartControlInterferenceError(
    `TradingView chart moved to an unowned route while ${phase} failed.`,
    { phase, expected, observed },
  );
}

function sourceIdentityTransitioned(previousRouteMarker, reading) {
  const previousSource = qualifiedSymbolParts(previousRouteMarker?.study_source_symbol);
  const currentSource = qualifiedSymbolParts(reading?.study_source_symbol);
  const previousTimeframe = normalizeTimeframe(previousRouteMarker?.study_source_timeframe);
  const currentTimeframe = normalizeTimeframe(reading?.study_source_timeframe);
  if (!previousSource || !currentSource || !previousTimeframe || !currentTimeframe) return false;
  return previousSource.full !== currentSource.full || previousTimeframe !== currentTimeframe;
}

function mainRouteIdentityTransitioned(previousRouteMarker, reading) {
  const previousSymbol = qualifiedSymbolParts(
    previousRouteMarker?.chart_symbol ?? previousRouteMarker?.symbol_identity?.full_name,
  );
  const currentSymbol = qualifiedSymbolParts(
    reading?.chart_symbol ?? reading?.symbol_identity?.full_name,
  );
  const previousTimeframe = normalizeTimeframe(previousRouteMarker?.timeframe);
  const currentTimeframe = normalizeTimeframe(reading?.timeframe);
  if (!previousSymbol || !currentSymbol || !previousTimeframe || !currentTimeframe) return false;
  return previousSymbol.full !== currentSymbol.full || previousTimeframe !== currentTimeframe;
}

function settledRouteSignature(reading, { mainOnly = false } = {}) {
  if (mainOnly) {
    return JSON.stringify({
      chart_symbol: normalizeSymbol(reading.chart_symbol),
      timeframe: normalizeTimeframe(reading.timeframe),
      main_last_time_s: reading.main_last_time_s,
      current_bar_closed: reading.current_bar_closed,
      attention_prior_sma: reading.attention_prior_sma,
      previous_main_time_s: reading.previous_main_time_s,
      previous_attention_prior_sma: reading.previous_attention_prior_sma,
    });
  }
  return JSON.stringify({
    chart_symbol: normalizeSymbol(reading.chart_symbol),
    timeframe: normalizeTimeframe(reading.timeframe),
    study_source_symbol: normalizeSymbol(reading.study_source_symbol),
    study_source_timeframe: normalizeTimeframe(reading.study_source_timeframe),
    study_observed_identity: reading.study_observed_identity,
    study_turnaround: stableValue(reading.study_turnaround),
    main_last_time_s: reading.main_last_time_s,
    study_last_time_s: reading.study_last_time_s,
    current_bar_closed: reading.current_bar_closed,
    attention_prior_sma: reading.attention_prior_sma,
    previous_attention_prior_sma: reading.previous_attention_prior_sma,
    profile_code: reading.profile_code,
    prior_sma: reading.prior_sma,
    pair_eligible: reading.pair_eligible,
    fib_low: reading.fib_low,
    fib_high: reading.fib_high,
    fib_low_pivot_time_ms: reading.fib_low_pivot_time_ms,
    fib_high_pivot_time_ms: reading.fib_high_pivot_time_ms,
    fib_high_confirmation_time_ms: reading.fib_high_confirmation_time_ms,
    golden_top: reading.golden_top,
    golden_bottom: reading.golden_bottom,
  });
}

/** Poll until the main series and the exact visible V2 study share one latest bar. */
export async function readCurrentSmaFibRoute({
  requestedSymbol,
  timeframe,
  previousRouteMarker = null,
  requireSourceTransition = false,
  timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  _deps,
} = {}) {
  const evaluate = _deps?.evaluate ?? defaultEvaluate;
  const pause = _deps?.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const sourceAuthority = _deps?.sourceAuthority ?? null;
  const allowMainOnly = _deps?.allowMainOnly === true;
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const profile = PROFILE_BY_TIMEFRAME[normalizedTimeframe];
  if (!profile) throw new TypeError(`Unsupported timeframe: ${timeframe}`);
  if (typeof requestedSymbol !== 'string' || !requestedSymbol.trim()) {
    throw new TypeError('requestedSymbol must be a non-empty string.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be positive.');
  }
  const previousTurnaround = stableValue(previousRouteMarker?.study_turnaround);
  if (requireSourceTransition
    && (allowMainOnly
      ? (!qualifiedSymbolParts(previousRouteMarker?.chart_symbol)
        || !normalizeTimeframe(previousRouteMarker?.timeframe))
      : (!qualifiedSymbolParts(previousRouteMarker?.study_source_symbol)
        || !normalizeTimeframe(previousRouteMarker?.study_source_timeframe)))) {
    const error = new Error(`A pre-change ${allowMainOnly ? 'main-series' : 'study-source'} identity is required when the chart route changes.`);
    error.code = 'route_marker_unavailable';
    throw error;
  }

  const maximumPolls = Math.max(2, Math.ceil(timeoutMs / pollIntervalMs));
  let latest = null;
  let stableSignature = null;
  let stablePolls = 0;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await evaluate(readExpression());
    if (!allowMainOnly) {
      try {
        assertExactStudyContract(latest, sourceAuthority);
      } catch (error) {
        const transient = error.code === 'study_unavailable'
          || error.code === 'chart_unavailable'
          || (error.code === 'study_hidden' && latest?.study_visible === null);
        if (!transient) throw error;
        stableSignature = null;
        stablePolls = 0;
        if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
        continue;
      }
    } else if (latest?.chart_is_standard !== true) {
      const error = new Error('The attention scanner requires a standard-candles chart.');
      error.code = 'nonstandard_chart_unsupported';
      throw error;
    }
    const turnaroundChanged = stableValue(latest.study_turnaround) !== previousTurnaround;
    const sourceTransitionObserved = !requireSourceTransition
      || (allowMainOnly
        ? mainRouteIdentityTransitioned(previousRouteMarker, latest)
        : sourceIdentityTransitioned(previousRouteMarker, latest));
    const identityResolution = resolveSymbolIdentity(requestedSymbol, latest);
    const studySource = qualifiedSymbolParts(latest.study_source_symbol);
    const studySourceMatchesResolved = identityResolution !== null
      && studySource?.full === identityResolution.resolved_symbol;
    const mainSettled = normalizeTimeframe(latest.timeframe) === normalizedTimeframe
      && identityResolution !== null
      && latest.chart_is_standard === true
      && latest.main_loading === false
      && latest.bar_close_signal_valid === true
      && typeof latest.current_bar_closed === 'boolean'
      && sourceTransitionObserved
      && finite(latest.main_last_time_s);
    const studySettled = studySourceMatchesResolved
      && normalizeTimeframe(latest.study_source_timeframe) === normalizedTimeframe
      && latest.study_loading === false
      && latest.study_restarting === false
      && latest.study_match_count === 1
      && latest.study_visible === true
      && latest.study_complete === true
      && latest.main_last_time_s === latest.study_last_time_s
      && latest.profile_code === profile.code;
    const settled = mainSettled && (allowMainOnly || studySettled);
    if (settled) {
      const signature = settledRouteSignature(latest, { mainOnly: allowMainOnly });
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      if (stablePolls >= 2) {
        return {
          requested_symbol: requestedSymbol.trim(),
          ...latest,
          resolved_symbol: identityResolution.resolved_symbol,
          match_mode: identityResolution.match_mode,
          timeframe: normalizedTimeframe,
          current_bar_time_s: latest.main_last_time_s,
          pair_eligible: latest.pair_eligible === 1,
          settled_poll_count: stablePolls,
          turnaround_changed: turnaroundChanged,
          source_transition_observed: sourceTransitionObserved,
          route_data_mode: allowMainOnly ? 'main_series_only' : 'main_series_plus_exact_v2',
          fib_machine_available: !allowMainOnly,
          ...(allowMainOnly ? {
            pair_eligible: false,
            fib_low: null,
            fib_high: null,
            fib_low_pivot_time_ms: null,
            fib_high_pivot_time_ms: null,
            fib_high_confirmation_time_ms: null,
            golden_top: null,
            golden_bottom: null,
            previous_pair_eligible: null,
            previous_fib_low: null,
            previous_fib_high: null,
            previous_fib_low_pivot_time_ms: null,
            previous_fib_high_pivot_time_ms: null,
            previous_fib_high_confirmation_time_ms: null,
            previous_golden_top: null,
            previous_golden_bottom: null,
          } : {}),
        };
      }
    } else {
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }

  const settleTarget = allowMainOnly
    ? 'settled main-series route'
    : 'exact settled V2 route';
  const error = new Error(`Timed out waiting for the ${settleTarget}: ${JSON.stringify({
    requested_symbol: requestedSymbol,
    timeframe: normalizedTimeframe,
    chart_symbol: latest?.chart_symbol,
    chart_timeframe: latest?.timeframe,
    study_match_count: latest?.study_match_count,
    study_visible: latest?.study_visible,
    main_loading: latest?.main_loading,
    study_loading: latest?.study_loading,
    study_restarting: latest?.study_restarting,
    study_source_symbol: latest?.study_source_symbol,
    study_source_timeframe: latest?.study_source_timeframe,
    resolved_symbol: resolveSymbolIdentity(requestedSymbol, latest)?.resolved_symbol,
    match_mode: resolveSymbolIdentity(requestedSymbol, latest)?.match_mode,
    study_turnaround: latest?.study_turnaround,
    previous_study_turnaround: previousTurnaround,
    previous_study_source_symbol: previousRouteMarker?.study_source_symbol,
    previous_study_source_timeframe: previousRouteMarker?.study_source_timeframe,
    source_transition_observed: latest
      ? (allowMainOnly
        ? mainRouteIdentityTransitioned(previousRouteMarker, latest)
        : sourceIdentityTransitioned(previousRouteMarker, latest))
      : false,
    main_last_time_s: latest?.main_last_time_s,
    study_last_time_s: latest?.study_last_time_s,
    bar_close_signal_valid: latest?.bar_close_signal_valid,
    current_bar_closed: latest?.current_bar_closed,
    attention_prior_sma: latest?.attention_prior_sma,
    profile_code: latest?.profile_code,
  })}`);
  const finalIdentityResolution = resolveSymbolIdentity(requestedSymbol, latest);
  const finalStudySource = qualifiedSymbolParts(latest?.study_source_symbol);
  error.code = allowMainOnly
    ? finalIdentityResolution === null
      ? 'symbol_identity_mismatch'
      : requireSourceTransition && !mainRouteIdentityTransitioned(previousRouteMarker, latest)
        ? 'main_route_transition_unproved'
        : 'main_route_settle_timeout'
    : latest?.study_match_count === 0
      ? 'study_unavailable'
      : finalIdentityResolution === null
        ? 'symbol_identity_mismatch'
        : finalStudySource?.full !== finalIdentityResolution.resolved_symbol
          ? 'study_source_identity_mismatch'
          : requireSourceTransition && !sourceIdentityTransitioned(previousRouteMarker, latest)
            ? 'source_identity_transition_unproved'
            : 'route_settle_timeout';
  throw error;
}

/** Synchronously repaint through the live-proven chart-widget compositor API. */
export async function paintRestoredSmaFibCanvas({ evaluate = defaultEvaluate } = {}) {
  let result;
  try {
    result = await evaluate(`(function(){/* sma-fib-watchlist-scan:update-and-paint-v1 */
      var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
      if(!w)throw new Error('TradingView chart is unavailable.');var chartWidget=w._chartWidget;
      if(!chartWidget||typeof chartWidget._updateAndPaint!=='function')throw new Error('TradingView update-and-paint API is unavailable.');
      chartWidget._updateAndPaint();return {method:'chartWidget._updateAndPaint'};
    })()`);
  } catch (error) {
    if (!error.code) error.code = 'study_canvas_repaint_failed';
    throw error;
  }
  if (result?.method !== 'chartWidget._updateAndPaint') {
    const error = new Error('TradingView did not confirm the synchronous canvas update-and-paint request.');
    error.code = 'study_canvas_repaint_unproved';
    throw error;
  }
  return { success: true, ...result };
}

/**
 * Wait for exact V2 machine data and table primitives. The caller paints only
 * after range and time-scale restoration are also stable.
 */
export async function settleRestoredSmaFibStudyGraphics({
  symbol,
  timeframe,
  timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  _deps,
} = {}) {
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const profile = PROFILE_BY_TIMEFRAME[normalizedTimeframe]
    ?? { code: 0, label: 'Use 1D / 1W' };
  if (!qualifiedSymbolParts(symbol)) {
    throw new TypeError('symbol must be an exchange-qualified TradingView symbol ID.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be positive.');
  }
  const evaluate = _deps?.evaluate ?? defaultEvaluate;
  const pause = _deps?.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const sourceAuthority = _deps?.sourceAuthority ?? null;
  const expectedTableProfile = profile.label;
  const maximumPolls = Math.max(2, Math.ceil(timeoutMs / pollIntervalMs));
  let latest = null;
  let stableSignature = null;
  let stablePolls = 0;

  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await evaluate(readExpression());
    try {
      assertExactStudyContract(latest, sourceAuthority);
    } catch (error) {
      const transient = error.code === 'study_unavailable'
        || error.code === 'chart_unavailable'
        || (error.code === 'study_hidden' && latest?.study_visible === null);
      if (!transient) throw error;
      stableSignature = null;
      stablePolls = 0;
      if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
      continue;
    }
    const identityResolution = resolveSymbolIdentity(symbol, latest);
    const studySource = qualifiedSymbolParts(latest.study_source_symbol);
    const tableCells = Array.isArray(latest.status_table_cells)
      ? latest.status_table_cells
      : [];
    const tableHeaderCell = tableCells.find(cell => cell?.row === 0 && cell?.col === 0);
    const tableProfileCell = tableCells.find(cell => cell?.row === 0 && cell?.col === 1);
    const tableSettled = latest.show_status_table === true
      ? latest.status_table_collection_accessible === true
        && tableHeaderCell?.text === 'SMA/Fib Research'
        && tableProfileCell?.text === expectedTableProfile
      : latest.show_status_table === false
        ? latest.status_table_collection_accessible === true
          && tableCells.every(cell => cell?.text === '')
        : false;
    const settled = identityResolution !== null
      && studySource?.full === identityResolution.resolved_symbol
      && normalizeTimeframe(latest.timeframe) === normalizedTimeframe
      && normalizeTimeframe(latest.study_source_timeframe) === normalizedTimeframe
      && latest.main_loading === false
      && latest.study_loading === false
      && latest.study_restarting === false
      && latest.study_complete === true
      && latest.graphics_views_ready === true
      && tableSettled
      && finite(latest.main_last_time_s)
      && latest.main_last_time_s === latest.study_last_time_s
      && latest.profile_code === profile.code;
    if (settled) {
      const signature = JSON.stringify({
        resolved_symbol: identityResolution.resolved_symbol,
        timeframe: normalizedTimeframe,
        study_source_symbol: studySource.full,
        study_source_timeframe: normalizeTimeframe(latest.study_source_timeframe),
        main_last_time_s: latest.main_last_time_s,
        study_last_time_s: latest.study_last_time_s,
        profile_code: latest.profile_code,
        prior_sma: latest.prior_sma,
        pair_eligible: latest.pair_eligible,
        fib_low: latest.fib_low,
        fib_high: latest.fib_high,
        fib_low_pivot_time_ms: latest.fib_low_pivot_time_ms,
        fib_high_pivot_time_ms: latest.fib_high_pivot_time_ms,
        fib_high_confirmation_time_ms: latest.fib_high_confirmation_time_ms,
        golden_top: latest.golden_top,
        golden_bottom: latest.golden_bottom,
        graphics_views_ready: latest.graphics_views_ready,
        show_status_table: latest.show_status_table,
        status_table_collection_accessible: latest.status_table_collection_accessible,
        status_table_cells: latest.status_table_cells,
      });
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      if (stablePolls >= 2) {
        return {
          success: true,
          requested_symbol: normalizeSymbol(symbol),
          resolved_symbol: identityResolution.resolved_symbol,
          timeframe: normalizedTimeframe,
          profile: expectedTableProfile,
          prior_sma: latest.prior_sma,
          graphics_views_ready: true,
          status_table_visible: latest.show_status_table,
          stable_poll_count: stablePolls,
          state_signature: stableSignature,
        };
      }
    } else {
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }

  const error = new Error(`Restored V2 machine/graphics state did not settle before repaint: ${JSON.stringify({
    requested_symbol: symbol,
    timeframe: normalizedTimeframe,
    chart_symbol: latest?.chart_symbol,
    study_source_symbol: latest?.study_source_symbol,
    study_source_timeframe: latest?.study_source_timeframe,
    profile_code: latest?.profile_code,
    prior_sma: latest?.prior_sma,
    graphics_views_ready: latest?.graphics_views_ready,
    show_status_table: latest?.show_status_table,
    status_table_collection_accessible: latest?.status_table_collection_accessible,
    status_table_cells: latest?.status_table_cells,
  })}`);
  error.code = 'restored_study_visual_settle_timeout';
  throw error;
}

export async function captureSmaFibChartSnapshot({ evaluate = defaultEvaluate } = {}) {
  const snapshot = await evaluate(`(function(){/* sma-fib-watchlist-scan:snapshot-v1 */
    var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!w)return null;var range=w.getVisibleRange();var timeScale=w.getTimeScale();var main=w._chartWidget.model().mainSeries();var bars=main.bars();var last=bars&&bars.size()?bars.valueAt(bars.lastIndex()):null;
    return {symbol:w.symbol(),timeframe:String(w.resolution()),chart_type:Number(w.chartType()),visible_range:{from:Number(range.from),to:Number(range.to)},time_scale:{bar_spacing:Number(timeScale.barSpacing()),right_offset:Number(timeScale.rightOffset()),width:Number(timeScale.width())},main_loading:!!main.isLoading(),main_bar_count:bars?bars.size():0,main_last_time_s:last&&Number.isFinite(last[0])?last[0]:null};
  })()`);
  validateChartSnapshot(snapshot);
  return snapshot;
}

function validateTimeScaleGeometry(timeScale) {
  if (!positiveFinite(timeScale?.bar_spacing)
    || !finite(timeScale?.right_offset)
    || !positiveFinite(timeScale?.width)) {
    throw new Error('Chart snapshot has no valid time-scale geometry.');
  }
}

function validateChartSnapshot(snapshot) {
  if (typeof snapshot?.symbol !== 'string' || !snapshot.symbol.trim()) {
    throw new Error('Chart snapshot has no symbol.');
  }
  if (typeof snapshot?.timeframe !== 'string' || !snapshot.timeframe.trim()) {
    throw new Error('Chart snapshot has no timeframe.');
  }
  if (!Number.isSafeInteger(snapshot?.chart_type)
    || snapshot.chart_type < 0
    || snapshot.chart_type > 9) {
    throw new Error('Chart snapshot has no valid chart type.');
  }
  if (!finite(snapshot?.visible_range?.from)
    || !finite(snapshot?.visible_range?.to)
    || snapshot.visible_range.from >= snapshot.visible_range.to) {
    throw new Error('Chart snapshot has no valid visible range.');
  }
  validateTimeScaleGeometry(snapshot.time_scale);
}

/** Restore the exact horizontal chart geometry after visible-range paging. */
export async function restoreSmaFibTimeScaleGeometry(timeScale, {
  evaluate = defaultEvaluate,
} = {}) {
  validateTimeScaleGeometry(timeScale);
  const barSpacing = Number(timeScale.bar_spacing);
  const rightOffset = Number(timeScale.right_offset);
  return evaluate(`(function(){/* sma-fib-watchlist-scan:restore-geometry-v1 */
    var w=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!w)throw new Error('TradingView chart is unavailable.');var timeScale=w.getTimeScale();
    timeScale.setBarSpacing(${barSpacing});timeScale.setRightOffset(${rightOffset});
    return {bar_spacing:Number(timeScale.barSpacing()),right_offset:Number(timeScale.rightOffset()),width:Number(timeScale.width())};
  })()`);
}

export async function restoreSmaFibChartSnapshot(snapshot, {
  evaluate = defaultEvaluate,
  sourceAuthority = null,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  setSymbol = ({ symbol }) => setSmaFibRouteSymbol({
    symbol,
    _deps: { evaluate, pause },
  }),
  setTimeframe = defaultSetTimeframe,
  setVisibleRange = defaultSetVisibleRange,
  setTimeScaleGeometry = timeScale => restoreSmaFibTimeScaleGeometry(timeScale, { evaluate }),
  snapshotChartState = () => captureSmaFibChartSnapshot({ evaluate }),
  settleStudyGraphics = ({ symbol, timeframe }) => settleRestoredSmaFibStudyGraphics({
    symbol,
    timeframe,
    timeoutMs,
    pollIntervalMs,
    _deps: { evaluate, pause, sourceAuthority },
  }),
  paintCanvas = () => paintRestoredSmaFibCanvas({ evaluate }),
  requireStudyGraphics = true,
  timeoutMs = DEFAULT_RESTORE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  validateChartSnapshot(snapshot);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be positive.');
  }
  const failures = [];
  const operationReadiness = {};
  // Restore the baseline symbol first. The baseline timeframe may be
  // unsupported on the final scanned symbol even though it is valid for the
  // chart we are returning to.
  try { operationReadiness.symbol = await setSymbol({ symbol: snapshot.symbol }); } catch (error) { failures.push(`symbol: ${error.message}`); }
  try { operationReadiness.timeframe = await setTimeframe({ timeframe: snapshot.timeframe }); } catch (error) { failures.push(`timeframe: ${error.message}`); }
  if (failures.length) throw new Error(`Chart restoration failed (${failures.join('; ')}).`);

  const maximumPolls = Math.max(2, Math.ceil(timeoutMs / pollIntervalMs));
  let latest = null;
  let stableSignature = null;
  let stablePolls = 0;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await snapshotChartState();
    const routeSettled = normalizeSymbol(latest?.symbol) === normalizeSymbol(snapshot.symbol)
      && String(latest?.timeframe) === String(snapshot.timeframe)
      && latest?.main_loading === false
      && Number.isSafeInteger(latest?.main_bar_count)
      && latest.main_bar_count > 0
      && finite(latest?.main_last_time_s);
    if (routeSettled) {
      const signature = JSON.stringify({
        symbol: normalizeSymbol(latest.symbol),
        timeframe: String(latest.timeframe),
        main_bar_count: latest.main_bar_count,
        main_last_time_s: latest.main_last_time_s,
      });
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      if (stablePolls >= 2) break;
    } else {
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  if (stablePolls < 2) {
    const error = new Error(`Baseline chart route/history did not settle before range restoration: ${JSON.stringify(latest)}`);
    error.code = 'chart_restoration_route_settle_timeout';
    throw error;
  }
  operationReadiness.baseline_route = {
    success: true,
    stable_poll_count: stablePolls,
    observed: latest,
  };

  try {
    operationReadiness.visible_range = await setVisibleRange({
      from: snapshot.visible_range.from,
      to: snapshot.visible_range.to,
    });
  } catch (error) {
    failures.push(`visible range: ${error.message}`);
  }
  if (failures.length) throw new Error(`Chart restoration failed (${failures.join('; ')}).`);
  try {
    operationReadiness.time_scale = await setTimeScaleGeometry(snapshot.time_scale);
  } catch (error) {
    failures.push(`time-scale geometry: ${error.message}`);
  }
  if (failures.length) throw new Error(`Chart restoration failed (${failures.join('; ')}).`);

  latest = null;
  stableSignature = null;
  stablePolls = 0;
  let geometryReapplications = 0;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await snapshotChartState();
    const geometryOverwritten = latest?.main_loading === false
      && (latest?.time_scale?.bar_spacing !== snapshot.time_scale.bar_spacing
        || latest?.time_scale?.right_offset !== snapshot.time_scale.right_offset);
    if (geometryOverwritten) {
      try {
        await setTimeScaleGeometry(snapshot.time_scale);
        geometryReapplications += 1;
      } catch (error) {
        const reapplyError = new Error(`Time-scale geometry reapplication failed: ${error.message}`);
        reapplyError.code = 'chart_restoration_geometry_reapply_failed';
        throw reapplyError;
      }
      stableSignature = null;
      stablePolls = 0;
      if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
      continue;
    }
    const mismatches = chartSnapshotMismatches(snapshot, latest);
    const settled = latest?.main_loading === false && mismatches.length === 0;
    if (settled) {
      const signature = JSON.stringify({
        symbol: normalizeSymbol(latest.symbol),
        timeframe: String(latest.timeframe),
        visible_range: latest.visible_range,
        time_scale: latest.time_scale,
        main_bar_count: latest.main_bar_count,
        main_last_time_s: latest.main_last_time_s,
      });
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      if (stablePolls >= 2) break;
    } else {
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  if (stablePolls < 2) {
    const error = new Error(`Chart restoration did not reach two stable, non-loading pre-paint snapshots: ${JSON.stringify(latest)}`);
    error.code = 'chart_restoration_settle_timeout';
    throw error;
  }
  operationReadiness.prepaint_state = {
    success: true,
    stable_poll_count: stablePolls,
    observed: latest,
  };

  if (requireStudyGraphics) {
    operationReadiness.study_graphics = await settleStudyGraphics({
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
    });

    try {
      operationReadiness.canvas_paint = await paintCanvas();
    } catch (error) {
      if (!error.code) error.code = 'study_canvas_repaint_failed';
      throw error;
    }

    operationReadiness.postpaint_study_graphics = await settleStudyGraphics({
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
    });
    const prepaintStudySignature = operationReadiness.study_graphics?.state_signature;
    if (typeof prepaintStudySignature !== 'string'
      || operationReadiness.postpaint_study_graphics?.state_signature !== prepaintStudySignature) {
      const error = new Error('V2 machine/graphics state changed across synchronous update-and-paint.');
      error.code = 'study_state_changed_across_paint';
      throw error;
    }
  } else {
    operationReadiness.study_graphics = {
      skipped: true,
      reason: 'exact_v2_study_unavailable_at_preflight',
    };
    operationReadiness.canvas_paint = { skipped: true };
    operationReadiness.postpaint_study_graphics = { skipped: true };
  }

  latest = null;
  stableSignature = null;
  stablePolls = 0;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    latest = await snapshotChartState();
    const mismatches = chartSnapshotMismatches(snapshot, latest);
    const settled = latest?.main_loading === false && mismatches.length === 0;
    if (settled) {
      const signature = JSON.stringify({
        symbol: normalizeSymbol(latest.symbol),
        timeframe: String(latest.timeframe),
        visible_range: latest.visible_range,
        time_scale: latest.time_scale,
        main_bar_count: latest.main_bar_count,
        main_last_time_s: latest.main_last_time_s,
      });
      stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
      stableSignature = signature;
      if (stablePolls >= 2) {
        return {
          success: true,
          stable_poll_count: stablePolls,
          observed: latest,
          operation_readiness: {
            ...operationReadiness,
            time_scale_reapplications: geometryReapplications,
          },
        };
      }
    } else {
      stableSignature = null;
      stablePolls = 0;
    }
    if (attempt + 1 < maximumPolls) await pause(pollIntervalMs);
  }
  const error = new Error(`Chart restoration changed after synchronous update-and-paint: ${JSON.stringify(latest)}`);
  error.code = 'chart_restoration_post_paint_settle_timeout';
  throw error;
}

export function chartSnapshotMismatches(expected, observed) {
  const mismatches = [];
  try {
    validateChartSnapshot(expected);
    validateChartSnapshot(observed);
  } catch (error) {
    return [error.message];
  }
  if (normalizeSymbol(expected.symbol) !== normalizeSymbol(observed.symbol)) {
    mismatches.push(`symbol ${observed.symbol} != ${expected.symbol}`);
  }
  if (String(expected.timeframe) !== String(observed.timeframe)) {
    mismatches.push(`timeframe ${observed.timeframe} != ${expected.timeframe}`);
  }
  if (expected.chart_type !== observed.chart_type) {
    mismatches.push(`chart type ${observed.chart_type} != ${expected.chart_type}`);
  }
  const expectedRange = expected.visible_range;
  const observedRange = observed.visible_range;
  // Both values come from getVisibleRange() around a restore to the same chart.
  // Permit only sub-second serialization noise; a shifted bar is not a verified
  // restoration, especially on weekly charts.
  const rangeTolerance = 1;
  if (Math.abs(expectedRange.from - observedRange.from) > rangeTolerance
    || Math.abs(expectedRange.to - observedRange.to) > rangeTolerance) {
    mismatches.push(`visible range ${JSON.stringify(observedRange)} != ${JSON.stringify(expectedRange)}`);
  }
  for (const key of ['bar_spacing', 'right_offset', 'width']) {
    if (observed.time_scale[key] !== expected.time_scale[key]) {
      mismatches.push(`time-scale ${key} ${observed.time_scale[key]} != ${expected.time_scale[key]}`);
    }
  }
  return mismatches;
}

export class SmaFibWatchlistRestorationError extends Error {
  constructor(message, partialResult) {
    super(message);
    this.name = 'SmaFibWatchlistRestorationError';
    this.code = 'sma_fib_watchlist_restoration_failed';
    this.partial_result = partialResult;
  }
}

function statusCounts(routes) {
  const counts = {};
  for (const route of routes) counts[route.status] = (counts[route.status] ?? 0) + 1;
  return counts;
}

function currentSafeAttentionReading(
  reading,
  symbol,
  timeframe,
  { fibSourceVerified = true, fibUnavailableReason = null } = {},
) {
  if (typeof reading?.current_bar_closed !== 'boolean') {
    const error = new Error('TradingView did not prove whether the current target bar is closed.');
    error.code = 'bar_status_unverified';
    throw error;
  }
  if (!Object.hasOwn(reading, 'attention_prior_sma')) {
    const error = new Error('The current-safe prior-200 SMA was not collected from main-chart bars.');
    error.code = 'current_safe_sma_unavailable';
    throw error;
  }
  const observedPairEligible = reading.pair_eligible === true || reading.pair_eligible === 1;
  const pairEligible = fibSourceVerified && observedPairEligible;
  const openBarRangeProved = reading.current_bar_closed || (
    positiveFinite(reading.current_low)
    && positiveFinite(reading.current_high)
    && positiveFinite(reading.current_price)
    && reading.current_low <= reading.current_high
    && reading.current_price >= reading.current_low
    && reading.current_price <= reading.current_high
  );
  const intrabarPairUnproved = !reading.current_bar_closed
    && pairEligible
    && !openBarRangeProved;
  const intrabarPairBroken = pairEligible
    && ((finite(reading.current_low) && finite(reading.fib_low)
      && reading.current_low < reading.fib_low)
      || (finite(reading.current_high) && finite(reading.fib_high)
        && reading.current_high > reading.fib_high));
  return {
    ...reading,
    requested_symbol: symbol,
    timeframe,
    prior_sma: reading.attention_prior_sma,
    pair_eligible: pairEligible && !intrabarPairBroken && !intrabarPairUnproved,
    intrabar_pair_suppressed: intrabarPairBroken || intrabarPairUnproved,
    intrabar_pair_suppression_reason: intrabarPairUnproved
      ? 'bar_range_unproved'
      : intrabarPairBroken ? 'anchor_break'
        : observedPairEligible && !fibSourceVerified ? 'fib_source_unverified' : null,
    fib_source_binding_verified: fibSourceVerified,
    fib_detector_unavailable_reason: fibSourceVerified ? null : fibUnavailableReason,
  };
}

function lastClosedAttentionReading(
  reading,
  symbol,
  timeframe,
  { fibSourceVerified = true, fibUnavailableReason = null } = {},
) {
  const profile = PROFILE_BY_TIMEFRAME[timeframe];
  if (!profile || typeof reading?.current_bar_closed !== 'boolean') return null;
  if (reading.current_bar_closed) {
    return currentSafeAttentionReading(reading, symbol, timeframe, {
      fibSourceVerified,
      fibUnavailableReason,
    });
  }
  const mainOnly = reading.fib_machine_available === false;
  if (!Object.hasOwn(reading, 'previous_attention_prior_sma')
    || !finite(reading?.previous_main_time_s)
    || (!mainOnly && reading.previous_main_time_s !== reading.previous_study_time_s)
    || (!mainOnly && reading.previous_profile_code !== profile.code)
    || !positiveFinite(reading.previous_price)) return null;
  return {
    requested_symbol: symbol,
    chart_symbol: reading.chart_symbol,
    timeframe,
    current_bar_time_s: reading.previous_main_time_s,
    current_price: reading.previous_price,
    current_low: reading.previous_low,
    current_high: reading.previous_high,
    prior_sma: reading.previous_attention_prior_sma,
    pair_eligible: fibSourceVerified && reading.previous_pair_eligible === 1,
    fib_machine_available: reading.fib_machine_available !== false,
    fib_source_binding_verified: fibSourceVerified,
    fib_detector_unavailable_reason: fibSourceVerified ? null : fibUnavailableReason,
    fib_low: reading.previous_fib_low,
    fib_high: reading.previous_fib_high,
    fib_low_pivot_time_ms: reading.previous_fib_low_pivot_time_ms,
    fib_high_pivot_time_ms: reading.previous_fib_high_pivot_time_ms,
    fib_high_confirmation_time_ms: reading.previous_fib_high_confirmation_time_ms,
    golden_top: reading.previous_golden_top,
    golden_bottom: reading.previous_golden_bottom,
  };
}

function rankMatches(left, right) {
  return left.joint_distance_pct - right.joint_distance_pct
    || left.sma_to_pocket_pct - right.sma_to_pocket_pct
    || left.symbol.localeCompare(right.symbol)
    || left.timeframe.localeCompare(right.timeframe);
}

const FIB_STUDY_RUNTIME_FAILURE_CODES = new Set([
  'study_unavailable',
  'study_ambiguous',
  'study_hidden',
  'study_source_hidden',
  'study_source_visibility_unproved',
  'study_visual_contract_mismatch',
  'study_golden_pocket_hidden',
  'study_status_table_visibility_unproved',
  'study_plot_contract_mismatch',
  'sma_fib_applied_script_identity_mismatch',
  'study_source_identity_mismatch',
  'source_identity_transition_unproved',
  'route_marker_unavailable',
  'route_settle_timeout',
]);

function canDegradeFibRouteToMainOnly(error) {
  return FIB_STUDY_RUNTIME_FAILURE_CODES.has(error?.code);
}

function resolveDeps(deps = {}) {
  const evaluate = deps.evaluate ?? defaultEvaluate;
  const pause = deps.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let verifiedSourceAuthority = deps.sourceAuthority
    ?? (deps.preflightEvidence?.source_binding?.verified === true
      ? deps.preflightEvidence.source_binding
      : null);
  let studyContractAvailable = deps.preflightEvidence?.study_contract_available !== false;
  let baselineStudyContractAvailable = studyContractAvailable;
  const snapshotChartState = deps.snapshotChartState ?? (() => captureSmaFibChartSnapshot({ evaluate }));
  const setSymbol = deps.setSymbol ?? (({ symbol }) => setSmaFibRouteSymbol({
    symbol,
    timeoutMs: deps.symbolTimeoutMs,
    pollIntervalMs: deps.pollIntervalMs,
    _deps: { evaluate, pause },
  }));
  const preflightStudy = async () => {
    const evidence = deps.preflightStudy
      ? await deps.preflightStudy()
      : await preflightSmaFibAttentionSources({
          _deps: {
            evaluate,
            sourceAuthority: verifiedSourceAuthority,
            loadSourceBindingContract: deps.loadSourceBindingContract,
          },
        });
    if (evidence?.source_binding?.verified === true) {
      verifiedSourceAuthority = evidence.source_binding;
    }
    studyContractAvailable = evidence?.study_contract_available !== false;
    baselineStudyContractAvailable = studyContractAvailable;
    return evidence;
  };
  const readRouteWithMode = (route, allowMainOnly) => deps.readRoute
    ? deps.readRoute({
        ...route,
        sourceAuthority: verifiedSourceAuthority,
        allowMainOnly,
      })
    : readCurrentSmaFibRoute({
        requestedSymbol: route.symbol,
        timeframe: route.timeframe,
        previousRouteMarker: route.previousRouteMarker,
        requireSourceTransition: route.requireSourceTransition,
        timeoutMs: deps.routeTimeoutMs,
        pollIntervalMs: deps.pollIntervalMs,
        _deps: {
          evaluate,
          pause,
          sourceAuthority: verifiedSourceAuthority,
          allowMainOnly,
        },
      });
  const readRoute = async route => {
    if (!studyContractAvailable) return readRouteWithMode(route, true);
    try {
      return await readRouteWithMode(route, false);
    } catch (error) {
      if (!canDegradeFibRouteToMainOnly(error)) throw error;
      const fallbackReading = await readRouteWithMode(route, true);
      return {
        ...fallbackReading,
        fib_runtime_fallback_failure: errorRecord(error),
      };
    }
  };
  const captureRouteMarker = deps.captureRouteMarker ?? (async () => {
    const capture = allowMainOnly => captureSmaFibRouteMarker({
      timeoutMs: deps.markerTimeoutMs,
      pollIntervalMs: deps.pollIntervalMs,
      _deps: {
        evaluate,
        pause,
        sourceAuthority: verifiedSourceAuthority,
        allowMainOnly,
      },
    });
    if (!studyContractAvailable) return capture(true);
    try {
      return await capture(false);
    } catch (error) {
      if (!canDegradeFibRouteToMainOnly(error)) throw error;
      return capture(true);
    }
  });
  return {
    snapshotChartState,
    readChartControlRoute: deps.readChartControlRoute
      ?? (() => readSmaFibChartControlRoute({ evaluate })),
    withChartControlLease: deps.withChartControlLease
      ?? ((callback, options) => defaultWithChartControlLease(callback, options)),
    chartControlLeaseOptions: {
      ...(deps.chartControlLeaseOptions ?? {}),
      owner: CHART_CONTROL_LEASE_OWNER,
    },
    preflightStudy,
    captureRouteMarker,
    restoreChartState: deps.restoreChartState
      ? snapshot => deps.restoreChartState(snapshot, {
          requireStudyGraphics: baselineStudyContractAvailable,
        })
      : snapshot => restoreSmaFibChartSnapshot(snapshot, {
          ...deps,
          evaluate,
          setSymbol,
          snapshotChartState,
          pause,
          sourceAuthority: verifiedSourceAuthority,
          requireStudyGraphics: baselineStudyContractAvailable,
          timeoutMs: deps.restoreTimeoutMs,
          pollIntervalMs: deps.pollIntervalMs,
        }),
    setSymbol,
    setTimeframe: deps.setTimeframe ?? defaultSetTimeframe,
    readRoute,
    getWatchlist: deps.getWatchlist ?? (() => defaultGetWatchlist()),
    now: deps.now ?? Date.now,
  };
}

/**
 * Scan watchlist symbols against the current visible V2 study.
 *
 * @param {object} options
 * @param {Array<string|{symbol:string}>|{symbols:Array}} options.symbols
 * @param {number} [options.priceBufferPct=5]
 * @param {number} [options.alignmentTolerancePct=0]
 * @param {number} [options.maBufferPct=priceBufferPct]
 * @param {number} [options.fibBufferPct=priceBufferPct]
 * @param {object} [options.query] structured attention query
 * @param {true} options.exclusiveChartUseConfirmed explicit exclusive-chart acknowledgement
 * @param {object} [options._deps] dependency overrides for tests/integration
 */
async function scanSmaFibWatchlistInternal({
  symbols,
  priceBufferPct = 5,
  alignmentTolerancePct = 0,
  maBufferPct,
  fibBufferPct,
  query,
  _scanAsOfTimeMs,
  _preflightEvidence,
  _deps,
} = {}) {
  const watchlistSymbols = normalizeWatchlistSymbols(symbols);
  const priceBuffer = requirePercent(priceBufferPct, 'priceBufferPct');
  const alignmentTolerance = requirePercent(alignmentTolerancePct, 'alignmentTolerancePct');
  const maBuffer = requirePercent(maBufferPct ?? priceBuffer, 'maBufferPct');
  const fibBuffer = requirePercent(fibBufferPct ?? priceBuffer, 'fibBufferPct');
  const unqualifiedSymbols = watchlistSymbols.filter(symbol => !qualifiedSymbolParts(symbol));
  if (unqualifiedSymbols.length) {
    throw new TypeError(`symbols must be exchange-qualified TradingView IDs: ${unqualifiedSymbols.join(', ')}.`);
  }
  const dependencies = resolveDeps({
    ...(_deps ?? {}),
    preflightEvidence: _preflightEvidence,
  });
  const asOfTimeMs = scanTimestamp(_scanAsOfTimeMs
    ?? (typeof dependencies.now === 'function' ? dependencies.now() : dependencies.now));
  const routes = [];
  const observations = [];
  const lastClosedObservations = [];
  let baseline = null;
  let result = null;
  let scanError = null;
  let restorationError = null;
  let restoredSnapshot = null;
  let interferenceError = null;

  if (watchlistSymbols.length === 0) {
    const emptyPreflight = _preflightEvidence ?? null;
    const emptyFibStudyAvailable = emptyPreflight?.study_contract_available !== false;
    const emptyFibVerified = emptyPreflight !== null
      && emptyFibStudyAvailable
      && emptyPreflight?.source_binding?.verified === true;
    const emptyFibFailure = emptyFibStudyAvailable
      ? emptyPreflight?.source_binding?.failure
      : emptyPreflight?.study_failure;
    return {
      success: true,
      persistent_writes: false,
      alerts_modified: false,
      transient_chart_mutation: false,
      study_title: SMA_FIB_WATCH_STUDY_TITLE,
      scan_as_of_time_ms: asOfTimeMs,
      requested_symbols: [],
      preflight: emptyPreflight,
      detector_failures: emptyPreflight === null || emptyFibVerified ? [] : [{
        detector: 'fib',
        code: emptyFibFailure?.code ?? (emptyFibStudyAvailable
          ? 'sma_fib_live_binding_unverified'
          : 'sma_fib_study_unavailable'),
        message: emptyFibFailure?.message ?? 'Fib source authority is unavailable.',
      }],
      criteria: {
        price_buffer_pct: priceBuffer,
        alignment_tolerance_pct: alignmentTolerance,
        timeframes: [...SMA_FIB_WATCH_TIMEFRAMES],
      },
      symbol_count: 0,
      route_count: 0,
      status_counts: {},
      routes: [],
      observation_count: 0,
      observations: [],
      last_closed_observation_count: 0,
      last_closed_observations: [],
      all_observation_count: 0,
      all_observations: [],
      active_observation_count: 0,
      active_observations: [],
      ma_match_count: 0,
      ma_matches: [],
      ma_interaction_count: 0,
      ma_interactions: [],
      fib_match_count: 0,
      fib_matches: [],
      fib_interaction_count: 0,
      fib_interactions: [],
      confluence_match_count: 0,
      confluence_matches: [],
      query_result: {
        applied: query !== undefined,
        criteria: query ?? null,
        match_count: 0,
        matches: [],
      },
      match_count: 0,
      matches: [],
      restoration: { attempted: false, success: true },
    };
  }

  const preflight = _preflightEvidence ?? await dependencies.preflightStudy();
  const fibStudyAvailable = preflight?.study_contract_available !== false;
  const fibSourceVerified = fibStudyAvailable
    && preflight?.source_binding?.verified === true;
  const fibFailure = !fibStudyAvailable
    ? preflight?.study_failure
    : preflight?.source_binding?.failure;
  const fibUnavailableReason = !fibStudyAvailable
    ? (fibFailure?.code ?? 'sma_fib_study_unavailable')
    : (fibFailure?.code ?? 'sma_fib_live_binding_unverified');
  const detectorFailures = fibSourceVerified ? [] : [{
    detector: 'fib',
    code: fibUnavailableReason,
    message: fibFailure?.message
      ?? (fibStudyAvailable
        ? 'The applied SMA/Fib V2 source is not bound, so Fib outputs are suppressed.'
        : 'The exact SMA/Fib V2 machine-output study is unavailable, so Fib outputs are suppressed.'),
  }];
  return dependencies.withChartControlLease(async lease => {
    baseline = await dependencies.snapshotChartState();
    validateChartSnapshot(baseline);
    let lastOwnedRoute = {
      symbol: normalizeSymbol(baseline.symbol),
      timeframe: String(baseline.timeframe),
      chart_type: Number(baseline.chart_type),
      visible_range: { ...baseline.visible_range },
      time_scale: { ...baseline.time_scale },
    };
    lease?.update?.({
      phase: 'baseline_captured',
      last_owned_chart_route: chartControlLeaseRoute(lastOwnedRoute),
    });
    try {
    for (const timeframe of SMA_FIB_WATCH_TIMEFRAMES) {
      for (const symbol of watchlistSymbols) {
        await verifyScannerOwnedChartRoute(
          dependencies,
          lease,
          lastOwnedRoute,
          `route inspection for ${symbol} ${timeframe}`,
        );
        let previousRouteMarker;
        try {
          previousRouteMarker = await dependencies.captureRouteMarker({ symbol, timeframe });
        } catch (error) {
          routes.push(unavailableRoute(symbol, timeframe, 'route_marker_failed', error));
          continue;
        }
        if (!chartControlRouteMatches(lastOwnedRoute, previousRouteMarker)) {
          throw new ChartControlInterferenceError(
            `TradingView chart route changed while capturing the marker for ${symbol} ${timeframe}.`,
            {
              phase: `route marker for ${symbol} ${timeframe}`,
              expected: lastOwnedRoute,
              observed: {
                symbol: previousRouteMarker.chart_symbol,
                timeframe: previousRouteMarker.timeframe,
              },
            },
          );
        }
        const symbolChanged = !symbolIdentityMatches(symbol, previousRouteMarker);
        const timeframeChanged = normalizeTimeframe(previousRouteMarker.timeframe) !== timeframe;
        const requireSourceTransition = symbolChanged || timeframeChanged;
        if (symbolChanged) {
          const mutation = await runGuardedChartMutation({
            dependencies,
            lease,
            expected: lastOwnedRoute,
            intended: { symbol, timeframe: lastOwnedRoute.timeframe },
            phase: `symbol mutation for ${symbol} ${timeframe}`,
            mutate: () => dependencies.setSymbol({ symbol }),
          });
          lastOwnedRoute = mutation.state;
          if (mutation.error) {
            routes.push(unavailableRoute(
              symbol,
              timeframe,
              'symbol_change_failed',
              mutation.error,
            ));
            continue;
          }
        }
        if (timeframeChanged) {
          const mutation = await runGuardedChartMutation({
            dependencies,
            lease,
            expected: lastOwnedRoute,
            intended: { symbol: lastOwnedRoute.symbol, timeframe },
            phase: `timeframe mutation for ${symbol} ${timeframe}`,
            mutate: () => dependencies.setTimeframe({ timeframe }),
          });
          lastOwnedRoute = mutation.state;
          if (mutation.error) {
            routes.push(unavailableRoute(
              symbol,
              timeframe,
              'timeframe_change_failed',
              mutation.error,
            ));
            continue;
          }
        }
        try {
          const reading = await dependencies.readRoute({
            symbol,
            timeframe,
            previousRouteMarker,
            requireSourceTransition,
          });
          const routeFibVerified = fibSourceVerified
            && reading.fib_machine_available !== false;
          const routeFibRuntimeFailure = reading.fib_runtime_fallback_failure ?? null;
          const routeFibUnavailableReason = reading.fib_machine_available === false
            ? (routeFibRuntimeFailure?.code ?? 'sma_fib_study_unavailable_during_scan')
            : fibUnavailableReason;
          if (!routeFibVerified && !detectorFailures.some(failure => (
            failure.detector === 'fib' && failure.code === routeFibUnavailableReason
          ))) {
            detectorFailures.push({
              detector: 'fib',
              code: routeFibUnavailableReason,
              message: routeFibRuntimeFailure?.message
                ?? (reading.fib_machine_available === false
                  ? 'The exact SMA/Fib V2 route failed during the scan, so this route retains independent MA results and suppresses Fib outputs.'
                  : 'The exact SMA/Fib V2 source is unavailable, so Fib outputs are suppressed.'),
            });
          }
          const settledReading = currentSafeAttentionReading(
            reading,
            symbol,
            timeframe,
            {
              fibSourceVerified: routeFibVerified,
              fibUnavailableReason: routeFibUnavailableReason,
            },
          );
          lastOwnedRoute = await verifyScannerOwnedChartRoute(
            dependencies,
            lease,
            lastOwnedRoute,
            `settled route read for ${symbol} ${timeframe}`,
          );
          lease?.update?.({
            phase: `route settled for ${symbol} ${timeframe}`,
            last_owned_chart_route: chartControlLeaseRoute(lastOwnedRoute),
          });
          const attention = buildSmaFibObservation(settledReading, {
            maBufferPct: maBuffer,
            fibBufferPct: fibBuffer,
            alignmentTolerancePct: alignmentTolerance,
            scanAsOfTimeMs: asOfTimeMs,
            barClosed: settledReading.current_bar_closed,
            observationKind: 'current',
            source: {
              study_title: SMA_FIB_WATCH_STUDY_TITLE,
              mode: reading.fib_machine_available === false
                ? 'main_bars_only'
                : 'main_bars_plus_visible_machine_outputs',
              fib_source_binding_verified: routeFibVerified,
              fib_detector_unavailable_reason: routeFibVerified
                ? null
                : routeFibUnavailableReason,
            },
          });
          observations.push(attention);
          const previousReading = lastClosedAttentionReading(
            reading,
            symbol,
            timeframe,
            {
              fibSourceVerified: routeFibVerified,
              fibUnavailableReason: routeFibUnavailableReason,
            },
          );
          const lastClosedAttention = previousReading
            ? buildSmaFibObservation(previousReading, {
                maBufferPct: maBuffer,
                fibBufferPct: fibBuffer,
                alignmentTolerancePct: alignmentTolerance,
                scanAsOfTimeMs: asOfTimeMs,
                barClosed: true,
                observationKind: 'last_closed',
                source: {
                  study_title: SMA_FIB_WATCH_STUDY_TITLE,
                  mode: reading.fib_machine_available === false
                    ? 'main_bars_only'
                    : 'main_bars_plus_visible_machine_outputs',
                  fib_source_binding_verified: routeFibVerified,
                  fib_detector_unavailable_reason: routeFibVerified
                    ? null
                    : routeFibUnavailableReason,
                },
              })
            : null;
          if (lastClosedAttention) lastClosedObservations.push(lastClosedAttention);
          const assessedRoute = assessSmaFibRoute(settledReading, {
            priceBufferPct: priceBuffer,
            alignmentTolerancePct: alignmentTolerance,
            scanAsOfTimeMs: asOfTimeMs,
          });
          routes.push({
            ...assessedRoute,
            ...(settledReading.intrabar_pair_suppression_reason === 'bar_range_unproved' ? {
              status: attention.ma.available
                ? 'partial_fib_unavailable'
                : assessedRoute.status,
              match: false,
              unavailable_reason: 'current_bar_range_unproved',
            } : {}),
            ...(!routeFibVerified ? {
              status: attention.ma.available
                ? 'partial_fib_unavailable'
                : assessedRoute.status,
              match: false,
              unavailable_reason: routeFibUnavailableReason,
            } : {}),
            ma_status: attention.ma.status,
            fib_status: attention.fib.status,
            attention,
            attention_last_closed: lastClosedAttention,
          });
        } catch (error) {
          if (error?.code === 'insufficient_history') {
            routes.push({
              ...routeBase(symbol, timeframe),
              requested_symbol: normalizeSymbol(symbol),
              resolved_symbol: null,
              match_mode: null,
              status: 'insufficient_history',
              available: true,
              match: false,
              unavailable_reason: 'prior_200_sma_unavailable',
              error: errorRecord(error),
            });
          } else {
            routes.push(unavailableRoute(symbol, timeframe, 'route_read_failed', error));
          }
        }
      }
    }

    for (const route of routes) {
      if (!finite(route.scan_as_of_time_ms)) route.scan_as_of_time_ms = asOfTimeMs;
    }
    const matches = routes.filter(route => route.match).sort(rankMatches);
    const rankedObservations = [...observations].sort(rankSmaFibObservations);
    const rankedLastClosedObservations = [...lastClosedObservations]
      .sort(rankSmaFibObservations);
    const allObservations = [...rankedObservations, ...rankedLastClosedObservations];
    const activeObservations = rankedObservations
      .filter(observation => observation.confluence.primitive_family_count > 0);
    // `*_matches` answer the point-in-time question "within the buffer now".
    // Same-bar approaches/touches remain available separately so a prior
    // intrabar interaction cannot masquerade as current-price proximity.
    const maMatches = rankedObservations
      .filter(observation => observation.ma.within_price_buffer);
    const maInteractions = rankedObservations.filter(observation => observation.ma.active);
    const fibMatches = rankedObservations
      .filter(observation => observation.fib.within_price_buffer || observation.fib.inside);
    const fibInteractions = rankedObservations.filter(observation => observation.fib.active);
    const confluenceMatches = rankedObservations
      .filter(observation => observation.confluence.active);
    const effectiveQuery = query === undefined
      ? undefined
      : { observationKinds: ['current'], ...query };
    const queryMatches = effectiveQuery === undefined
      ? activeObservations
      : querySmaFibObservations(allObservations, effectiveQuery);
    result = {
      success: true,
      persistent_writes: false,
      alerts_modified: false,
      transient_chart_mutation: true,
      study_title: SMA_FIB_WATCH_STUDY_TITLE,
      scan_as_of_time_ms: asOfTimeMs,
      requested_symbols: watchlistSymbols.map(normalizeSymbol),
      preflight,
      detector_failures: detectorFailures,
      criteria: {
        price_buffer_pct: priceBuffer,
        alignment_tolerance_pct: alignmentTolerance,
        timeframes: [...SMA_FIB_WATCH_TIMEFRAMES],
        sma_to_pocket_denominator: 'nearest_pocket_edge',
        price_to_sma_denominator: 'prior_200_sma',
        price_to_pocket_denominator: 'nearest_pocket_edge',
        joint_distance: 'max(price_to_sma_pct, price_to_pocket_pct)',
      },
      attention_criteria: {
        schema_version: 'sma-fib-attention-observation/v1',
        ma_buffer_pct: maBuffer,
        fib_buffer_pct: fibBuffer,
        alignment_tolerance_pct: alignmentTolerance,
        primitive_families: ['ma', 'fib'],
        confluence_counts_as_primitive_family: false,
      },
      symbol_count: watchlistSymbols.length,
      route_count: routes.length,
      status_counts: statusCounts(routes),
      routes,
      observation_count: rankedObservations.length,
      observations: rankedObservations,
      last_closed_observation_count: rankedLastClosedObservations.length,
      last_closed_observations: rankedLastClosedObservations,
      all_observation_count: allObservations.length,
      all_observations: allObservations,
      active_observation_count: activeObservations.length,
      active_observations: activeObservations,
      ma_match_count: maMatches.length,
      ma_matches: maMatches,
      ma_interaction_count: maInteractions.length,
      ma_interactions: maInteractions,
      fib_match_count: fibMatches.length,
      fib_matches: fibMatches,
      fib_interaction_count: fibInteractions.length,
      fib_interactions: fibInteractions,
      confluence_match_count: confluenceMatches.length,
      confluence_matches: confluenceMatches,
      query_result: {
        applied: effectiveQuery !== undefined,
        criteria: effectiveQuery ?? null,
        match_count: queryMatches.length,
        matches: queryMatches,
      },
      match_count: matches.length,
      matches,
      baseline,
      restoration: { attempted: true, success: false },
    };
    } catch (error) {
      scanError = error;
      if (error?.code === 'chart_control_interference') interferenceError = error;
    } finally {
      if (!interferenceError) {
        try {
          await verifyScannerOwnedChartRoute(
            dependencies,
            lease,
            lastOwnedRoute,
            'baseline restoration',
          );
        } catch (error) {
          interferenceError = error;
          scanError = error;
        }
      }
      if (!interferenceError) {
        try {
          lease?.update?.({
            phase: 'restoring_baseline',
            last_owned_chart_route: chartControlLeaseRoute(lastOwnedRoute),
          });
          await dependencies.restoreChartState(baseline);
        } catch (error) {
          restorationError = error;
        }
        try {
          restoredSnapshot = await dependencies.snapshotChartState();
          const mismatches = chartSnapshotMismatches(baseline, restoredSnapshot);
          if (mismatches.length) {
            const mismatchError = new Error(`Chart restoration verification failed: ${mismatches.join('; ')}.`);
            mismatchError.code = 'chart_restoration_mismatch';
            restorationError = restorationError
              ? new Error(`${restorationError.message} ${mismatchError.message}`)
              : mismatchError;
          }
        } catch (error) {
          restorationError = restorationError
            ? new Error(`${restorationError.message} Verification failed: ${error.message}`)
            : error;
        }
      }
    }

    if (interferenceError) {
      interferenceError.partial_result = {
        ...(result ?? {
          success: false,
          persistent_writes: false,
          alerts_modified: false,
          transient_chart_mutation: true,
          routes,
          observations,
          last_closed_observations: lastClosedObservations,
          matches: routes.filter(route => route.match).sort(rankMatches),
        }),
        success: false,
        restoration: {
          attempted: false,
          success: false,
          skipped_reason: 'chart_control_interference',
        },
      };
      throw interferenceError;
    }
    if (restorationError) {
      const partialResult = result ?? {
        success: false,
        persistent_writes: false,
        alerts_modified: false,
        transient_chart_mutation: true,
        routes,
        observations,
        last_closed_observations: lastClosedObservations,
        matches: routes.filter(route => route.match).sort(rankMatches),
      };
      partialResult.success = false;
      partialResult.restoration = {
        attempted: true,
        success: false,
        observed: restoredSnapshot,
        error: errorRecord(restorationError, 'chart_restoration_failed'),
      };
      throw new SmaFibWatchlistRestorationError(restorationError.message, partialResult);
    }
    if (scanError) throw scanError;
    result.restoration = { attempted: true, success: true, observed: restoredSnapshot };
    return result;
  }, dependencies.chartControlLeaseOptions);
}

function enqueueScan(operation) {
  const run = scanLock.then(operation);
  scanLock = run.then(() => undefined, () => undefined);
  return run;
}

export function requireExclusiveChartUseConfirmed(value) {
  if (value === true) return true;
  const error = new Error(
    'This scan temporarily rotates the active TradingView chart. Confirm exclusive chart use before starting it.',
  );
  error.code = 'exclusive_chart_use_unconfirmed';
  throw error;
}

export function scanSmaFibWatchlist(options = {}) {
  try {
    requireExclusiveChartUseConfirmed(options.exclusiveChartUseConfirmed);
  } catch (error) {
    return Promise.reject(error);
  }
  return enqueueScan(() => scanSmaFibWatchlistInternal(options));
}

function requireCompleteWatchlist(reading) {
  let symbols = null;
  try { symbols = normalizeWatchlistSymbols(reading); } catch {}
  const complete = Array.isArray(symbols)
    && reading?.success === true
    && reading?.traversal?.complete === true
    && reading?.restoration?.panel?.verified === true
    && reading?.restoration?.scroll?.verified === true
    && Number.isSafeInteger(reading?.count)
    && reading.count === symbols.length
    && typeof reading?.list_name === 'string'
    && reading.list_name.trim().length > 0;
  if (!complete) {
    const error = new Error('Current watchlist read is incomplete or its state-safety evidence was not verified; chart scan was not started.');
    error.code = 'watchlist_read_incomplete';
    throw error;
  }
  const unqualified = symbols.filter(symbol => !/^[^:\s]+:[^\s]+$/.test(symbol));
  if (unqualified.length) {
    const error = new Error(`Current watchlist contains unqualified symbol IDs: ${unqualified.join(', ')}.`);
    error.code = 'watchlist_symbol_unqualified';
    throw error;
  }
  return symbols;
}

/** Read the complete active watchlist, then scan it within the same operation lock. */
export function scanCurrentSmaFibWatchlist({
  priceBufferPct = 5,
  alignmentTolerancePct = 0,
  maBufferPct,
  fibBufferPct,
  query,
  exclusiveChartUseConfirmed,
  _deps,
} = {}) {
  try {
    requireExclusiveChartUseConfirmed(exclusiveChartUseConfirmed);
  } catch (error) {
    return Promise.reject(error);
  }
  return enqueueScan(async () => {
    const dependencies = resolveDeps(_deps);
    const asOfTimeMs = scanTimestamp(typeof dependencies.now === 'function'
      ? dependencies.now()
      : dependencies.now);
    const preflight = await dependencies.preflightStudy();
    const watchlist = await dependencies.getWatchlist();
    const symbols = requireCompleteWatchlist(watchlist);
    const result = await scanSmaFibWatchlistInternal({
      symbols,
      priceBufferPct,
      alignmentTolerancePct,
      maBufferPct,
      fibBufferPct,
      query,
      _scanAsOfTimeMs: asOfTimeMs,
      _preflightEvidence: preflight,
      _deps: {
        ..._deps,
        ...(preflight?.source_binding?.verified === true
          ? { sourceAuthority: preflight.source_binding }
          : {}),
      },
    });
    return {
      ...result,
      watchlist: {
        list_id: watchlist.list_id ?? null,
        list_name: watchlist.list_name,
        count: watchlist.count,
        symbols: symbols.map(normalizeSymbol),
        source: watchlist.source ?? null,
        traversal: watchlist.traversal,
        restoration: watchlist.restoration,
      },
    };
  });
}
