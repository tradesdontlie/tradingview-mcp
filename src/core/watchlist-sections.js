import { createHash } from 'node:crypto';
import { evaluate, evaluateAsync } from '../connection.js';

// Native string arrays use ###name separator entries. Never strip/rebuild unrelated entries.
export function parseWatchlistSections(symbols) {
  if (!Array.isArray(symbols) || symbols.some(s => typeof s !== 'string')) throw new Error('Unsupported watchlist symbols format');
  const sections = [{ name: null, marker: null, index: 0, symbols: [] }];
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    if (symbol.startsWith('###')) sections.push({ name: symbol.slice(3), marker: symbol, index, symbols: [] });
    else sections.at(-1).symbols.push(symbol);
  }
  return sections;
}

function sectionName(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('###')) {
    throw new Error('section must be a trimmed 1–100 character name without control characters or ### prefix');
  }
  return value;
}

function exactSection(symbols, name) {
  const matches = parseWatchlistSections(symbols).filter(s => s.name === name);
  if (matches.length !== 1) throw new Error(matches.length ? 'Section name is ambiguous' : 'Section not found');
  return matches[0];
}

export function planCreateSection(symbols, section) {
  const name = sectionName(section);
  const matches = parseWatchlistSections(symbols).filter(s => s.name === name);
  if (matches.length > 1) throw new Error('Section name is ambiguous');
  return matches.length ? [...symbols] : [...symbols, `###${name}`];
}

export function planMoveToSection(symbols, section, requested) {
  sectionName(section);
  exactSection(symbols, section);
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100 || new Set(requested).size !== requested.length) throw new Error('symbols must contain 1–100 unique SOURCE:TICKER values');
  for (const symbol of requested) {
    if (typeof symbol !== 'string' || !/^[^:\s]+:[^:\s]+$/.test(symbol) || symbol.startsWith('###')) throw new Error('Every symbol must be SOURCE:TICKER');
    const count = symbols.filter(s => s === symbol).length;
    if (count !== 1) throw new Error(count ? `Symbol occurs more than once: ${symbol}` : `Symbol not in watchlist: ${symbol}`);
  }
  const target = exactSection(symbols, section);
  // Retry is a no-op once all requested entries already belong to the requested section.
  if (requested.every(symbol => target.symbols.includes(symbol))) return [...symbols];
  const wanted = new Set(requested);
  const moved = symbols.filter(symbol => wanted.has(symbol));
  const result = symbols.filter(symbol => !wanted.has(symbol));
  const marker = result.indexOf(target.marker);
  let end = marker + 1;
  while (end < result.length && !result[end].startsWith('###')) end++;
  result.splice(end, 0, ...moved);
  return result;
}

async function resolveListId(explicit, ev) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(explicit)) throw new Error('Invalid list_id');
    return explicit;
  }
  const info = await ev(`(() => {
    const panel = document.querySelector('[class*="layout__area--right"]');
    const roots = panel ? Array.from(panel.querySelectorAll('[data-symbol-full]')).slice(0, 3) : [];
    for (const row of roots) {
      const key = Object.keys(row).find(k => k.startsWith('__reactFiber'));
      let fiber = row[key];
      for (let n = 0; fiber && n < 60; n++, fiber = fiber.return) {
        const current = fiber.memoizedProps?.current;
        if (current?.id && current.type === 'custom') return { id: String(current.id) };
      }
    }
    return null;
  })()`);
  if (!info?.id || !/^[A-Za-z0-9_-]{1,64}$/.test(info.id)) throw new Error('Active custom watchlist unavailable; supply an explicit list_id or open its panel manually');
  return info.id;
}

async function readList(id, ev) {
  const result = await ev(`(async () => {
    const response = await fetch('https://www.tradingview.com/api/v1/symbols_list/custom/' + ${JSON.stringify(id)} + '/', {
      credentials: 'include', signal: AbortSignal.timeout(10000), cache: 'no-store'
    });
    if (!response.ok) throw new Error('Watchlist read HTTP ' + response.status);
    const list = await response.json();
    return { id: String(list.id), type: list.type, name: list.name, symbols: list.symbols, modified: list.modified, etag: response.headers.get('ETag') };
  })()`);
  if (!result || String(result.id) !== id || result.type !== 'custom') throw new Error('Exact custom watchlist identity could not be verified');
  parseWatchlistSections(result.symbols);
  return result;
}

export function watchlistRevision(list) {
  return createHash('sha256').update(JSON.stringify({ id: String(list.id), symbols: list.symbols, modified: list.modified ?? null })).digest('hex');
}

const listLocks = new Map();
async function locked(id, operation) {
  const previous = listLocks.get(id) || Promise.resolve();
  const work = previous.catch(() => {}).then(operation);
  listLocks.set(id, work);
  try { return await work; }
  finally { if (listLocks.get(id) === work) listLocks.delete(id); }
}

export async function getWatchlistSections({ list_id, _deps } = {}) {
  const id = await resolveListId(list_id, _deps?.evaluate || evaluate);
  const list = await (_deps?.readList || (id => readList(id, evaluateAsync)))(id);
  return { success: true, list_id: id, list_name: list.name, revision: watchlistRevision(list), sections: parseWatchlistSections(list.symbols), source: 'native_symbols_list' };
}

async function changeSections({ list_id, expected_revision, _deps }, plan, action) {
  const id = await resolveListId(list_id, _deps?.evaluate || evaluate);
  const read = _deps?.readList || (id => readList(id, evaluateAsync));
  return locked(id, async () => {
    const initial = await read(id);
    const revision = watchlistRevision(initial);
    if (expected_revision !== undefined && expected_revision !== revision) throw new Error('Watchlist revision is stale; read sections again before editing');
    const next = plan(initial.symbols);
    if (JSON.stringify(next) === JSON.stringify(initial.symbols)) return { success: true, changed: false, verified: true, list_id: id, action, revision };
    if (next.length > 10000) throw new Error('Watchlist exceeds the bounded 10000-entry limit');
    const preflight = await read(id);
    if (JSON.stringify(preflight.symbols) !== JSON.stringify(initial.symbols) || preflight.modified !== initial.modified) throw new Error('Watchlist changed concurrently; retry from fresh state');
    const write = _deps?.writeList || (async (list, symbols) => evaluateAsync(`(async () => {
      const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      const etag = ${JSON.stringify(list.etag || null)};
      if (etag) headers['If-Match'] = etag;
      const response = await fetch('https://www.tradingview.com/api/v1/symbols_list/custom/' + ${JSON.stringify(id)} + '/replace/?unsafe=true', {
        method: 'POST', credentials: 'include', headers, signal: AbortSignal.timeout(10000), body: JSON.stringify(${JSON.stringify(symbols)})
      });
      if (!response.ok) throw new Error('Watchlist replacement HTTP ' + response.status);
      return { accepted: true };
    })()`));
    let writeError = null;
    try { await write(initial, next); } catch (error) { writeError = error.message; }
    // Always reread after a write error: it might have reached the server before timing out.
    let actual;
    try { actual = await read(id); }
    catch (error) { return { success: false, changed: null, observed_state_changed: null, write_dispatched: true, ui_refresh_required: true, verified: false, outcome: 'unknown', list_id: id, error: writeError || error.message, action }; }
    const verified = JSON.stringify(actual.symbols) === JSON.stringify(next);
    return { success: verified, changed: verified ? true : null,
      observed_state_changed: JSON.stringify(actual.symbols) !== JSON.stringify(initial.symbols),
      write_dispatched: true, verified, list_id: id, action,
      outcome: verified ? 'confirmed' : 'unconfirmed', revision: watchlistRevision(actual),
      ui_refresh_required: true,
      atomic_compare_and_swap: false,
      note: 'Native API has no documented atomic revision contract. Preflight and exact readback detect observed concurrency; no blind rollback or retry is performed.',
      ...(!verified && { error: writeError || 'Watchlist server state did not match the requested section operation' }) };
  });
}

export function createWatchlistSection({ list_id, section, expected_revision, _deps } = {}) {
  return changeSections({ list_id, expected_revision, _deps }, symbols => planCreateSection(symbols, section), 'create_section');
}

export function moveToWatchlistSection({ list_id, section, symbols, expected_revision, _deps } = {}) {
  return changeSections({ list_id, expected_revision, _deps }, entries => planMoveToSection(entries, section, symbols), 'move_to_section');
}
