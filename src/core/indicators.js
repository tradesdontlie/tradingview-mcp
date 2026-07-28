/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const DIALOG = '[data-name="indicators-dialog"]';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Only the search path (openDialog/typeQuery/closeDialog/runSearch,
// searchStudies, addStudyFromSearch) takes _deps — it's the part covered by
// unit tests, following the same injection pattern as core/chart.js.
// pollIntervalMs/maxPolls are overridable so tests can exercise the
// "never settles" timeout path without a real ~12s wait.
function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    pollIntervalMs: deps?.pollIntervalMs ?? 400,
    maxPolls: deps?.maxPolls ?? 30,
  };
}

// Read result rows out of the open Indicators dialog. The results pane is a
// VIRTUALIZED list of absolutely-positioned rows. Each real result row has
// `data-role="list-item"` and its title directly on `data-title` — that
// data-role is scoped to the results list alone (verified live: 0 matches
// inside the category sidebar), so unlike a class-name scan it needs no
// exclusion list for the sidebar/header/search-box chrome. Section headers
// are the `[class*="contentHeader"]` elements interspersed between them,
// each wrapping an <h3> (title-case: "My scripts", "Technicals", …).
// `data-title` is also immune to search-highlighting fragmenting a title
// into multiple <span>s, which plain textContent scraping is not.
//
// Also reports `emptyState`: TradingView renders its own "No indicators
// matched your criteria" message when a query genuinely has no matches.
// That's the only reliable way to tell "no matches" apart from "results
// haven't rendered yet" — community-script results can take anywhere from
// well under a second to several seconds to arrive, and reopening the
// dialog does NOT clear whatever was rendered for the previous query, so a
// plain "are there any rows" check can read stale leftovers from the prior
// search as if they were fresh (verified live on both counts). The check is
// a loose regex, not the exact string, so minor copy changes across
// TradingView builds don't quietly break it.
const READ_RESULTS_JS = `
  (function() {
    var dlg = document.querySelector('${DIALOG}');
    if (!dlg) return { open: false };
    var nodes = dlg.querySelectorAll('[data-role="list-item"], [class*="contentHeader"]');
    var results = [], section = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-role') !== 'list-item') {
        var h3 = n.querySelector('h3');
        section = ((h3 ? h3.textContent : n.textContent) || '').trim();
        continue;
      }
      var title = (n.getAttribute('data-title') || '').trim();
      if (!title) continue;
      results.push({ title: title, section: section });
    }
    var emptyState = false;
    var leaves = dlg.querySelectorAll('*');
    for (var j = 0; j < leaves.length; j++) {
      var e = leaves[j];
      if (e.children.length > 0) continue;
      var txt = (e.textContent || '').trim();
      if (txt.length > 0 && txt.length < 80 && /no .*(matched|found|results)/i.test(txt)) { emptyState = true; break; }
    }
    return { open: true, results: results, emptyState: emptyState };
  })()
`;

// Polls (from Node, not inside the evaluated browser JS — an `async`
// IIFE with an internal `await` never resumes through a plain CDP
// Runtime.evaluate call: without `awaitPromise: true` it just returns the
// pending Promise, which serializes as `{}`) until the dialog either shows
// new content (different from `baseline`, taken right before typing) or its
// own empty-state message. Real result timing varies a lot — under a
// second for built-ins, several seconds for community/store results — so
// this waits for a real signal rather than racing a fixed delay.
async function waitForSettled(evaluate, baseline, pollIntervalMs, maxPolls) {
  const baselineKey = JSON.stringify(baseline?.results || []);
  for (let i = 0; i < maxPolls; i++) {
    await delay(pollIntervalMs);
    const current = await evaluate(READ_RESULTS_JS);
    if (!current || !current.open) throw new Error('Indicators dialog closed unexpectedly during search.');
    if (current.emptyState) return { results: [], emptyState: true };
    if (current.results.length > 0 && JSON.stringify(current.results) !== baselineKey) {
      return { results: current.results, emptyState: false };
    }
  }
  return null;
}

async function openDialog(evaluate) {
  const opened = await evaluate(`
    (function() {
      if (document.querySelector('${DIALOG}')) return 'already';
      var btn = document.querySelector('[data-name="open-indicators-dialog"]');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()
  `);
  if (opened === 'no-button') throw new Error('Indicators toolbar button not found.');
  for (let i = 0; i < 20; i++) {
    await delay(200);
    const ready = await evaluate(`!!document.querySelector('${DIALOG} input')`);
    if (ready) return;
  }
  throw new Error('Indicators dialog did not open.');
}

async function typeQuery(evaluate, query) {
  await evaluate(`
    (function() {
      var inp = document.querySelector('${DIALOG} input');
      if (!inp) return false;
      inp.focus();
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${safeString(query)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
}

// Clears the search box back to a blank query before capturing the
// pre-type baseline. Without this, baseline capture can land on whatever
// the previous search left rendered — including, if this exact same query
// was searched last, content IDENTICAL to what the new search will settle
// on, which would make waitForSettled wait forever for a "change" that
// already happened before it started looking (reproduced live: searching
// "stochastic" twice in a row with no clear in between timed out). Blank
// query reliably settles into a distinct default listing within ~200ms
// (verified live) since it's a local re-filter, not a network round trip,
// so a short fixed delay is fine here — unlike the real query below.
async function clearQuery(evaluate) {
  await evaluate(`
    (function() {
      var inp = document.querySelector('${DIALOG} input');
      if (!inp) return false;
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await delay(500);
}

async function closeDialog(evaluate) {
  await evaluate(`
    (function() {
      var dlg = document.querySelector('${DIALOG}');
      if (!dlg) return;
      var close = dlg.querySelector('[data-name="close"], [class*="close"] button, button[class*="close"]');
      if (close) { close.click(); return; }
    })()
  `);
  await delay(300);
}

// Runs one full open→type→read(settled)→close cycle. Reopening the dialog
// fresh each time — rather than reusing an already-open one — matters here
// too: it does NOT clear whatever the previous query left rendered, so the
// pre-type baseline captured below still reflects real prior state that
// needs to be diffed against, not an empty slate.
async function runSearch(evaluate, query, pollIntervalMs, maxPolls) {
  await openDialog(evaluate);
  await clearQuery(evaluate);
  const baseline = await evaluate(READ_RESULTS_JS);
  await typeQuery(evaluate, query);
  const settled = await waitForSettled(evaluate, baseline, pollIntervalMs, maxPolls);
  await closeDialog(evaluate);
  if (!settled) {
    const timeoutS = Math.round((pollIntervalMs * maxPolls) / 1000);
    throw new Error(`Indicators search for "${query}" did not settle within ${timeoutS}s (no new results and no "no matches" message rendered) — TradingView's search may be unusually slow or stuck. Try again, or restart TradingView Desktop if this persists.`);
  }
  return settled.results;
}

/**
 * Search TradingView's Indicators dialog — covers built-ins, strategies,
 * community/public scripts, and your saved scripts (everything the manual
 * search box returns).
 */
export async function searchStudies({ query, limit, _deps } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required.');
  const { evaluate, pollIntervalMs, maxPolls } = _resolve(_deps);
  const cap = limit || 25;

  const results = await runSearch(evaluate, query, pollIntervalMs, maxPolls);

  return { success: true, query, count: Math.min(results.length, cap), results: results.slice(0, cap).map(({ title, section }) => ({ title, section })) };
}

/**
 * Search then add a study by clicking its result row. `match` (default =
 * query) is matched case-insensitively against result titles; the first
 * matching row is added. Verifies a new study landed on the chart.
 */
export async function addStudyFromSearch({ query, match, section, _deps } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required.');
  const { evaluate, pollIntervalMs, maxPolls } = _resolve(_deps);
  const want = String(match || query).trim();

  const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s){return s.id;})`);

  await openDialog(evaluate);
  await clearQuery(evaluate);
  const baseline = await evaluate(READ_RESULTS_JS);
  await typeQuery(evaluate, query);
  const settled = await waitForSettled(evaluate, baseline, pollIntervalMs, maxPolls);
  if (!settled) {
    await closeDialog(evaluate);
    const timeoutS = Math.round((pollIntervalMs * maxPolls) / 1000);
    throw new Error(`Indicators search for "${query}" did not settle within ${timeoutS}s (no new results and no "no matches" message rendered) — TradingView's search may be unusually slow or stuck. Try again, or restart TradingView Desktop if this persists.`);
  }
  if (settled.emptyState) {
    await closeDialog(evaluate);
    throw new Error(`No result matching "${want}" found.`);
  }

  const clicked = await evaluate(`
    (function() {
      var dlg = document.querySelector('${DIALOG}');
      if (!dlg) return { error: 'dialog closed' };
      var want = ${safeString(want.toLowerCase())};
      var wantSection = ${section ? safeString(String(section).toLowerCase()) : 'null'};
      var nodes = dlg.querySelectorAll('[data-role="list-item"], [class*="contentHeader"]');
      var section = null, exact = null, contains = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.getAttribute('data-role') !== 'list-item') {
          var h3 = n.querySelector('h3');
          section = ((h3 ? h3.textContent : n.textContent) || '').trim().toLowerCase();
          continue;
        }
        if (wantSection && section !== wantSection) continue;
        var t = (n.getAttribute('data-title') || '').trim();
        var tl = t.toLowerCase();
        if (tl === want && !exact) exact = { row: n, title: t, section: section };
        if (tl.indexOf(want) !== -1 && !contains) contains = { row: n, title: t, section: section };
      }
      var pick = exact || contains;
      if (!pick) return { error: 'No result matching "' + want + '" found.' };
      pick.row.click();
      return { clicked: pick.title, section: pick.section };
    })()
  `);

  if (clicked && clicked.error) { await closeDialog(evaluate); throw new Error(clicked.error); }

  await delay(1500);
  await closeDialog(evaluate);

  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s){return { id: s.id, name: s.getStudyMeta ? s.getStudyMeta().description : (s.name || null) };})`);
  const beforeSet = new Set(before || []);
  const added = (after || []).filter((s) => !beforeSet.has(s.id));

  return {
    success: added.length > 0,
    added_from_search: clicked?.clicked || null,
    section: clicked?.section || null,
    entity_id: added[0]?.id || null,
    added_count: added.length,
  };
}

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await _evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, updated_inputs: result.updated_inputs };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await _evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
