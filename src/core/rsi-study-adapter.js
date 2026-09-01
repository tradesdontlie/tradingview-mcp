import { createHash } from 'node:crypto';

import { buildRsiAttentionObservation } from './rsi-attention.js';

export const RSI_EXACT_STUDY_SNAPSHOT_VERSION = 'rsi-exact-study-snapshot/v1';
export const RSI_SELECTED_SOURCE_SHA256 =
  '5c8368f21c3d83fbac517f250b0bb6614924286fecde403701de1e40d722832e';
export const RSI_EXACT_STUDY_TITLE = 'RSI Divergence';
export const RSI_BAR_CLOSE_GRACE_MS = 5_000;

export const RSI_EXACT_MACHINE_OUTPUTS = Object.freeze([
  Object.freeze({
    field: 'confirmed_regular_bull',
    type: 'shapes',
    title: 'Regular Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'confirmed_hidden_bull',
    type: 'shapes',
    title: 'Hidden Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'watch_regular_bull',
    type: 'shapes',
    title: 'Watch Regular Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'watch_hidden_bull',
    type: 'shapes',
    title: 'Watch Hidden Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'new_developing_regular_bull',
    type: 'shapes',
    title: 'New Developing Regular Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'new_developing_hidden_bull',
    type: 'shapes',
    title: 'New Developing Hidden Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'developing_regular_bull',
    type: 'line',
    title: 'Developing Regular Bullish RSI Divergence',
  }),
  Object.freeze({
    field: 'developing_hidden_bull',
    type: 'line',
    title: 'Developing Hidden Bullish RSI Divergence',
  }),
]);

export const RSI_SEMANTIC_INPUTS = Object.freeze([
  Object.freeze({ title: 'RSI Length', type: 'integer' }),
  Object.freeze({ title: 'RSI Source', type: 'source' }),
  Object.freeze({ title: 'Pivot Left Bars', type: 'integer' }),
  Object.freeze({ title: 'Pivot Right Bars', type: 'integer' }),
  Object.freeze({ title: 'Min Bars Between Pivots', type: 'integer' }),
  Object.freeze({ title: 'Max Bars Between Pivots', type: 'integer' }),
  Object.freeze({ title: 'Price Low Source', type: 'source' }),
  Object.freeze({ title: 'Price High Source', type: 'source' }),
  Object.freeze({ title: 'Show Watch Signals', type: 'bool' }),
  Object.freeze({ title: 'Show Developing Divergences', type: 'bool' }),
  Object.freeze({ title: 'Show Regular Bullish', type: 'bool' }),
  Object.freeze({ title: 'Show Hidden Bullish', type: 'bool' }),
  Object.freeze({ title: 'Require Soft Bounce', type: 'bool' }),
  Object.freeze({ title: 'Soft Bounce Bars', type: 'integer' }),
  Object.freeze({ title: 'Developing Max Age', type: 'integer' }),
  Object.freeze({ title: 'Developing Min RSI Difference', type: 'float' }),
  Object.freeze({ title: 'Developing Min Price Difference %', type: 'float' }),
  Object.freeze({ title: 'Strict Clean Developing Lines', type: 'bool' }),
  Object.freeze({ title: 'Strict Local RSI Bars', type: 'integer' }),
  Object.freeze({ title: 'Strict RSI Line Tolerance', type: 'float' }),
]);

// The selected visual indicator currently leaks presentation controls into
// typed machine output and developing-pulse memory. They therefore belong to
// the applied-study binding even though a decoupled headless scanner should not
// reproduce them as detector inputs.
export const RSI_MACHINE_OUTPUT_CONTROL_INPUTS = Object.freeze([
  Object.freeze({ title: 'Display Mode', type: 'string' }),
  Object.freeze({ title: 'History Lookback Bars', type: 'integer' }),
  Object.freeze({ title: 'Show Labels', type: 'bool' }),
  Object.freeze({ title: 'Show Developing Labels', type: 'bool' }),
  Object.freeze({ title: 'Show Lines', type: 'bool' }),
  Object.freeze({ title: 'Show Markers', type: 'bool' }),
]);

export const RSI_APPLIED_STUDY_INPUTS = Object.freeze([
  ...RSI_SEMANTIC_INPUTS,
  ...RSI_MACHINE_OUTPUT_CONTROL_INPUTS,
]);

const OUTPUT_KEY_TO_CONTRACT = new Map(
  RSI_EXACT_MACHINE_OUTPUTS.map(output => [`${output.type}\u0000${output.title}`, output]),
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTimeframe(value) {
  const timeframe = String(value ?? '').trim().toUpperCase();
  if (timeframe === 'D' || timeframe === '1D') return 'D';
  if (timeframe === 'W' || timeframe === '1W') return 'W';
  throw adapterError('unsupported_timeframe', `RSI adapter supports only D or W, received: ${value}`);
}

function requirePositiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw adapterError('invalid_bar_time', `${label} must be a positive safe integer.`);
  }
  return number;
}

function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[^:\s]+:[^:\s]+$/.test(symbol)) {
    throw adapterError(
      'invalid_symbol',
      'RSI adapter requires an exchange-qualified TradingView symbol.',
    );
  }
  return symbol;
}

function stableScalar(value, title) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw adapterError(
    'semantic_input_value_invalid',
    `Semantic input ${title} must have a scalar value.`,
  );
}

function assertSemanticValueType(contract, value) {
  if (contract.type === 'bool' && typeof value !== 'boolean') {
    throw adapterError(
      'semantic_input_value_invalid',
      `Semantic input ${contract.title} must be boolean.`,
    );
  }
  if (contract.type === 'integer' && !Number.isInteger(value)) {
    throw adapterError(
      'semantic_input_value_invalid',
      `Semantic input ${contract.title} must be an integer.`,
    );
  }
  if (contract.type === 'float' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw adapterError(
      'semantic_input_value_invalid',
      `Semantic input ${contract.title} must be finite numeric.`,
    );
  }
  if (contract.type === 'source' && !(typeof value === 'string' && value.trim())) {
    throw adapterError(
      'semantic_input_value_invalid',
      `Semantic input ${contract.title} must identify a source.`,
    );
  }
  if (contract.type === 'string' && !(typeof value === 'string' && value.trim())) {
    throw adapterError(
      'semantic_input_value_invalid',
      `Semantic input ${contract.title} must be a non-empty string.`,
    );
  }
}

export function bindRsiSemanticInputs(rows, { includeMachineOutputControls = false } = {}) {
  if (!Array.isArray(rows)) {
    throw adapterError('semantic_inputs_missing', 'RSI semantic inputs must be an array.');
  }
  const contracts = includeMachineOutputControls
    ? RSI_APPLIED_STUDY_INPUTS
    : RSI_SEMANTIC_INPUTS;
  const inputByTitle = new Map(contracts.map(input => [input.title, input]));
  const requiredRows = new Map();
  for (const row of rows) {
    const contract = inputByTitle.get(row?.title);
    if (!contract) continue;
    if (row.match_count !== undefined && row.match_count !== 1) {
      throw adapterError(
        row.match_count > 1 ? 'semantic_input_duplicate' : 'semantic_input_missing',
        `RSI semantic input ${contract.title} must match exactly once.`,
      );
    }
    if (requiredRows.has(contract.title)) {
      throw adapterError(
        'semantic_input_duplicate',
        `RSI semantic input is duplicated: ${contract.title}`,
      );
    }
    if (row.type !== contract.type) {
      throw adapterError(
        'semantic_input_type_mismatch',
        `RSI semantic input ${contract.title} must have type ${contract.type}.`,
      );
    }
    const value = stableScalar(row.value, contract.title);
    assertSemanticValueType(contract, value);
    requiredRows.set(contract.title, { title: contract.title, type: contract.type, value });
  }
  const missing = contracts
    .filter(contract => !requiredRows.has(contract.title))
    .map(contract => contract.title);
  if (missing.length) {
    throw adapterError(
      'semantic_input_missing',
      `RSI semantic inputs are missing: ${missing.join(', ')}`,
    );
  }
  const inputs = contracts.map(contract => requiredRows.get(contract.title));
  const sha256 = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  return { inputs, sha256 };
}

function machineBoolean(value, output, field) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (value === 0 || value === 1) return value === 1;
  throw adapterError(
    'machine_value_invalid',
    `${output.type}:${output.title} ${field} must be boolean, 0, 1, or null.`,
  );
}

export function bindRsiMachineOutputs(rows) {
  if (!Array.isArray(rows)) {
    throw adapterError('machine_outputs_missing', 'RSI machine outputs must be an array.');
  }
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row?.type}\u0000${row?.title}`;
    if (!OUTPUT_KEY_TO_CONTRACT.has(key)) {
      throw adapterError(
        'machine_output_unexpected',
        `Unexpected RSI machine output: ${String(row?.type)}:${String(row?.title)}`,
      );
    }
    if (byKey.has(key)) {
      throw adapterError(
        'machine_output_duplicate',
        `Duplicated RSI machine output: ${row.type}:${row.title}`,
      );
    }
    if (row.match_count !== undefined && row.match_count !== 1) {
      throw adapterError(
        row.match_count > 1 ? 'machine_output_duplicate' : 'machine_output_missing',
        `RSI machine output ${row.type}:${row.title} must match exactly once.`,
      );
    }
    byKey.set(key, row);
  }
  const missing = RSI_EXACT_MACHINE_OUTPUTS.filter(output => (
    !byKey.has(`${output.type}\u0000${output.title}`)
  ));
  if (missing.length) {
    throw adapterError(
      'machine_output_missing',
      `RSI machine outputs are missing: ${missing.map(row => `${row.type}:${row.title}`).join(', ')}`,
    );
  }
  const current = {};
  const lastClosed = {};
  for (const output of RSI_EXACT_MACHINE_OUTPUTS) {
    const row = byKey.get(`${output.type}\u0000${output.title}`);
    current[output.field] = machineBoolean(row.current, output, 'current');
    lastClosed[output.field] = machineBoolean(row.last_closed, output, 'last_closed');
  }
  return { current, last_closed: lastClosed };
}

function assertSourceBinding(study, expectedSourceSha256) {
  if (!SHA256_PATTERN.test(expectedSourceSha256 ?? '')) {
    throw adapterError('expected_source_invalid', 'Expected RSI source SHA-256 is invalid.');
  }
  const binding = study?.source_binding;
  if (binding?.verified !== true) {
    throw adapterError(
      'live_source_binding_unverified',
      'Applied RSI source/version authority is not verified; refusing to adapt live values.',
    );
  }
  if (binding.source_sha256 !== expectedSourceSha256) {
    throw adapterError(
      'source_hash_mismatch',
      `Applied RSI source hash does not match the selected source: ${String(binding?.source_sha256)}`,
    );
  }
  if (typeof binding.script_id !== 'string' || !binding.script_id.trim()
    || typeof binding.script_version !== 'string' || !binding.script_version.trim()) {
    throw adapterError(
      'live_script_identity_unverified',
      'Applied RSI script ID/version authority is not verified.',
    );
  }
}

/**
 * Convert one exact, source-proved study snapshot into current and last-closed
 * observations. This adapter deliberately does not infer RSI from OHLCV.
 */
export function adaptExactRsiStudySnapshot(snapshot, {
  expectedSourceSha256 = RSI_SELECTED_SOURCE_SHA256,
  expectedSemanticInputsSha256,
  scanAsOfTimeMs = Date.now(),
} = {}) {
  if (snapshot?.schema_version !== RSI_EXACT_STUDY_SNAPSHOT_VERSION) {
    throw adapterError(
      'snapshot_schema_mismatch',
      `Expected ${RSI_EXACT_STUDY_SNAPSHOT_VERSION}.`,
    );
  }
  if (snapshot.study_count !== 1 || !Array.isArray(snapshot.studies) || snapshot.studies.length !== 1) {
    throw adapterError(
      snapshot?.study_count > 1 ? 'study_ambiguous' : 'study_unavailable',
      `Expected exactly one ${RSI_EXACT_STUDY_TITLE} study.`,
    );
  }
  const study = snapshot.studies[0];
  if (study?.title !== RSI_EXACT_STUDY_TITLE) {
    throw adapterError(
      'study_title_mismatch',
      `Expected exact study title ${RSI_EXACT_STUDY_TITLE}.`,
    );
  }
  assertSourceBinding(study, expectedSourceSha256);
  const semanticInputs = bindRsiSemanticInputs(study.semantic_inputs, {
    includeMachineOutputControls: true,
  });
  if (expectedSemanticInputsSha256 !== undefined
    && semanticInputs.sha256 !== expectedSemanticInputsSha256) {
    throw adapterError(
      'semantic_input_hash_mismatch',
      'Applied RSI semantic input hash does not match the expected profile.',
    );
  }
  const values = bindRsiMachineOutputs(study.machine_outputs);
  const symbol = normalizeSymbol(snapshot.symbol);
  const timeframe = normalizeTimeframe(snapshot.timeframe);
  const currentBarTimeMs = requirePositiveSafeInteger(snapshot.current_bar_time_ms, 'current_bar_time_ms');
  const lastClosedBarTimeMs = requirePositiveSafeInteger(
    snapshot.last_closed_bar_time_ms,
    'last_closed_bar_time_ms',
  );
  if (typeof snapshot.current_bar_closed !== 'boolean') {
    throw adapterError('bar_status_unverified', 'current_bar_closed must be explicitly boolean.');
  }
  const barTimesValid = snapshot.current_bar_closed
    ? lastClosedBarTimeMs === currentBarTimeMs
    : lastClosedBarTimeMs < currentBarTimeMs;
  if (!barTimesValid) {
    throw adapterError(
      'bar_time_order_invalid',
      snapshot.current_bar_closed
        ? 'A closed current bar must also be the last-closed bar.'
        : 'An open current bar must follow the last-closed bar.',
    );
  }
  const readingBase = { requested_symbol: symbol, timeframe };
  const current = buildRsiAttentionObservation({
    ...readingBase,
    ...values.current,
    data_bar_time_ms: currentBarTimeMs,
  }, {
    sourceHash: expectedSourceSha256,
    sourceTitle: RSI_EXACT_STUDY_TITLE,
    scanAsOfTimeMs,
    barClosed: snapshot.current_bar_closed,
    observationKind: 'current',
  });
  current.temporal_label = current.provisional
    ? timeframe === 'W' ? 'WEEKLY_PROVISIONAL' : 'DAILY_PROVISIONAL'
    : 'CURRENT_CLOSED';
  const lastClosed = buildRsiAttentionObservation({
    ...readingBase,
    ...values.last_closed,
    data_bar_time_ms: lastClosedBarTimeMs,
  }, {
    sourceHash: expectedSourceSha256,
    sourceTitle: RSI_EXACT_STUDY_TITLE,
    scanAsOfTimeMs,
    barClosed: true,
    observationKind: 'last_closed',
  });
  lastClosed.temporal_label = 'LAST_CLOSED';
  return {
    schema_version: 'rsi-exact-study-adaptation/v1',
    symbol,
    timeframe,
    source_binding: {
      source_sha256: expectedSourceSha256,
      live_binding_verified: true,
      semantic_inputs_sha256: semanticInputs.sha256,
    },
    current,
    last_closed: lastClosed,
  };
}

export function queryRsiAttentionObservations(observations, {
  conditions = [],
  operator = 'OR',
  timeframes = [],
  observationKinds = ['current'],
  includeProvisional = true,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array.');
  const normalizedOperator = String(operator).toUpperCase();
  if (!['AND', 'OR'].includes(normalizedOperator)) {
    throw new TypeError('operator must be AND or OR.');
  }
  const wantedConditions = [...new Set(conditions.map(value => String(value).toUpperCase()))];
  const wantedTimeframes = new Set(timeframes.map(normalizeTimeframe));
  const wantedKinds = new Set(observationKinds.map(value => String(value)));
  return observations.filter(observation => {
    if (wantedTimeframes.size && !wantedTimeframes.has(observation.timeframe)) return false;
    if (wantedKinds.size && !wantedKinds.has(observation.observation_kind)) return false;
    if (!includeProvisional && observation.provisional) return false;
    if (!wantedConditions.length) return observation.active;
    const active = new Set(observation.active_conditions);
    return normalizedOperator === 'AND'
      ? wantedConditions.every(condition => active.has(condition))
      : wantedConditions.some(condition => active.has(condition));
  });
}

/**
 * Produce the read-only page expression later live QA can use. The expression
 * reports source authority as unverified because CDP metadata cannot prove
 * Pine source bytes or cloud version on its own.
 */
export function buildExactRsiStudyReadExpression() {
  const expectedOutputs = JSON.stringify(RSI_EXACT_MACHINE_OUTPUTS);
  // The applied visual study's presentation controls currently affect whether
  // some machine outputs exist and how developing-pulse memory resets. Capture
  // them with the detector inputs so live adaptation fails closed on drift.
  const semanticInputs = JSON.stringify(RSI_APPLIED_STUDY_INPUTS);
  return `(function(){/* exact-rsi-study-adapter:read-v1 */
    function scalar(value){try{value=value&&typeof value.value==='function'?value.value():value}catch(error){return null}return value===null||['string','number','boolean'].indexOf(typeof value)>=0?value:null}
    function machine(value){return value===null||value===undefined?null:value===0||value===1?value:null}
    var root=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();
    if(!root)return {schema_version:${JSON.stringify(RSI_EXACT_STUDY_SNAPSHOT_VERSION)},study_count:0,studies:[],chart_available:false};
    var widget=root._chartWidget;var main=widget.model().mainSeries();var bars=main.bars();var sources=widget.model().model().dataSources();
    var matches=sources.filter(function(source){try{var meta=source.metaInfo();return (meta.description||meta.shortDescription||'')===${JSON.stringify(RSI_EXACT_STUDY_TITLE)}}catch(error){return false}});
    var result={schema_version:${JSON.stringify(RSI_EXACT_STUDY_SNAPSHOT_VERSION)},study_count:matches.length,studies:[],chart_available:true,symbol:(main.symbolInfo()||{}).full_name||root.symbol(),timeframe:String(root.resolution())};
    if(matches.length!==1)return result;
    var study=matches[0],meta=study.metaInfo(),data=study.data(),plots=Array.isArray(meta.plots)?meta.plots:[],expected=${expectedOutputs},inputContracts=${semanticInputs},indexByKey={},countByKey={};
    for(var pi=0;pi<plots.length;pi+=1){var plot=plots[pi]||{},style=meta.styles&&meta.styles[plot.id],title=style&&style.title||plot.title||plot.id,key=String(plot.type)+'\\u0000'+String(title);countByKey[key]=(countByKey[key]||0)+1;indexByKey[key]=pi+1}
    var last=data&&!data.isEmpty()?data.valueAt(data.lastIndex()):null,previous=data&&!data.isEmpty()&&data.lastIndex()>0?data.valueAt(data.lastIndex()-1):null;
    var closeS=Number(main.barCloseTime&&main.barCloseTime()),serverMs=Number(window.ChartApiInstance&&window.ChartApiInstance.serverTime&&window.ChartApiInstance.serverTime()),closeSignalValid=Number.isFinite(closeS)&&Number.isFinite(serverMs),currentBarClosed=closeSignalValid?serverMs>=closeS*1000+${RSI_BAR_CLOSE_GRACE_MS}:null,lastClosedStudyRow=currentBarClosed===true?last:previous;
    var machineOutputs=[];expected.forEach(function(contract){var key=contract.type+'\\u0000'+contract.title,index=indexByKey[key];if(Number.isInteger(index))machineOutputs.push({type:contract.type,title:contract.title,current:machine(last&&last[index]),last_closed:machine(lastClosedStudyRow&&lastClosedStudyRow[index]),match_count:countByKey[key]||0})});
    var inputRows=[],metaInputs=Array.isArray(meta.inputs)?meta.inputs:[],children=null;try{children=study.properties().childs().inputs.childs()}catch(error){}
    inputContracts.forEach(function(contract){var matches=metaInputs.filter(function(input){return input&&input.name===contract.title});matches.forEach(function(input){var property=children&&children[input.id];inputRows.push({title:contract.title,type:scalar(input.type),value:scalar(property),match_count:matches.length})})});
    var mainLast=bars&&bars.size()?bars.valueAt(bars.lastIndex()):null,mainPrevious=bars&&bars.size()>1?bars.valueAt(bars.lastIndex()-1):null,lastClosedMainRow=currentBarClosed===true?mainLast:mainPrevious,source=null,sourceSymbol=null,sourceTimeframe=null,studyLoading=null,studyRestarting=null,studyTurnaround=null;
    try{source=study.symbolSource();sourceSymbol=scalar(source&&typeof source.symbol==='function'?source.symbol():source&&source.symbol);sourceTimeframe=scalar(source&&typeof source.interval==='function'?source.interval():source&&source.interval)}catch(error){}
    try{studyLoading=!!study.isLoading()}catch(error){}try{studyRestarting=!!study.isRestarting()}catch(error){}try{studyTurnaround=scalar(study.turnaround())}catch(error){}
    result.main_loading=!!main.isLoading();result.main_bar_count=bars?bars.size():0;result.bar_close_signal_valid=closeSignalValid;result.last_bar_close_time_s=closeSignalValid?closeS:null;result.tradingview_server_time_ms=closeSignalValid?serverMs:null;result.current_bar_closed=currentBarClosed;
    result.current_bar_time_ms=mainLast&&typeof mainLast[0]==='number'?mainLast[0]*1000:null;result.last_closed_bar_time_ms=lastClosedMainRow&&typeof lastClosedMainRow[0]==='number'?lastClosedMainRow[0]*1000:null;
    result.studies=[{title:${JSON.stringify(RSI_EXACT_STUDY_TITLE)},observed_identity:{script_id:scalar(meta.scriptIdPart),script_version:meta.version===null||meta.version===undefined?null:String(meta.version)},source_symbol:sourceSymbol,source_timeframe:sourceTimeframe,loading:studyLoading,restarting:studyRestarting,completed:!!study.isCompleted(),turnaround:studyTurnaround,current_bar_time_ms:last&&typeof last[0]==='number'?last[0]*1000:null,last_closed_bar_time_ms:lastClosedStudyRow&&typeof lastClosedStudyRow[0]==='number'?lastClosedStudyRow[0]*1000:null,source_binding:{verified:false,source_sha256:null,script_id:null,script_version:null,verification_method:null},machine_outputs:machineOutputs,semantic_inputs:inputRows}];return result;
  })()`;
}
