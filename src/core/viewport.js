import { evaluate } from '../connection.js';

const API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const CAPTURE = `(() => {
  try {
    const chart = window.TradingViewApi?._activeChartWidgetWV?.value();
    if (!chart || typeof chart.getTimeScale !== 'function' || typeof chart.getTimeScaleLogicalRange !== 'function') return null;
    const scale = chart.getTimeScale();
    const logical = chart.getTimeScaleLogicalRange();
    if (!scale || !logical || typeof logical.left !== 'function' || typeof logical.right !== 'function') return null;
    const info = chart.symbolExt();
    const range = chart.getVisibleRange();
    if (!info?.full_name || !range) return null;
    const meta = window.TradingViewApi._chartWidgetCollection?.metaInfo;
    const value = item => typeof item?.value === 'function' ? item.value() : item;
    return { layout_id: value(meta?.id) ?? null, layout_name: value(meta?.name) ?? null,
      symbol: info.full_name, resolution: chart.resolution(), visible_range: range,
      logical_range: { from: logical.left(), to: logical.right() },
      bar_spacing: scale.barSpacing(), right_offset: scale.rightOffset(), width: scale.width() };
  } catch { return null; } // A post-replay chart rebuild is not yet a readable viewport.
})()`;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function validateSnapshot(value) {
  if (!value || typeof value.symbol !== 'string' || typeof value.resolution !== 'string') throw new Error('Exact chart identity is required');
  for (const [name, range] of [['visible_range', value.visible_range], ['logical_range', value.logical_range]]) {
    if (!range || finite(range.from, `${name}.from`) > finite(range.to, `${name}.to`)) throw new Error(`Invalid ${name}`);
  }
  if (finite(value.bar_spacing, 'bar_spacing') <= 0) throw new Error('bar_spacing must be positive');
  finite(value.right_offset, 'right_offset');
  if (finite(value.width, 'width') <= 0) throw new Error('width must be positive');
  return value;
}

const sameRange = (a, b) => a?.from === b?.from && a?.to === b?.to;
const sameObserved = (a, b) => a.symbol === b.symbol && a.resolution === b.resolution
  && a.layout_id === b.layout_id && a.layout_name === b.layout_name
  && sameRange(a.visible_range, b.visible_range) && sameRange(a.logical_range, b.logical_range)
  && close(a.bar_spacing, b.bar_spacing) && close(a.right_offset, b.right_offset) && close(a.width, b.width);
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-10;

export async function captureViewport({ timeout_ms = 3000, include_chart_state = false, _deps } = {}) {
  finite(timeout_ms, 'timeout_ms');
  if (timeout_ms <= 0 || timeout_ms > 120000) throw new Error('Viewport capture budget must be positive and at most 120000ms');
  const ev = _deps?.evaluate || evaluate;
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = _deps?.now || Date.now;
  const deadline = now() + timeout_ms;
  const expression = include_chart_state ? `(() => {
    const viewport = ${CAPTURE};
    if (!viewport) return null;
    try {
      const chart = ${API};
      const bars = chart._chartWidget.model().mainSeries().bars();
      if (!bars) return null;
      const first = bars.firstIndex(), last = bars.lastIndex();
      return { ...viewport, chart_state: { name: viewport.layout_name, symbol: viewport.symbol,
        resolution: viewport.resolution, chartType: chart.chartType(), studies: chart.getAllStudies(),
        shapes: chart.getAllShapes(), visible_range: viewport.visible_range,
        loaded_count: last >= first ? last - first + 1 : 0, last_bar_time: bars.valueAt(last)?.[0] } };
    } catch { return null; }
  })()` : CAPTURE;
  while (now() < deadline) {
    let candidate;
    try { candidate = await ev(expression, { timeoutMs: Math.max(1, deadline - now()) }); }
    catch { /* Read-only readiness may be transient while the same pinned chart rebuilds. */ }
    if (now() >= deadline) break;
    try { if (candidate) return validateSnapshot(candidate); } catch { /* Wait for a coherent finite scale. */ }
    await sleep(Math.min(50, Math.max(0, deadline - now())));
  }
  const error = new Error('Viewport readiness timed out; no viewport mutation was dispatched');
  error.code = 'VIEWPORT_NOT_READY';
  throw error;
}

async function restore({ snapshot, expected_current, requested, timeRange = false, timeout_ms = 3000, _deps }) {
  finite(timeout_ms, 'timeout_ms');
  if (timeout_ms < 100 || timeout_ms > 120000) throw new Error('timeout_ms must be between 100 and 120000');
  validateSnapshot(expected_current);
  const ev = _deps?.evaluate || evaluate;
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = _deps?.now || Date.now;
  const deadline = now() + timeout_ms;
  const run = expression => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Viewport deadline expired before dispatch');
    return ev(expression, { timeoutMs: remaining });
  };
  const current = await captureViewport({ timeout_ms: Math.max(1, deadline - now()), _deps });
  if (!sameObserved(current, expected_current)) throw new Error('Viewport changed since expected_current; no restoration was sent');
  if (current.symbol !== snapshot.symbol || current.resolution !== snapshot.resolution) throw new Error('Chart identity differs; restore symbol/timeframe before restoring its viewport');
  if (!timeRange && ((Object.hasOwn(snapshot, 'layout_id') && current.layout_id !== snapshot.layout_id)
    || (Object.hasOwn(snapshot, 'layout_name') && current.layout_name !== snapshot.layout_name))) throw new Error('Saved viewport belongs to another layout; no restoration was sent');
  if (!timeRange && !close(current.width, snapshot.width)) throw new Error('Chart width changed; an exact viewport restoration cannot be certified');
  if ((timeRange && sameRange(current.visible_range, requested)) || (!timeRange && sameObserved(current, snapshot))) {
    return { success: true, verified: true, changed: false, viewport: current };
  }
  const change = timeRange ? `
    const native = chart._chartWidget.model().timeScale();
    const exactIndex = time => {
      const internal = typeof chart._convertTimeFromPublic === 'function' ? chart._convertTimeFromPublic(time) : time;
      let guess = native.timePointToIndex(internal);
      if (!Number.isFinite(guess) || typeof chart._convertIndexToPublicTime !== 'function') throw new Error('Native time projection is unavailable');
      guess = Math.trunc(guess);
      const project = index => {
        const result = chart._convertIndexToPublicTime(index);
        if (!Number.isFinite(result)) throw new Error('Native forward time projection is unavailable');
        return result;
      };
      const first = project(guess);
      if (first === time) return guess;
      // The native inverse clamps at its last generated time point. Search the
      // authoritative forward projection READ-ONLY before one final mutation.
      const direction = first < time ? 1 : -1;
      let previous = guess;
      let step = 1;
      for (let expansion = 0; expansion < 20; expansion++, step *= 2) {
        const candidate = guess + direction * step;
        const projected = project(candidate);
        if (projected === time) return candidate;
        if ((projected < time) !== (first < time)) {
          let low = Math.min(previous, candidate), high = Math.max(previous, candidate);
          for (let attempt = 0; attempt < 32 && low <= high; attempt++) {
            const mid = Math.floor((low + high) / 2), value = project(mid);
            if (value === time) return mid;
            if (value < time) low = mid + 1; else high = mid - 1;
          }
          break;
        }
        previous = candidate;
      }
      throw new Error('No exact native logical index for the requested public time');
    };
    const from = exactIndex(${requested.from}), to = exactIndex(${requested.to});
    if (from > to) throw new Error('Invalid logical time range');
    native.zoomToBarsRange(from, to);
  ` : `
    const scale = chart.getTimeScale();
    scale.setBarSpacing(${snapshot.bar_spacing});
    scale.setRightOffset(${snapshot.right_offset});
  `;
  // Keep future whitespace: logical coordinates/right offsets are not clamped
  // to mainSeries().bars().lastIndex(), unlike the old timestamp conversion.
  await run(`(() => { const chart = ${API};
    const observed = ${CAPTURE};
    if (!observed) throw new Error('Chart viewport is not ready; no restoration was sent');
    const expected = ${JSON.stringify(expected_current)};
    const near = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= Math.max(1,Math.abs(b))*1e-10;
    const range = (a,b) => a?.from === b?.from && a?.to === b?.to;
    if (observed.symbol !== expected.symbol || observed.resolution !== expected.resolution
      || observed.layout_id !== expected.layout_id || observed.layout_name !== expected.layout_name
      || !range(observed.visible_range,expected.visible_range) || !range(observed.logical_range,expected.logical_range)
      || !near(observed.width,expected.width) || !near(observed.bar_spacing,expected.bar_spacing) || !near(observed.right_offset,expected.right_offset)) {
      throw new Error('Viewport changed after expected_current; no restoration was sent');
    }
    if (chart.symbolExt().full_name !== ${JSON.stringify(snapshot.symbol)} || chart.resolution() !== ${JSON.stringify(snapshot.resolution)}) throw new Error('Chart changed before viewport restoration');
    ${change}
    return true;
  })()`);
  let after;
  for (let attempt = 0; attempt < 8 && now() < deadline; attempt++) {
    const candidate = await run(CAPTURE);
    if (!candidate) { await sleep(Math.min(50, Math.max(0, deadline - now()))); continue; }
    after = validateSnapshot(candidate);
    const verified = after.symbol === snapshot.symbol && after.resolution === snapshot.resolution
      && sameRange(after.visible_range, requested)
      && (timeRange || (sameRange(after.logical_range, snapshot.logical_range)
        && close(after.bar_spacing, snapshot.bar_spacing) && close(after.right_offset, snapshot.right_offset)));
    if (verified) return { success: true, verified: true, changed: true, viewport: after };
    await sleep(Math.min(50, Math.max(0, deadline - now())));
  }
  return { success: false, verified: false, requested, viewport: after,
    error: 'Exact viewport restoration was not confirmed; no timestamp clamping or repeated mutation was performed' };
}

export function restoreViewport({ snapshot, expected_current, timeout_ms, _deps } = {}) {
  validateSnapshot(snapshot);
  return restore({ snapshot, expected_current, requested: snapshot.visible_range, timeout_ms, _deps });
}

// Repair helper for an older receipt which saved timestamps but not logical scale state.
// Native TradingView timePointToIndex maps future calendar bars, including months.
export function restoreTimeViewport({ from, to, symbol, resolution, expected_current, timeout_ms, _deps } = {}) {
  if (finite(from, 'from') > finite(to, 'to')) throw new Error('Invalid visible time range');
  if (typeof symbol !== 'string' || typeof resolution !== 'string') throw new Error('Exact chart identity is required');
  return restore({ snapshot: { symbol, resolution }, expected_current, requested: { from, to }, timeRange: true, timeout_ms, _deps });
}
