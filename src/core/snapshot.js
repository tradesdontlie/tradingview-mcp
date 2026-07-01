/**
 * chart_snapshot — one concurrent capture of everything needed to record a bar:
 * chart state + current-bar OHLCV + study (indicator) values + Pine graphics
 * (lines/labels/tables/boxes), filtered by study name.
 *
 * Reuses the tested decoders in data.js/chart.js rather than re-implementing the
 * (fragile, undocumented-path) extraction. The section fetchers run concurrently
 * via Promise.all — per-bar latency is dominated by replay stepping (~180ms), so
 * a fused single-round-trip IIFE would duplicate the decoders for no real gain.
 * This is the fast per-bar capture the T115 replay_walk loop builds on.
 */
import { getState as _getState } from './chart.js';
import {
  getOhlcv as _getOhlcv,
  getStudyValues as _getStudyValues,
  getPineLines as _getPineLines,
  getPineLabels as _getPineLabels,
  getPineTables as _getPineTables,
  getPineBoxes as _getPineBoxes,
} from './data.js';

export const SNAPSHOT_SECTIONS = ['state', 'ohlcv', 'studies', 'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes'];

function _resolve(deps) {
  return {
    getState: deps?.getState || _getState,
    getOhlcv: deps?.getOhlcv || _getOhlcv,
    getStudyValues: deps?.getStudyValues || _getStudyValues,
    getPineLines: deps?.getPineLines || _getPineLines,
    getPineLabels: deps?.getPineLabels || _getPineLabels,
    getPineTables: deps?.getPineTables || _getPineTables,
    getPineBoxes: deps?.getPineBoxes || _getPineBoxes,
  };
}

export async function chartSnapshot({ study_filter, include, max_labels, _deps } = {}) {
  const fns = _resolve(_deps);

  // Validate `include` against the known section list; unknown names are an error
  // (fail loud rather than silently capturing nothing).
  let want = SNAPSHOT_SECTIONS;
  if (include != null) {
    if (!Array.isArray(include)) throw new Error('include must be an array of section names');
    const bad = include.filter(s => !SNAPSHOT_SECTIONS.includes(s));
    if (bad.length) throw new Error(`Unknown snapshot section(s): ${bad.join(', ')}. Valid: ${SNAPSHOT_SECTIONS.join(', ')}`);
    want = include;
  }

  const filt = study_filter || undefined;

  // Build the concurrent task set. Each section is independent; a section that
  // throws is captured as { error } so one failure doesn't lose the whole snapshot.
  const jobs = [];
  const guard = (p) => p.then(v => v, e => ({ error: e.message }));

  if (want.includes('state')) jobs.push(['state', guard(fns.getState())]);
  if (want.includes('ohlcv')) jobs.push(['ohlcv', guard(fns.getOhlcv({ count: 1, summary: false }))]);
  if (want.includes('studies')) jobs.push(['studies', guard(fns.getStudyValues())]);
  if (want.includes('pine_lines')) jobs.push(['pine_lines', guard(fns.getPineLines({ study_filter: filt }))]);
  if (want.includes('pine_labels')) jobs.push(['pine_labels', guard(fns.getPineLabels({ study_filter: filt, max_labels }))]);
  if (want.includes('pine_tables')) jobs.push(['pine_tables', guard(fns.getPineTables({ study_filter: filt }))]);
  if (want.includes('pine_boxes')) jobs.push(['pine_boxes', guard(fns.getPineBoxes({ study_filter: filt }))]);

  const settled = await Promise.all(jobs.map(([, p]) => p));

  const out = { success: true };
  jobs.forEach(([key], i) => { out[key] = settled[i]; });

  // getStudyValues() has no study_filter param — apply the same substring filter
  // here so `study_filter` behaves consistently across all sections.
  if (filt && out.studies && Array.isArray(out.studies.studies)) {
    const f = filt.toLowerCase();
    const kept = out.studies.studies.filter(s => (s.name || '').toLowerCase().includes(f));
    out.studies = { ...out.studies, studies: kept, study_count: kept.length };
  }

  // Convenience: surface the current bar time + OHLCV at top level (the natural
  // key for a per-bar capture series).
  if (out.ohlcv && out.ohlcv.bars && out.ohlcv.bars.length) {
    const b = out.ohlcv.bars[out.ohlcv.bars.length - 1];
    out.bar_time = b && (b.time ?? b[0]);
  }

  return out;
}
