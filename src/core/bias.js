/**
 * Directional bias inference for black-box custom Pine indicators that draw only
 * lines/labels/boxes (no plot() output, so getStudyValues/data_get_study_values
 * returns nothing for them). Built on top of getPineLabels/getPineTables.
 *
 * Motivated by a downstream consumer's label/table/box-heavy indicators which
 * have no plot() series to read. (Ported from PR #340 by olaseun28; the bundled
 * Windows exit-crash fix from that PR is NOT included.)
 */
import { getPineLabels, getPineTables } from './data.js';

const BULLISH_RE = /\b(bullish|long|buy)\b/i;
const BEARISH_RE = /\b(bearish|short|sell)\b/i;

// Indicator-agnostic vocabulary for the generic SMC "event A precedes event B" pattern.
// Matches on label TEXT only — not tied to any specific indicator name.
const DEFAULT_EVENT_PAIRS = [
  { name: 'sweep_confirmation', start: /\bsweep\b/i, end: /\b(csd|bos|choch)\b/i },
];

// ---- Pure functions (unit-testable with plain arrays, no CDP) ----

export function findKeywordBias(items) {
  const ordered = [...items].sort((a, b) => (b.x ?? 0) - (a.x ?? 0));
  for (const item of ordered) {
    if (!item.text) continue;
    if (BEARISH_RE.test(item.text)) return { bias: 'bearish', evidence: { type: 'keyword', text: item.text, price: item.price ?? null } };
    if (BULLISH_RE.test(item.text)) return { bias: 'bullish', evidence: { type: 'keyword', text: item.text, price: item.price ?? null } };
  }
  return null;
}

export function findSequenceBias(labels, eventPairs = DEFAULT_EVENT_PAIRS) {
  const withX = labels.filter(l => l.x != null);
  const orderingSource = withX.length ? 'x' : 'array_order';
  const ordered = withX.length ? withX.slice().sort((a, b) => a.x - b.x) : labels;

  for (const pair of eventPairs) {
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (!pair.end.test(ordered[i].text || '')) continue;
      const confirmation = ordered[i];
      for (let j = i - 1; j >= 0; j--) {           // nearest PRIOR sweep, not earliest
        if (!pair.start.test(ordered[j].text || '')) continue;
        const sweep = ordered[j];
        const bias = confirmation.price > sweep.price ? 'bullish'
                    : confirmation.price < sweep.price ? 'bearish' : 'neutral';
        return { bias, evidence: { type: 'sweep_confirmation_sequence', pair: pair.name, orderingSource, sweep, confirmation } };
      }
    }
  }
  return null;
}

function flattenTableCells(tables) {
  const out = [];
  for (const t of tables) for (const row of t.rows) out.push({ text: row, price: null });
  return out;
}

// ---- CDP-backed orchestrator ----

export async function getBiasSignal({ study_filter } = {}) {
  const [labelsRes, tablesRes] = await Promise.all([
    getPineLabels({ study_filter, verbose: true, max_labels: 1000 }),
    getPineTables({ study_filter }),
  ]);

  const names = new Set([
    ...labelsRes.studies.map(s => s.name),
    ...tablesRes.studies.map(s => s.name),
  ]);

  const studies = [...names].map(name => {
    const labelStudy = labelsRes.studies.find(s => s.name === name);
    const tableStudy = tablesRes.studies.find(s => s.name === name);
    const labelItems = labelStudy?.labels || [];
    const tableItems = tableStudy ? flattenTableCells(tableStudy.tables) : [];

    let hit = findKeywordBias([...labelItems, ...tableItems]);
    let confidence = 'high';
    if (!hit) {
      hit = findSequenceBias(labelItems);
      confidence = 'low';
    }
    if (!hit) return { study: name, bias: 'neutral', confidence: 'low', evidence: [], note: 'No bias keyword or sweep/confirmation sequence found' };
    return { study: name, bias: hit.bias, confidence, evidence: [hit.evidence] };
  });

  return { success: true, study_count: studies.length, studies };
}
