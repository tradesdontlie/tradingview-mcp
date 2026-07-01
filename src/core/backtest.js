/**
 * replay_walk — the capture-during-replay backtest loop.
 *
 * Steps replay from `from` to `to` and, at every bar, captures the chart's
 * indicator/study values + Pine graphics (via chart_snapshot) into a timestamped
 * series keyed on the canonical OHLCV bar time. This is what makes systematic
 * backtesting of custom Pine theories possible — no fork/upstream has it.
 *
 * Composes T112 (reliable step), T114 (setResolution), T116 (chart_snapshot).
 * All collaborators are injectable via _deps for unit testing.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import * as _replay from './replay.js';
import { chartSnapshot as _chartSnapshot } from './snapshot.js';

// Sections captured per bar by default — the signal-bearing ones for backtesting.
export const DEFAULT_WALK_SECTIONS = ['ohlcv', 'studies', 'pine_labels', 'pine_lines'];
export const DEFAULT_MAX_BARS = 1000;

// After start(), the chart series/studies take ~200ms to materialize (they are
// empty for the first moment), so an immediate capture yields a null bar. Poll a
// cheap ohlcv-only snapshot until the bar is ready before the capture loop.
async function _defaultWaitReady(chartSnapshot, { pollMs = 150, timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const p = await chartSnapshot({ include: ['ohlcv'] });
      if (p && p.bar_time != null) return true;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

function _resolve(deps) {
  return {
    start: deps?.start || _replay.start,
    step: deps?.step || _replay.step,
    setResolution: deps?.setResolution || _replay.setResolution,
    chartSnapshot: deps?.chartSnapshot || _chartSnapshot,
    waitReady: deps?.waitReady || _defaultWaitReady,
    appendFile: deps?.appendFile || ((p, s) => appendFileSync(p, s)),
    writeFile: deps?.writeFile || ((p, s) => writeFileSync(p, s)),
  };
}

function toTsSeconds(dateStr, label) {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) throw new Error(`Invalid ${label} date: "${dateStr}". Use YYYY-MM-DD or ISO format.`);
  return Math.floor(ms / 1000);
}

function shapeRow(snap, currentDate) {
  const row = { t: snap.bar_time ?? null, current_date: currentDate ?? null };
  if (snap.ohlcv && snap.ohlcv.bars && snap.ohlcv.bars.length) row.ohlcv = snap.ohlcv.bars[snap.ohlcv.bars.length - 1];
  if (snap.studies) row.studies = snap.studies.studies || [];
  if (snap.pine_labels) row.pine_labels = snap.pine_labels.studies || [];
  if (snap.pine_lines) row.pine_lines = snap.pine_lines.studies || [];
  if (snap.pine_tables) row.pine_tables = snap.pine_tables.studies || [];
  if (snap.pine_boxes) row.pine_boxes = snap.pine_boxes.studies || [];
  return row;
}

export async function replayWalk({ from, to, capture, resolution, sections, max_bars, out, _deps } = {}) {
  const fns = _resolve(_deps);

  if (!from) throw new Error('`from` date is required (YYYY-MM-DD or ISO).');
  if (!to) throw new Error('`to` date is required (YYYY-MM-DD or ISO).');
  const toTs = toTsSeconds(to, 'to');
  toTsSeconds(from, 'from'); // validate `from` early too

  const maxBars = Math.max(1, Number(max_bars) || DEFAULT_MAX_BARS);
  const includeSections = Array.isArray(sections) && sections.length ? sections : DEFAULT_WALK_SECTIONS;

  let outPath = null;
  if (out != null) {
    if (typeof out !== 'string' || out.includes(' ')) throw new Error('`out` must be a file path string.');
    outPath = out;
    fns.writeFile(outPath, ''); // truncate/create — stream rows as JSONL
  }

  // Enter replay at the start date, then optionally set stepping granularity.
  const startRes = await fns.start({ date: from });
  let currentDate = startRes.current_date;
  if (resolution != null) await fns.setResolution({ resolution });

  // Wait for the series/studies to materialize so the first captured bar is real.
  const ready = await fns.waitReady(fns.chartSnapshot);

  const series = [];
  let count = 0;
  let truncated = false;
  let reason = 'reached_end_date';

  while (true) {
    // Capture the current bar.
    const snap = await fns.chartSnapshot({ study_filter: capture, include: includeSections });
    const row = shapeRow(snap, currentDate);
    if (outPath) fns.appendFile(outPath, JSON.stringify(row) + '\n');
    else series.push(row);
    count++;

    // Reached the end date? (currentDate is the replay cursor, ~period end.)
    if (typeof currentDate === 'number' && currentDate >= toTs) { reason = 'reached_end_date'; break; }
    // Safety cap — never silently over-run.
    if (count >= maxBars) { truncated = true; reason = 'max_bars'; break; }

    // Advance one bar. step() throws at end-of-available-data.
    try {
      const stepRes = await fns.step();
      currentDate = stepRes.current_date;
    } catch {
      reason = 'no_more_data';
      break;
    }
  }

  const result = {
    success: true,
    from,
    to,
    resolution: resolution ?? null,
    bars_captured: count,
    reason,
    truncated,
    sections: includeSections,
    last_bar_date: currentDate ?? null,
    warmup_ready: ready,
  };
  if (!ready) result.note = 'Chart series did not become ready within the warm-up window; early bars may be incomplete.';
  if (outPath) result.out_path = outPath;
  else result.series = series;
  if (truncated) result.note = `Stopped at max_bars=${maxBars} before reaching ${to}. Increase max_bars or narrow the range.`;
  return result;
}
