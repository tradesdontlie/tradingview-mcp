import { evaluate } from '../connection.js';

const API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const SNAPSHOT = `(() => {
  const chart = ${API};
  const series = chart._chartWidget.model().mainSeries();
  const bars = series.bars();
  const first = bars.firstIndex(); const last = bars.lastIndex();
  const oldest = bars.valueAt(first); const newest = bars.valueAt(last);
  let more = null;
  try { more = series.requestMoreDataAvailable(); } catch {}
  return { symbol: chart.symbol(), resolution: chart.resolution(),
    count: Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first + 1 : 0,
    oldest: oldest?.[0] ?? null, newest: newest?.[0] ?? null,
    more: typeof more === 'boolean' ? more : null,
    visible_range: chart.getVisibleRange() };
})()`;

function integer(value, fallback, name, min, max) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export async function loadHistory({ before, count, max_iterations, timeout_ms, page_size, settle_ms, _deps } = {}) {
  if (before !== undefined) integer(before, undefined, 'before', -62135596800, 253402300799);
  const wantedCount = count === undefined && before !== undefined ? null : integer(count, 5000, 'count', 1, 100000);
  const maxIterations = integer(max_iterations, 10, 'max_iterations', 1, 50);
  const timeout = integer(timeout_ms, 30000, 'timeout_ms', 100, 120000);
  const pageSize = integer(page_size, 1000, 'page_size', 1, 10000);
  const settle = integer(settle_ms, 250, 'settle_ms', 1, 2000);
  const ev = _deps?.evaluate || evaluate;
  const now = _deps?.now || Date.now;
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeout;
  const run = expression => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('History deadline expired; a dispatched request may have an unknown outcome');
    return ev(expression, { timeoutMs: remaining });
  };
  const initial = await run(SNAPSHOT);
  if (!initial || !initial.visible_range) throw new Error('Chart history/visible range is unavailable');
  let state = initial;
  let iterations = 0;
  let reason = 'iteration_limit';
  const reached = s => (before === undefined || (s.oldest !== null && s.oldest <= before))
    && (wantedCount === null || s.count >= wantedCount);
  const unchanged = s => s.symbol === initial.symbol && s.resolution === initial.resolution
    && JSON.stringify(s.visible_range) === JSON.stringify(initial.visible_range);
  while (true) {
    if (!unchanged(state)) { reason = 'chart_or_view_changed'; break; }
    if (reached(state)) { reason = 'reached'; break; }
    if (state.more === false) { reason = 'exhausted'; break; }
    if (now() >= deadline) { reason = 'deadline'; break; }
    if (iterations >= maxIterations) break;
    const previous = state;
    await run(`(() => { const chart = ${API};
      if (chart.symbol() !== ${JSON.stringify(initial.symbol)} || chart.resolution() !== ${JSON.stringify(initial.resolution)}) throw new Error('Chart changed during history loading');
      const series = chart._chartWidget.model().mainSeries();
      if (typeof series.requestMoreData !== 'function') throw new Error('History loading is unsupported');
      series.requestMoreData(${pageSize});
      return true;
    })()`);
    iterations++;
    let progressed = false;
    for (let poll = 0; poll < 8 && now() < deadline; poll++) {
      await sleep(Math.min(settle, Math.max(0, deadline - now())));
      if (now() >= deadline) break;
      state = await run(SNAPSHOT);
      if (!state) throw new Error('History state disappeared during loading');
      progressed = state.count > previous.count || (state.oldest !== null && state.oldest < previous.oldest);
      if (!unchanged(state) || progressed || state.more === false || reached(state)) break;
    }
    if (!progressed && unchanged(state) && state.more !== false && !reached(state)) {
      reason = now() >= deadline ? 'deadline' : 'no_progress'; break;
    }
  }
  const observedViewPreserved = unchanged(state);
  const verificationComplete = reason !== 'deadline' && !(reason === 'no_progress' && iterations > 0);
  const viewPreserved = verificationComplete ? observedViewPreserved : null;
  return { success: reason === 'reached' && viewPreserved, status: reason,
    reached: reached(state), exhausted: reason === 'exhausted', bounded: ['deadline', 'iteration_limit', 'no_progress'].includes(reason),
    requested: { before: before ?? null, count: wantedCount }, iterations,
    loaded_before: initial.count, loaded_after: state.count, oldest: state.oldest, newest: state.newest,
    visible_range_before: initial.visible_range, visible_range_after: state.visible_range,
    view_preserved: viewPreserved, verification_complete: verificationComplete,
    ...(!verificationComplete && { outcome: 'pending_or_unknown', note: 'A dispatched page request may still be pending; receipt fields describe the last observed state, not a later network completion.' }),
    ...(viewPreserved === false && { error: 'Chart identity or viewport changed; no further history requests were sent.' }) };
}
