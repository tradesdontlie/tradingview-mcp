/**
 * Core streaming logic — real-time JSONL output from TradingView.
 * Uses efficient poll + dedup: only emits when data changes.
 */
import { evaluate as _evaluate, KNOWN_PATHS } from '../connection.js';
import { buildGraphicsJS, buildStudyValuesJS, shapeLines, shapeLabels } from './data.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate };
}

const CHART_API = KNOWN_PATHS.chartApi;
const MODEL = `${CHART_API}._chartWidget.model()`;

// Backoff / escalation tuning for repeated errors.
const ERROR_BACKOFF_BASE = 1000;   // first retry delay
const ERROR_BACKOFF_CAP = 30000;   // max retry delay
const ERROR_ESCALATE_AFTER = 10;   // consecutive failures before we surface one error
// Non-transport errors (e.g. a moved API path) won't self-heal the way a dropped
// CDP socket can, so after this many consecutive non-transport failures the loop
// terminates instead of logging at the base interval forever. Generous, so a
// transient page hiccup doesn't kill an otherwise-healthy stream.
const ERROR_TERMINATE_AFTER = 20;

/**
 * Pure decision for the poll loop's error handling, exported for offline tests.
 * Applies to EVERY caught error (not just transport): returns the backoff delay,
 * whether to surface a one-time escalation, and whether to terminate. Transport
 * errors (CDP/ECONNREFUSED) back off but never terminate — they may self-heal when
 * TradingView restarts; a persistent non-transport error terminates after
 * ERROR_TERMINATE_AFTER so a moved API path can't spin an unbounded log loop.
 */
export function streamErrorAction(message, consecutiveErrors) {
  const transport = /CDP|ECONNREFUSED/i.test(message || '');
  const delay = Math.min(ERROR_BACKOFF_BASE * Math.pow(2, consecutiveErrors - 1), ERROR_BACKOFF_CAP);
  return {
    transport,
    escalate: consecutiveErrors >= ERROR_ESCALATE_AFTER,
    terminate: !transport && consecutiveErrors >= ERROR_TERMINATE_AFTER,
    delay,
  };
}

/**
 * A no-op sink: when a stream is invoked WITHOUT an explicit sink (e.g. from the
 * MCP stdio path) nothing is written to the process stdio streams, which would
 * otherwise corrupt the MCP protocol.
 */
const NOOP_SINK = { out() {}, err() {} };

/**
 * Cheap default dedup fingerprint. For a plain object it joins the top-level
 * primitive values plus the key count — far cheaper than serializing the whole
 * (often nested) payload, and good enough to detect "nothing changed" for the
 * shallow streams. Arrays/objects nested inside are summarized by type+length
 * so a structural change still flips the fingerprint; for variable-shape
 * payloads callers pass a purpose-built fingerprint() instead.
 */
export function shallowFingerprint(data) {
  if (data == null) return 'null';
  if (typeof data !== 'object') return String(data);
  if (Array.isArray(data)) return 'arr:' + data.length;
  const keys = Object.keys(data);
  let parts = 'n=' + keys.length;
  for (const k of keys) {
    const v = data[k];
    if (v == null) parts += '|' + k + '=∅';
    else if (typeof v === 'object') parts += '|' + k + '=' + (Array.isArray(v) ? 'arr' + v.length : 'obj' + Object.keys(v).length);
    else parts += '|' + k + '=' + v;
  }
  return parts;
}

/**
 * Resolves the fingerprint function for a stream: an explicit per-stream
 * fingerprint wins; otherwise the shallow default. Exported for testing.
 */
export function fingerprintFor(fn) {
  return typeof fn === 'function' ? fn : shallowFingerprint;
}

/**
 * Generic poll-and-diff loop.
 * Calls fetcher(), compares to last value, emits JSONL on change.
 *
 * Output is routed exclusively through the injected `sink` ({ out, err }). When no
 * sink is provided it defaults to NOOP_SINK so the function is safe to call off the
 * CLI path (e.g. the MCP stdio transport). The CLI consumer passes writers backed
 * by process.stdout/stderr to preserve the pipe-friendly JSONL behaviour.
 *
 * Dedup uses a cheap per-stream `fingerprint(data) => string` (defaults to a
 * shallow fingerprint) instead of re-serializing the whole payload every cycle.
 * The emitted JSONL line is serialized exactly once, on emit.
 */
async function pollLoop(fetcher, { interval = 500, dedupe = true, label = 'stream', sink, fingerprint } = {}) {
  const out = sink?.out ?? NOOP_SINK.out;
  const err = sink?.err ?? NOOP_SINK.err;
  const fp = fingerprintFor(fingerprint);
  let lastHash = null;
  let running = true;

  const cleanup = () => { running = false; };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Emit header with compliance notice
  const start = Date.now();
  err(`\u26A0  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n`);
  err(`   Streams from your locally running TradingView Desktop instance only.\n`);
  err(`   Does not connect to TradingView servers. Requires --remote-debugging-port=9222.\n`);
  err(`   Ensure your usage complies with TradingView's Terms of Use.\n`);
  err(`[stream:${label}] started, interval=${interval}ms, Ctrl+C to stop\n`);

  let consecutiveErrors = 0;
  let escalated = false;

  while (running) {
    try {
      const data = await fetcher();
      consecutiveErrors = 0;
      escalated = false;
      if (!data) { await sleep(interval); continue; }

      const hash = dedupe ? fp(data) : null;
      if (!dedupe || hash !== lastHash) {
        lastHash = hash;
        // Single serialization on emit (no second stringify for the dedup hash).
        const line = JSON.stringify({ ...data, _ts: Date.now(), _stream: label });
        out(line + '\n');
      }
    } catch (e) {
      // Bound EVERY persistent error (not just transport): back off exponentially
      // instead of logging at the base interval forever.
      consecutiveErrors++;
      const action = streamErrorAction(e.message, consecutiveErrors);
      if (action.escalate && !escalated) {
        escalated = true;
        err(`[stream:${label}] ${action.transport ? 'CDP unavailable' : 'persistent error'} after ${consecutiveErrors} consecutive attempts: ${e.message}\n`);
      }
      if (action.terminate) {
        err(`[stream:${label}] giving up after ${consecutiveErrors} consecutive non-transport errors (e.g. moved API path): ${e.message}\n`);
        break;
      }
      await sleep(action.delay);
      continue;
    }
    await sleep(interval);
  }

  err(`[stream:${label}] stopped after ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
  process.removeListener('SIGINT', cleanup);
  process.removeListener('SIGTERM', cleanup);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Stream: quote ──

async function fetchQuote(evaluate) {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = ${MODEL};
      var bars = m.mainSeries().bars();
      var last = bars.lastIndex();
      var v = bars.valueAt(last);
      if (!v) return null;
      return {
        symbol: chart.symbol(),
        time: v[0],
        open: v[1],
        high: v[2],
        low: v[3],
        close: v[4],
        volume: v[5] || 0,
      };
    })()
  `);
}

// Per-stream fingerprints (cheap, no full stringify). Exported for testing.
export const fpQuote = (d) => d ? `${d.time}:${d.close}:${d.volume}` : 'null';
export const fpBars = (d) => d ? `${d.bar_time}:${d.close}:${d.volume}` : 'null';

export async function streamQuote({ interval, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchQuote(evaluate), { interval: interval || 300, label: 'quote', sink, fingerprint: fpQuote });
}

// ── Stream: ohlcv (last N bars, emits on new bar) ──

async function fetchLastBar(evaluate) {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = ${MODEL};
      var bars = m.mainSeries().bars();
      var last = bars.lastIndex();
      var v = bars.valueAt(last);
      if (!v) return null;
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        bar_time: v[0],
        open: v[1],
        high: v[2],
        low: v[3],
        close: v[4],
        volume: v[5] || 0,
        bar_index: last,
      };
    })()
  `);
}

export async function streamBars({ interval, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchLastBar(evaluate), { interval: interval || 500, label: 'bars', sink, fingerprint: fpBars });
}

// ── Stream: indicator values ──

// Reuses data.js's buildStudyValuesJS (the deterministic `_study.data()._items`
// path) so streamed values match data_get_study_values for the same chart state.
// The old `_lastBarValues || _data` path was empty/stale for headless callers.
// `symbol` is read alongside the data in the SAME round-trip via the wrapper.
export async function fetchValues(evaluate, studyFilter) {
  const r = await evaluate(`({ symbol: ${CHART_API}.symbol(), data: ${buildStudyValuesJS(studyFilter || '')} })`);
  const studies = (r?.data || []).map(s => ({ name: s.name, values: s.values }));
  return { symbol: r?.symbol, study_count: studies.length, studies };
}

/**
 * Fingerprint for the {symbol, study_count, studies:[{name, values|levels|labels|tables}]}
 * shape shared by the value/lines/labels/tables streams. A full JSON.stringify
 * of nested studies would defeat the purpose, but the top-level shallow
 * fingerprint misses changes WITHIN studies, so we hash symbol + each study's
 * name and a compact summary of its payload. Still far cheaper than serializing
 * the whole nested object every cycle (no string allocation for keys/braces).
 */
export function fpStudies(d) {
  if (!d) return 'null';
  let s = d.symbol + '#' + d.study_count;
  const studies = d.studies || [];
  for (const st of studies) {
    s += '|' + (st.name || st.study || '');
    if (st.values) { for (const k in st.values) s += ';' + k + '=' + st.values[k]; }
    else if (st.levels) { s += ';L' + st.levels.join(','); }
    else if (st.labels) { s += ';B' + st.labels.length; for (const lb of st.labels) s += '/' + lb.text + '@' + lb.price; }
    else if (st.tables) { s += ';T' + st.tables.length; for (const t of st.tables) s += '/' + (t.rows ? t.rows.length : 0); }
  }
  return s;
}

export async function streamValues({ interval, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchValues(evaluate), { interval: interval || 500, label: 'values', sink, fingerprint: fpStudies });
}

// ── Stream: pine lines ──

// Reuses data.js's buildGraphicsJS + shapeLines (the `_primitivesDataById` path
// with y1/y2 horizontal-level extraction) so streamed lines match
// data_get_pine_lines. The old `line.points[0].price` shape is no longer read.
export async function fetchLines(evaluate, studyFilter) {
  const r = await evaluate(`({ symbol: ${CHART_API}.symbol(), data: ${buildGraphicsJS('dwglines', 'lines', studyFilter || '')} })`);
  const shaped = shapeLines(r?.data?.results || [], r?.data?.warnings || []);
  return {
    symbol: r?.symbol,
    study_count: shaped.study_count,
    studies: shaped.studies.map(s => ({ study: s.name, levels: s.horizontal_levels })),
  };
}

export async function streamLines({ interval, filter, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchLines(evaluate, filter), { interval: interval || 1000, label: 'lines', sink, fingerprint: fpStudies });
}

// ── Stream: pine labels ──

// Reuses data.js's buildGraphicsJS + shapeLabels (the `_primitivesDataById` path
// with t/y text+price extraction, capped at 50) so streamed labels match
// data_get_pine_labels. The old `lbl.text`/`lbl.points[0].price` shape is gone.
export async function fetchLabels(evaluate, studyFilter) {
  const r = await evaluate(`({ symbol: ${CHART_API}.symbol(), data: ${buildGraphicsJS('dwglabels', 'labels', studyFilter || '')} })`);
  const shaped = shapeLabels(r?.data?.results || [], r?.data?.warnings || []);
  return {
    symbol: r?.symbol,
    study_count: shaped.study_count,
    studies: shaped.studies.map(s => ({ study: s.name, labels: s.labels })),
  };
}

export async function streamLabels({ interval, filter, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchLabels(evaluate, filter), { interval: interval || 1000, label: 'labels', sink, fingerprint: fpStudies });
}

// ── Stream: pine tables ──

// Reshapes the raw dwgtablecells items (the SAME `_primitivesDataById` path
// data.js reads, with tid/row/col/t fields) into the stream's array-of-cells row
// schema. Pure JS, so it is unit-tested offline. data.js's shapeTables joins each
// row into a string; the stream keeps per-cell arrays, so we reshape here rather
// than reuse that shaper — but read the identical fields.
export function shapeStreamTables(results) {
  return (results || []).map(s => {
    const grids = {};
    for (const item of s.items) {
      const v = item.raw || {};
      const tid = v.tid || 0;
      (grids[tid] = grids[tid] || {});
      (grids[tid][v.row] = grids[tid][v.row] || {})[v.col] = v.t || '';
    }
    const tables = Object.keys(grids).map(tid => {
      const rowsObj = grids[tid];
      const rowNums = Object.keys(rowsObj).map(Number).sort((a, b) => a - b);
      const rows = rowNums.map(rn => {
        const cols = rowsObj[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]);
      });
      return { rows };
    });
    return { study: s.name, tables };
  });
}

export async function fetchTables(evaluate, studyFilter) {
  const r = await evaluate(`({ symbol: ${CHART_API}.symbol(), data: ${buildGraphicsJS('dwgtablecells', 'tableCells', studyFilter || '')} })`);
  const studies = shapeStreamTables(r?.data?.results || []);
  return { symbol: r?.symbol, study_count: studies.length, studies };
}

export async function streamTables({ interval, filter, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchTables(evaluate, filter), { interval: interval || 2000, label: 'tables', sink, fingerprint: fpStudies });
}

// ── Stream: all panes (multi-symbol) ──

const CWC = KNOWN_PATHS.chartWidgetCollection;

async function fetchAllPanes(evaluate) {
  return evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var panes = [];
      for (var i = 0; i < Math.min(all.length, count || all.length); i++) {
        try {
          var c = all[i];
          var model = c.model();
          var ms = model.mainSeries();
          var bars = ms.bars();
          var last = bars.lastIndex();
          var v = bars.valueAt(last);
          if (!v) { panes.push({ index: i, symbol: ms.symbol(), error: 'no bars' }); continue; }
          panes.push({
            index: i,
            symbol: ms.symbol(),
            resolution: ms.interval(),
            time: v[0],
            open: v[1],
            high: v[2],
            low: v[3],
            close: v[4],
            volume: v[5] || 0,
          });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }
      return { layout: layoutType, pane_count: panes.length, panes: panes };
    })()
  `);
}

export function fpPanes(d) {
  if (!d) return 'null';
  let s = (d.layout || '') + '#' + d.pane_count;
  for (const p of (d.panes || [])) s += '|' + p.index + ':' + (p.symbol || '') + ':' + p.time + ':' + p.close + ':' + p.volume + ':' + (p.error || '');
  return s;
}

export async function streamAllPanes({ interval, sink, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return pollLoop(() => fetchAllPanes(evaluate), { interval: interval || 500, label: 'all-panes', sink, fingerprint: fpPanes });
}
