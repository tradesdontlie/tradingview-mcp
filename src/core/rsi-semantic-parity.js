import {
  buildRsiAttentionObservation,
} from './rsi-attention.js';
import {
  createRsiAlertScannerState,
  reconcileRsiAlertScanner,
} from './rsi-alert-scanner.js';
import { SOURCE_BINDINGS } from './investment-attention-config.js';

export const RSI_SEMANTIC_PARITY_SCHEMA_VERSION = 'rsi-semantic-parity/v1';
const RSI_ALERT_SCANNER_DEFINITION_VERSION = 'rsi-watchlist-alert-scanner/v1';

const PULSES = Object.freeze([
  Object.freeze({
    mask: 1,
    scanner_type: 'NEW_DEVELOPING_REGULAR_BULL',
    observation_field: 'new_developing_regular_bull',
    observation_type: 'NEW_DEVELOPING',
    kind: 'regular',
    provisional: true,
  }),
  Object.freeze({
    mask: 2,
    scanner_type: 'NEW_DEVELOPING_HIDDEN_BULL',
    observation_field: 'new_developing_hidden_bull',
    observation_type: 'NEW_DEVELOPING',
    kind: 'hidden',
    provisional: true,
  }),
  Object.freeze({
    mask: 4,
    scanner_type: 'CONFIRMED_REGULAR_BULL',
    observation_field: 'confirmed_regular_bull',
    observation_type: 'CONFIRMED',
    kind: 'regular',
    provisional: false,
  }),
  Object.freeze({
    mask: 8,
    scanner_type: 'CONFIRMED_HIDDEN_BULL',
    observation_field: 'confirmed_hidden_bull',
    observation_type: 'CONFIRMED',
    kind: 'hidden',
    provisional: false,
  }),
]);

function baseReading(pulse, dataBarTimeMs) {
  return {
    requested_symbol: 'NYSE:PARITY',
    timeframe: 'D',
    data_bar_time_ms: dataBarTimeMs,
    watch_regular_bull: false,
    watch_hidden_bull: false,
    developing_regular_bull: false,
    developing_hidden_bull: false,
    new_developing_regular_bull: false,
    new_developing_hidden_bull: false,
    confirmed_regular_bull: false,
    confirmed_hidden_bull: false,
    [pulse.observation_field]: true,
  };
}

function provePulse(pulse, index) {
  const sourceSha256 = SOURCE_BINDINGS.rsi_scanner_s1.source_sha256;
  let state = createRsiAlertScannerState({
    definitionVersion: RSI_ALERT_SCANNER_DEFINITION_VERSION,
    sourceSha256,
  });
  const emptyLeg = pulse.provisional
    ? { current: { mask: 0, data_bar_time_ms: 1_000 } }
    : { last_closed: { mask: 0, data_bar_time_ms: 1_000 } };
  const first = reconcileRsiAlertScanner(state, [{ symbol: 'NYSE:PARITY', timeframe: 'D', ...emptyLeg }], {
    definitionVersion: RSI_ALERT_SCANNER_DEFINITION_VERSION,
    sourceSha256,
    timeframe: 'D',
    observedAtMs: 10_000 + index,
  });
  state = first.state;
  const pulseLeg = pulse.provisional
    ? { current: { mask: pulse.mask, data_bar_time_ms: 2_000 + index } }
    : { last_closed: { mask: pulse.mask, data_bar_time_ms: 2_000 + index } };
  const second = reconcileRsiAlertScanner(state, [{ symbol: 'NYSE:PARITY', timeframe: 'D', ...pulseLeg }], {
    definitionVersion: RSI_ALERT_SCANNER_DEFINITION_VERSION,
    sourceSha256,
    timeframe: 'D',
    observedAtMs: 20_000 + index,
  });
  const scannerEvent = second.notification?.events?.[0] ?? null;
  const observation = buildRsiAttentionObservation(baseReading(pulse, 2_000 + index), {
    sourceHash: SOURCE_BINDINGS.rsi_scanner_s1.selected_query_source_sha256,
    scanAsOfTimeMs: 20_000 + index,
    barClosed: !pulse.provisional,
  });
  const observationEvent = observation.events[0] ?? null;
  const passed = scannerEvent?.type === pulse.scanner_type
    && scannerEvent?.provisional === pulse.provisional
    && observation.values[pulse.observation_field] === true
    && observationEvent?.type === pulse.observation_type
    && observationEvent?.kind === pulse.kind
    && observationEvent?.provisional === pulse.provisional;
  return {
    pulse: pulse.scanner_type,
    provisional: pulse.provisional,
    scanner_event_type: scannerEvent?.type ?? null,
    observation_event_type: observationEvent?.type ?? null,
    observation_kind: observationEvent?.kind ?? null,
    passed,
  };
}

/**
 * Prove the four accepted regular/hidden x provisional/confirmed notification
 * pulses share the same event meaning in the scanner and query adapter.
 */
export function proveRsiSemanticParity() {
  const cases = PULSES.map(provePulse);
  return {
    schema_version: RSI_SEMANTIC_PARITY_SCHEMA_VERSION,
    source_sha256: SOURCE_BINDINGS.rsi_scanner_s1.source_sha256,
    accepted_pulses: cases,
    complete: cases.length === 4 && cases.every(item => item.passed),
  };
}

export { PULSES as RSI_ACCEPTED_PARITY_PULSES };
