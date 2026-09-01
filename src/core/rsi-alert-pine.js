import { createHash } from 'node:crypto';

import {
  RSI_EXACT_MACHINE_OUTPUTS,
  RSI_SELECTED_SOURCE_SHA256,
  RSI_SEMANTIC_INPUTS,
  bindRsiSemanticInputs,
} from './rsi-study-adapter.js';

export const RSI_ALERT_SCANNER_DEFINITION_VERSION = 'rsi-watchlist-alert-scanner/v1';
export const RSI_ALERT_SCANNER_STATUS = 'LOCAL_ONLY_UNCOMPILED';
export const RSI_ALERT_SCANNER_MAX_SYMBOLS = 30;
export const RSI_ALERT_SCANNER_TUPLE_WIDTH = 3;
export const RSI_ALERT_SCANNER_MAX_TUPLE_ELEMENTS =
  RSI_ALERT_SCANNER_MAX_SYMBOLS * RSI_ALERT_SCANNER_TUPLE_WIDTH;

export const RSI_ALERT_SCANNER_DEFAULT_INPUTS = Object.freeze({
  'RSI Length': 14,
  'RSI Source': 'close',
  'Pivot Left Bars': 5,
  'Pivot Right Bars': 5,
  'Min Bars Between Pivots': 5,
  'Max Bars Between Pivots': 120,
  'Price Low Source': 'low',
  'Price High Source': 'high',
  'Show Watch Signals': true,
  'Show Developing Divergences': true,
  'Show Regular Bullish': true,
  'Show Hidden Bullish': true,
  'Require Soft Bounce': true,
  'Soft Bounce Bars': 1,
  'Developing Max Age': 80,
  'Developing Min RSI Difference': 2,
  'Developing Min Price Difference %': 0.5,
  'Strict Clean Developing Lines': true,
  'Strict Local RSI Bars': 2,
  'Strict RSI Line Tolerance': 0.5,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeProfile(value) {
  const profile = String(value ?? '').trim().toUpperCase();
  if (profile === 'D' || profile === '1D') return 'D';
  if (profile === 'W' || profile === '1W') return 'W';
  throw new TypeError('defaultProfile must be D or W.');
}

function normalizeSymbol(value, index) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) {
    throw new TypeError(`symbols[${index}] must be an exchange-qualified TradingView symbol.`);
  }
  return symbol;
}

export function normalizeRsiAlertScannerSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > RSI_ALERT_SCANNER_MAX_SYMBOLS) {
    throw new TypeError('symbols must contain 1 through 30 exchange-qualified symbols.');
  }
  const seen = new Set();
  return symbols.map((value, index) => {
    const symbol = normalizeSymbol(value, index);
    if (seen.has(symbol)) throw new TypeError(`Duplicate RSI alert scanner symbol: ${symbol}`);
    seen.add(symbol);
    return symbol;
  });
}

export function shardRsiAlertScannerSymbols(symbols, maxSymbols = RSI_ALERT_SCANNER_MAX_SYMBOLS) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > RSI_ALERT_SCANNER_MAX_SYMBOLS) {
    throw new TypeError('maxSymbols must be an integer from 1 through 30.');
  }
  if (!Array.isArray(symbols) || symbols.length < 1) {
    throw new TypeError('symbols must be a non-empty array.');
  }
  const normalized = symbols.map(normalizeSymbol);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('symbols must not contain duplicates.');
  }
  const shards = [];
  for (let index = 0; index < normalized.length; index += maxSymbols) {
    shards.push(normalized.slice(index, index + maxSymbols));
  }
  return shards;
}

export function requiredRsiAlertInstanceCount(symbolCount) {
  if (!Number.isInteger(symbolCount) || symbolCount < 0) {
    throw new TypeError('symbolCount must be a non-negative integer.');
  }
  return symbolCount === 0 ? 0 : 2 * Math.ceil(symbolCount / RSI_ALERT_SCANNER_MAX_SYMBOLS);
}

function semanticInputRows(values) {
  return RSI_SEMANTIC_INPUTS.map(contract => ({
    ...contract,
    value: values[contract.title],
  }));
}

export function bindRsiAlertScannerInputProfile(values = RSI_ALERT_SCANNER_DEFAULT_INPUTS) {
  const unexpected = Object.keys(values).filter(title => (
    !RSI_SEMANTIC_INPUTS.some(contract => contract.title === title)
  ));
  if (unexpected.length) {
    throw new TypeError(`Unexpected RSI scanner semantic inputs: ${unexpected.join(', ')}`);
  }
  const bound = bindRsiSemanticInputs(semanticInputRows(values));
  return { values: Object.fromEntries(bound.inputs.map(row => [row.title, row.value])), sha256: bound.sha256 };
}

function pineString(value) {
  return JSON.stringify(String(value));
}

function pineBool(value) {
  return value ? 'true' : 'false';
}

function pineSource(value, title) {
  const allowed = new Set(['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4']);
  if (!allowed.has(value)) {
    throw new TypeError(`${title} is not an allowed built-in Pine price source.`);
  }
  return value;
}

function assertDefaultRange(value, { title, min, max = Infinity }) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)) {
    throw new TypeError(`${title} must be between ${min} and ${max}.`);
  }
}

function assertScannerInputRanges(values) {
  assertDefaultRange(values['RSI Length'], { title: 'RSI Length', min: 2 });
  assertDefaultRange(values['Pivot Left Bars'], { title: 'Pivot Left Bars', min: 1, max: 50 });
  assertDefaultRange(values['Pivot Right Bars'], { title: 'Pivot Right Bars', min: 1, max: 50 });
  assertDefaultRange(values['Min Bars Between Pivots'], {
    title: 'Min Bars Between Pivots', min: 1, max: 200,
  });
  assertDefaultRange(values['Max Bars Between Pivots'], {
    title: 'Max Bars Between Pivots', min: 5, max: 500,
  });
  assertDefaultRange(values['Soft Bounce Bars'], { title: 'Soft Bounce Bars', min: 0, max: 10 });
  assertDefaultRange(values['Developing Max Age'], {
    title: 'Developing Max Age', min: 5, max: 300,
  });
  assertDefaultRange(values['Developing Min RSI Difference'], {
    title: 'Developing Min RSI Difference', min: 0,
  });
  assertDefaultRange(values['Developing Min Price Difference %'], {
    title: 'Developing Min Price Difference %', min: 0,
  });
  assertDefaultRange(values['Strict Local RSI Bars'], {
    title: 'Strict Local RSI Bars', min: 1, max: 10,
  });
  assertDefaultRange(values['Strict RSI Line Tolerance'], {
    title: 'Strict RSI Line Tolerance', min: 0,
  });
  pineSource(values['RSI Source'], 'RSI Source');
  pineSource(values['Price Low Source'], 'Price Low Source');
  pineSource(values['Price High Source'], 'Price High Source');
}

export function estimateRsiAlertMessageMaxBytes({ maxSymbolChars = 80 } = {}) {
  if (!Number.isInteger(maxSymbolChars) || maxSymbolChars < 1) {
    throw new TypeError('maxSymbolChars must be a positive integer.');
  }
  const symbol = 'X'.repeat(maxSymbolChars);
  const events = Array.from({ length: RSI_ALERT_SCANNER_MAX_SYMBOLS * 4 }, (_, index) => ({
    symbol,
    event: [
      'NEW_DEVELOPING_REGULAR_BULL',
      'NEW_DEVELOPING_HIDDEN_BULL',
      'CONFIRMED_REGULAR_BULL',
      'CONFIRMED_HIDDEN_BULL',
    ][index % 4],
    data_bar_time_ms: 9_999_999_999_999,
    provisional: true,
  }));
  return Buffer.byteLength(JSON.stringify({
    schema_version: 'rsi-watchlist-alert-batch/v1',
    definition_version: RSI_ALERT_SCANNER_DEFINITION_VERSION,
    scanner_id: 'X'.repeat(80),
    profile: 'W',
    source_sha256: RSI_SELECTED_SOURCE_SHA256,
    events,
  }));
}

function symbolInputLines(symbols) {
  return Array.from({ length: RSI_ALERT_SCANNER_MAX_SYMBOLS }, (_, index) => {
    const slot = String(index + 1).padStart(2, '0');
    return `symbol${slot} = input.symbol(${pineString(symbols[index] ?? '')}, "Symbol ${slot}", group="Scanner symbols")`;
  }).join('\n');
}

function symbolArrayLine() {
  const names = Array.from(
    { length: RSI_ALERT_SCANNER_MAX_SYMBOLS },
    (_, index) => `symbol${String(index + 1).padStart(2, '0')}`,
  );
  return `var array<string> scannerSymbols = array.from(${names.join(', ')})`;
}

/**
 * Emit a deterministic Pine scanner. The RSI machine runs inside
 * request.security so it has Pine history; JavaScript never reconstructs RSI
 * from the CDP tool's 500-bar OHLCV window.
 */
export function generateRsiAlertScannerPine({
  symbols,
  defaultProfile = 'D',
  includeProvisional = true,
  semanticInputs = RSI_ALERT_SCANNER_DEFAULT_INPUTS,
  scannerId = 'sample-01',
} = {}) {
  const normalizedSymbols = normalizeRsiAlertScannerSymbols(symbols);
  const profile = normalizeProfile(defaultProfile);
  const inputProfile = bindRsiAlertScannerInputProfile(semanticInputs);
  const value = inputProfile.values;
  assertScannerInputRanges(value);
  const source = `// MPL-2.0
//@version=6
// Definition: ${RSI_ALERT_SCANNER_DEFINITION_VERSION}
// Selected RSI source SHA-256: ${RSI_SELECTED_SOURCE_SHA256}
// Semantic input profile SHA-256: ${inputProfile.sha256}
// Delivery status: ${RSI_ALERT_SCANNER_STATUS}; live applied source/version/input authority remains unverified.
indicator("Bullish RSI Watchlist Alert Scanner v1", overlay=false, max_bars_back=600, dynamic_requests=true)

scannerId = input.string(${pineString(scannerId)}, "Scanner ID", group="Scanner")
targetProfile = input.string(${pineString(profile)}, "Target profile", options=["D", "W"], group="Scanner")
includeProvisional = input.bool(${pineBool(includeProvisional)}, "Alert on provisional current D/W bar", group="Scanner")

rsiLength = input.int(${value['RSI Length']}, "RSI Length", minval=2, group="Exact RSI semantic inputs")
rsiSource = input.source(${pineSource(value['RSI Source'], 'RSI Source')}, "RSI Source", group="Exact RSI semantic inputs")
pivotLeft = input.int(${value['Pivot Left Bars']}, "Pivot Left Bars", minval=1, maxval=50, group="Exact RSI semantic inputs")
pivotRight = input.int(${value['Pivot Right Bars']}, "Pivot Right Bars", minval=1, maxval=50, group="Exact RSI semantic inputs")
minBarsBetween = input.int(${value['Min Bars Between Pivots']}, "Min Bars Between Pivots", minval=1, maxval=200, group="Exact RSI semantic inputs")
maxBarsBetween = input.int(${value['Max Bars Between Pivots']}, "Max Bars Between Pivots", minval=5, maxval=500, group="Exact RSI semantic inputs")
priceLowSource = input.source(${pineSource(value['Price Low Source'], 'Price Low Source')}, "Price Low Source", group="Exact RSI semantic inputs")
priceHighSource = input.source(${pineSource(value['Price High Source'], 'Price High Source')}, "Price High Source", group="Exact RSI semantic inputs")
showWatch = input.bool(${pineBool(value['Show Watch Signals'])}, "Show Watch Signals", group="Exact RSI semantic inputs")
showDeveloping = input.bool(${pineBool(value['Show Developing Divergences'])}, "Show Developing Divergences", group="Exact RSI semantic inputs")
showRegularBullish = input.bool(${pineBool(value['Show Regular Bullish'])}, "Show Regular Bullish", group="Exact RSI semantic inputs")
showHiddenBullish = input.bool(${pineBool(value['Show Hidden Bullish'])}, "Show Hidden Bullish", group="Exact RSI semantic inputs")
requireSoftBounce = input.bool(${pineBool(value['Require Soft Bounce'])}, "Require Soft Bounce", group="Exact RSI semantic inputs")
softBounceBars = input.int(${value['Soft Bounce Bars']}, "Soft Bounce Bars", minval=0, maxval=10, group="Exact RSI semantic inputs")
developingMaxAge = input.int(${value['Developing Max Age']}, "Developing Max Age", minval=5, maxval=300, group="Exact RSI semantic inputs")
minRsiDifference = input.float(${value['Developing Min RSI Difference']}, "Developing Min RSI Difference", minval=0.0, step=0.1, group="Exact RSI semantic inputs")
minPriceDifferencePct = input.float(${value['Developing Min Price Difference %']}, "Developing Min Price Difference %", minval=0.0, step=0.1, group="Exact RSI semantic inputs")
strictDevelopingLines = input.bool(${pineBool(value['Strict Clean Developing Lines'])}, "Strict Clean Developing Lines", group="Exact RSI semantic inputs")
strictLocalBars = input.int(${value['Strict Local RSI Bars']}, "Strict Local RSI Bars", minval=1, maxval=10, group="Exact RSI semantic inputs")
strictRsiLineTolerance = input.float(${value['Strict RSI Line Tolerance']}, "Strict RSI Line Tolerance", minval=0.0, step=0.1, group="Exact RSI semantic inputs")

${symbolInputLines(normalizedSymbols)}

string standardHostSymbol = ticker.standard(syminfo.tickerid)
bool hostSupported = standardHostSymbol == "BINANCE:BTCUSDT" and chart.is_standard and timeframe.in_seconds() == 3600
if barstate.isfirst and not hostSupported
    runtime.error("Use standard BINANCE:BTCUSDT 60-minute candles")

f_rsiLineIsClean(int anchorBar, float anchorRsi, int candidateBar, float candidateRsi, float rsiSeries) =>
    bool clean = true
    int span = candidateBar - anchorBar
    if span > 1 and not na(anchorRsi) and not na(candidateRsi)
        for step = 1 to math.min(span - 1, maxBarsBetween)
            int offset = bar_index - (anchorBar + step)
            if offset >= 0
                float expectedRsi = anchorRsi + (candidateRsi - anchorRsi) * step / span
                float actualRsi = rsiSeries[offset]
                if not na(actualRsi)
                    clean := actualRsi >= expectedRsi - strictRsiLineTolerance
                    if not clean
                        break
    clean

// Ported ordinary bullish machine candidate from the selected RSI source. Live
// parity remains unverified. It emits only NEW_DEVELOPING and CONFIRMED bits.
f_bullEventMask() =>
    float rsiValue = ta.rsi(rsiSource, rsiLength)
    float pivotLow = ta.pivotlow(priceLowSource, pivotLeft, pivotRight)
    bool hasPivotLow = not na(pivotLow)
    int lowPivotBar = bar_index - pivotRight
    float lowPivotPrice = pivotLow
    float lowPivotRsi = rsiValue[pivotRight]

    var int previousLowPivotBar = na
    var float previousLowPivotPrice = na
    var float previousLowPivotRsi = na
    var int regularBullCandidateBar = na
    var float regularBullCandidatePrice = na
    var float regularBullCandidateRsi = na
    var int hiddenBullCandidateBar = na
    var float hiddenBullCandidatePrice = na
    var float hiddenBullCandidateRsi = na
    var bool hiddenBullAnchorBroken = false
    var int lastBullDevelopingAlertKind = 0
    var int lastBullDevelopingAlertBar = na

    bool regularBullish = false
    bool hiddenBullish = false
    int lowBarsBetween = na(previousLowPivotBar) ? na : lowPivotBar - previousLowPivotBar
    bool lowInBarRange = not na(lowBarsBetween) and lowBarsBetween >= minBarsBetween and lowBarsBetween <= maxBarsBetween

    if hasPivotLow
        regularBullish := showRegularBullish and lowInBarRange and lowPivotPrice < previousLowPivotPrice and lowPivotRsi > previousLowPivotRsi
        hiddenBullish := showHiddenBullish and lowInBarRange and lowPivotPrice > previousLowPivotPrice and lowPivotRsi < previousLowPivotRsi
        previousLowPivotBar := lowPivotBar
        previousLowPivotPrice := lowPivotPrice
        previousLowPivotRsi := lowPivotRsi
        regularBullCandidateBar := na
        regularBullCandidatePrice := na
        regularBullCandidateRsi := na
        hiddenBullCandidateBar := na
        hiddenBullCandidatePrice := na
        hiddenBullCandidateRsi := na
        hiddenBullAnchorBroken := false
        lastBullDevelopingAlertKind := 0
        lastBullDevelopingAlertBar := na

    bool bullAnchorReady = not na(previousLowPivotBar) and not na(previousLowPivotPrice) and math.abs(previousLowPivotPrice) > 0 and not na(previousLowPivotRsi)
    int bullAgeFromAnchor = bullAnchorReady ? bar_index - previousLowPivotBar : na
    bool bullDevelopingAgeInRange = bullAnchorReady and bullAgeFromAnchor >= minBarsBetween and bullAgeFromAnchor <= maxBarsBetween and bullAgeFromAnchor <= developingMaxAge
    float regularBullPriceDiffPct = bullAnchorReady ? (previousLowPivotPrice - priceLowSource) / math.abs(previousLowPivotPrice) * 100.0 : na
    float hiddenBullPriceDiffPct = bullAnchorReady ? (priceLowSource - previousLowPivotPrice) / math.abs(previousLowPivotPrice) * 100.0 : na
    float regularBullRsiDiff = bullAnchorReady ? rsiValue - previousLowPivotRsi : na
    float hiddenBullRsiDiff = bullAnchorReady ? previousLowPivotRsi - rsiValue : na
    float bullLocalLowest = ta.lowest(rsiValue, strictLocalBars + 1)
    bool bullStrictLocalOk = not strictDevelopingLines or rsiValue <= bullLocalLowest

    if bullAnchorReady and priceLowSource <= previousLowPivotPrice
        hiddenBullAnchorBroken := true

    bool regularBullCandidateNow = showRegularBullish and bullDevelopingAgeInRange and regularBullPriceDiffPct >= minPriceDifferencePct and regularBullRsiDiff >= minRsiDifference and bullStrictLocalOk
    bool hiddenBullCandidateNow = showHiddenBullish and bullDevelopingAgeInRange and hiddenBullPriceDiffPct >= minPriceDifferencePct and hiddenBullRsiDiff >= minRsiDifference and bullStrictLocalOk and (not strictDevelopingLines or not hiddenBullAnchorBroken)

    if bullAnchorReady and not na(regularBullCandidateBar)
        bool regularBullCandidateExpired = bar_index - regularBullCandidateBar > developingMaxAge or bullAgeFromAnchor > maxBarsBetween
        bool regularBullCandidateBroken = priceLowSource < regularBullCandidatePrice and regularBullRsiDiff < minRsiDifference
        if regularBullCandidateExpired or regularBullCandidateBroken
            regularBullCandidateBar := na
            regularBullCandidatePrice := na
            regularBullCandidateRsi := na

    if bullAnchorReady and not na(hiddenBullCandidateBar)
        bool hiddenBullCandidateExpired = bar_index - hiddenBullCandidateBar > developingMaxAge or bullAgeFromAnchor > maxBarsBetween
        bool hiddenBullCandidateBroken = priceLowSource <= previousLowPivotPrice
        if hiddenBullCandidateExpired or hiddenBullCandidateBroken
            hiddenBullCandidateBar := na
            hiddenBullCandidatePrice := na
            hiddenBullCandidateRsi := na

    if regularBullCandidateNow
        bool regularBullCandidateImproved = na(regularBullCandidateBar) or priceLowSource < regularBullCandidatePrice or (priceLowSource == regularBullCandidatePrice and rsiValue > regularBullCandidateRsi)
        if regularBullCandidateImproved
            regularBullCandidateBar := bar_index
            regularBullCandidatePrice := priceLowSource
            regularBullCandidateRsi := rsiValue

    if hiddenBullCandidateNow
        bool hiddenBullCandidateImproved = na(hiddenBullCandidateBar) or rsiValue < hiddenBullCandidateRsi or (rsiValue == hiddenBullCandidateRsi and priceLowSource < hiddenBullCandidatePrice)
        if hiddenBullCandidateImproved
            hiddenBullCandidateBar := bar_index
            hiddenBullCandidatePrice := priceLowSource
            hiddenBullCandidateRsi := rsiValue

    int regularBullCandidateAge = na(regularBullCandidateBar) ? na : bar_index - regularBullCandidateBar
    int hiddenBullCandidateAge = na(hiddenBullCandidateBar) ? na : bar_index - hiddenBullCandidateBar
    bool regularBullSoftBounce = not requireSoftBounce or softBounceBars == 0 or (not na(regularBullCandidateAge) and regularBullCandidateAge >= softBounceBars and close > regularBullCandidatePrice and rsiValue > regularBullCandidateRsi)
    bool hiddenBullSoftBounce = not requireSoftBounce or softBounceBars == 0 or (not na(hiddenBullCandidateAge) and hiddenBullCandidateAge >= softBounceBars and close > hiddenBullCandidatePrice and rsiValue > hiddenBullCandidateRsi)
    int safeLowAnchorBar = na(previousLowPivotBar) ? bar_index : previousLowPivotBar
    float safeLowAnchorRsi = na(previousLowPivotRsi) ? rsiValue : previousLowPivotRsi
    int safeRegularBullCandidateBar = na(regularBullCandidateBar) ? safeLowAnchorBar : regularBullCandidateBar
    float safeRegularBullCandidateRsi = na(regularBullCandidateRsi) ? safeLowAnchorRsi : regularBullCandidateRsi
    int safeHiddenBullCandidateBar = na(hiddenBullCandidateBar) ? safeLowAnchorBar : hiddenBullCandidateBar
    float safeHiddenBullCandidateRsi = na(hiddenBullCandidateRsi) ? safeLowAnchorRsi : hiddenBullCandidateRsi
    bool regularBullCleanLineRaw = f_rsiLineIsClean(safeLowAnchorBar, safeLowAnchorRsi, safeRegularBullCandidateBar, safeRegularBullCandidateRsi, rsiValue)
    bool hiddenBullCleanLineRaw = f_rsiLineIsClean(safeLowAnchorBar, safeLowAnchorRsi, safeHiddenBullCandidateBar, safeHiddenBullCandidateRsi, rsiValue)
    bool regularBullCleanLine = not strictDevelopingLines or (not na(regularBullCandidateBar) and regularBullCleanLineRaw)
    bool hiddenBullCleanLine = not strictDevelopingLines or (not na(hiddenBullCandidateBar) and hiddenBullCleanLineRaw)
    bool developingRegularBullish = showDeveloping and not na(regularBullCandidateBar) and regularBullSoftBounce and regularBullCleanLine
    bool developingHiddenBullish = showDeveloping and not developingRegularBullish and not na(hiddenBullCandidateBar) and hiddenBullSoftBounce and hiddenBullCleanLine
    bool developingBullish = developingRegularBullish or developingHiddenBullish
    bool developingRegularBullSignal = developingRegularBullish and (lastBullDevelopingAlertKind != 1 or lastBullDevelopingAlertBar != regularBullCandidateBar)
    bool developingHiddenBullSignal = developingHiddenBullish and (lastBullDevelopingAlertKind != 2 or lastBullDevelopingAlertBar != hiddenBullCandidateBar)

    if not developingBullish
        lastBullDevelopingAlertKind := 0
        lastBullDevelopingAlertBar := na
    if developingRegularBullSignal
        lastBullDevelopingAlertKind := 1
        lastBullDevelopingAlertBar := regularBullCandidateBar
    if developingHiddenBullSignal
        lastBullDevelopingAlertKind := 2
        lastBullDevelopingAlertBar := hiddenBullCandidateBar

    int eventMask = (developingRegularBullSignal ? 1 : 0) + (developingHiddenBullSignal ? 2 : 0) + (regularBullish ? 4 : 0) + (hiddenBullish ? 8 : 0)
    eventMask

f_payload() =>
    int currentMask = f_bullEventMask()
    [currentMask, time, time_close]

f_eventName(int bitIndex) =>
    switch bitIndex
        0 => "NEW_DEVELOPING_REGULAR_BULL"
        1 => "NEW_DEVELOPING_HIDDEN_BULL"
        2 => "CONFIRMED_REGULAR_BULL"
        => "CONFIRMED_HIDDEN_BULL"

f_shortSymbol(string symbolText) =>
    int separator = str.pos(symbolText, ":")
    not na(separator) and separator >= 0 ? str.substring(symbolText, separator + 1) : symbolText

f_humanEventName(int bitIndex) =>
    switch bitIndex
        0 => "Developing regular bullish RSI divergence"
        1 => "Developing hidden bullish RSI divergence"
        2 => "Confirmed regular bullish RSI divergence"
        => "Confirmed hidden bullish RSI divergence"

f_append(string events, string humanLines, string symbolText, string profile, int mask, int signalTime, bool provisional, int symbolIndex, bool suppressAttachBaseline, int attachedAtMs, array<int> lastEventTimes) =>
    string nextEvents = events
    string nextHumanLines = humanLines
    if mask > 0 and not na(signalTime)
        for bitIndex = 0 to 3
            int bit = bitIndex == 0 ? 1 : bitIndex == 1 ? 2 : bitIndex == 2 ? 4 : 8
            if int(math.floor(mask / bit)) % 2 == 1
                int slot = symbolIndex * 4 + bitIndex
                int priorTime = array.get(lastEventTimes, slot)
                bool unseen = na(priorTime) or priorTime != signalTime
                array.set(lastEventTimes, slot, signalTime)
                bool existedAtAttach = signalTime <= attachedAtMs
                if barstate.isrealtime and unseen and not (suppressAttachBaseline and existedAtAttach)
                    string prefix = nextEvents == "" ? "" : ","
                    nextEvents += prefix + "{\\"symbol\\":\\"" + symbolText + "\\",\\"event\\":\\"" + f_eventName(bitIndex) + "\\",\\"data_bar_time_ms\\":" + str.tostring(signalTime) + ",\\"provisional\\":" + str.tostring(provisional) + "}"
                    string humanPrefix = nextHumanLines == "" ? "" : "\\n\\n"
                    string status = provisional ? "WATCH ONLY" : "REVIEW"
                    string profileLabel = profile == "W" ? "Weekly" : "Daily"
                    string action = provisional ? "Wait for the " + str.lower(profileLabel) + " close." : "Review the chart."
                    nextHumanLines += humanPrefix + status + " — " + f_shortSymbol(symbolText) + " (" + profileLabel + ")\\n" + f_humanEventName(bitIndex) + ". " + action + " Not a trade signal."
    [nextEvents, nextHumanLines]

${symbolArrayLine()}
varip array<int> lastEventTimes = array.new_int(${RSI_ALERT_SCANNER_MAX_SYMBOLS * 4}, na)
varip bool realtimeBootstrapped = false
var int attachedAtMs = timenow
var bool historyBootstrapped = false
array<string> seenSymbols = array.new_string()
string eventJson = ""
string humanLines = ""
string missingSymbols = ""
int configuredCount = 0
int availableCount = 0
bool suppressAttachBaseline = barstate.isrealtime and not realtimeBootstrapped
[payloadMask, payloadTime, payloadCloseTime] = f_payload()

for symbolIndex = 0 to array.size(scannerSymbols) - 1
    string symbolText = array.get(scannerSymbols, symbolIndex)
    if symbolText != ""
        if array.includes(seenSymbols, symbolText)
            runtime.error("Duplicate scanner symbol: " + symbolText)
        array.push(seenSymbols, symbolText)
        configuredCount += 1
        [currentMask, currentSignalTime, currentSignalCloseTime] = request.security(symbolText, targetProfile, [payloadMask, payloadTime, payloadCloseTime], gaps=barmerge.gaps_off, lookahead=barmerge.lookahead_off, ignore_invalid_symbol=true)
        if na(currentSignalTime)
            missingSymbols += (str.length(missingSymbols) == 0 ? "" : ", ") + symbolText
        else
            availableCount += 1
        // time_close is the scheduled end of the still-open 60m host bar and
        // can be up to one hour in the future. Use wall-clock time so a target
        // D/W event is never mislabeled CLOSED before its own close.
        bool targetBarClosed = not na(currentSignalCloseTime) and timenow >= currentSignalCloseTime
        bool shouldEvaluate = targetBarClosed or includeProvisional
        if shouldEvaluate
            [nextEventJson, nextHumanLines] = f_append(eventJson, humanLines, symbolText, targetProfile, currentMask, currentSignalTime, not targetBarClosed, symbolIndex, suppressAttachBaseline, attachedAtMs, lastEventTimes)
            eventJson := nextEventJson
            humanLines := nextHumanLines

if barstate.islastconfirmedhistory
    historyBootstrapped := true

if barstate.isrealtime
    realtimeBootstrapped := true

if barstate.isrealtime and historyBootstrapped and eventJson != ""
    string payload = "{\\"schema_version\\":\\"rsi-watchlist-alert-batch/v1\\",\\"definition_version\\":\\"${RSI_ALERT_SCANNER_DEFINITION_VERSION}\\",\\"scanner_id\\":\\"" + scannerId + "\\",\\"profile\\":\\"" + targetProfile + "\\",\\"source_sha256\\":\\"${RSI_SELECTED_SOURCE_SHA256}\\",\\"events\\":[" + eventJson + "]}"
    alert(humanLines + "\\n--- DATA ---\\n" + payload, alert.freq_all)

plot(float(configuredCount), "RSI Configured Symbols", display=display.data_window)
plot(float(availableCount), "RSI Available Symbols", display=display.data_window)
var table healthTable = table.new(position.top_right, 2, 4, border_width=1)
if barstate.islast
    table.cell(healthTable, 0, 0, "Bullish RSI Scanner", bgcolor=color.new(color.gray, 20), text_color=color.white)
    table.cell(healthTable, 1, 0, targetProfile, bgcolor=color.new(color.gray, 20), text_color=color.white)
    table.cell(healthTable, 0, 1, "Configured / available")
    table.cell(healthTable, 1, 1, str.tostring(configuredCount) + " / " + str.tostring(availableCount))
    table.cell(healthTable, 0, 2, "Missing data")
    table.cell(healthTable, 1, 2, str.length(missingSymbols) == 0 ? "None" : missingSymbols)
    table.cell(healthTable, 0, 3, "Activation")
    table.cell(healthTable, 1, 3, "LOCAL ONLY / uncompiled")
`;
  return {
    source,
    source_sha256: sha256(source),
    symbols: normalizedSymbols,
    default_profile: profile,
    include_provisional: includeProvisional,
    semantic_inputs: inputProfile,
  };
}

export function buildRsiAlertScannerManifest(generated, {
  artifactPath,
  generatedAt = null,
} = {}) {
  if (!generated?.source || generated.source_sha256 !== sha256(generated.source)) {
    throw new TypeError('generated must be a hash-consistent RSI Pine scanner result.');
  }
  return {
    schema_version: 'rsi-watchlist-alert-scanner-manifest/v1',
    status: RSI_ALERT_SCANNER_STATUS,
    definition_version: RSI_ALERT_SCANNER_DEFINITION_VERSION,
    generated_at: generatedAt,
    artifact_path: artifactPath ?? null,
    scanner_source_sha256: generated.source_sha256,
    selected_rsi_source_sha256: RSI_SELECTED_SOURCE_SHA256,
    selected_rsi_source_live_binding_verified: false,
    semantic_inputs_sha256: generated.semantic_inputs.sha256,
    semantic_input_values: generated.semantic_inputs.values,
    semantic_input_live_binding_verified: false,
    source_and_input_parity_with_selected_indicator_verified: false,
    reproducibility: {
      clean_checkout_complete: false,
      selected_source_is_external_untracked_evidence: true,
      required_resolution: 'Vendor a frozen read-only selected RSI source snapshot and parity evidence into this worktree before live readiness.',
    },
    default_profile: generated.default_profile,
    allowed_profiles: ['D', 'W'],
    profile_per_alert_instance: 1,
    symbols: generated.symbols,
    symbol_count: generated.symbols.length,
    max_symbols_per_shard: RSI_ALERT_SCANNER_MAX_SYMBOLS,
    required_alert_instances_for_this_shard: 2,
    host_chart_requirement: {
      symbol: 'BINANCE:BTCUSDT',
      timeframe: '60',
      chart_data: 'standard_non_synthetic',
    },
    request_budget: {
      dynamic_symbol_contexts: generated.symbols.length,
      tuple_width: RSI_ALERT_SCANNER_TUPLE_WIDTH,
      conservative_tuple_elements_at_30_symbols: RSI_ALERT_SCANNER_MAX_TUPLE_ELEMENTS,
      tradingview_tuple_limit: 127,
    },
    alert_events: [
      'NEW_DEVELOPING_REGULAR_BULL',
      'NEW_DEVELOPING_HIDDEN_BULL',
      'CONFIRMED_REGULAR_BULL',
      'CONFIRMED_HIDDEN_BULL',
    ],
    query_only_states: [
      'RSI_WATCH_REGULAR_BULL',
      'RSI_WATCH_HIDDEN_BULL',
      'RSI_DEVELOPING_REGULAR_BULL',
      'RSI_DEVELOPING_HIDDEN_BULL',
    ],
    machine_output_contract: RSI_EXACT_MACHINE_OUTPUTS.map(({ field, type, title }) => ({
      field, type, title,
    })),
    notification_behavior: {
      evidence_scope: 'static generated-source contract only; runtime replay is unverified',
      aggregate_alert_calls_in_source: 1,
      aggregate_per_script_iteration: true,
      frequency: 'alert.freq_all',
      frequency_reason: 'varip event-time dedupe survives realtime rollback while allowing a second distinct provisional event later in the same 60-minute host bar.',
      realtime_rollback_safe_dedupe_design: true,
      target_bar_finality: 'timenow routes the current target row as provisional before target time_close and closed only at/after target time_close',
      bootstrap_suppresses_pre_existing_events_by_design: true,
      bootstrap_policy: 'seed events present on the first realtime evaluation; later same-bar pulses and first future bars remain eligible',
      event_identity_includes_symbol_profile_bar_and_type_by_design: true,
      provisional_to_closed_duplicate_suppressed_by_design: true,
      runtime_finality_verified: false,
      runtime_dedupe_verified: false,
      worst_case_message_bytes_at_30_symbols_four_events_each: estimateRsiAlertMessageMaxBytes(),
      tradingview_message_limit_bytes: 40_960,
    },
    offline_rsi_reconstruction: {
      implemented: false,
      reason: 'The CDP OHLCV read is capped at 500 bars while the selected Pine source declares max_bars_back=600; the scanner evaluates inside Pine history.',
    },
    live_validation: {
      pine_compiled: false,
      applied_script_id: null,
      applied_script_version: null,
      applied_source_sha256: null,
      applied_semantic_inputs_sha256: null,
      native_alert_created: false,
    },
    forbidden_claims_until_live_qa: [
      'Pine compilation acceptance',
      'exact selected-indicator runtime parity',
      'live alert readiness',
      'complete watchlist coverage',
      'Bloom Energy July replay acceptance',
      'clean-checkout source reproducibility',
    ],
  };
}
