/**
 * In-memory chart-mutation ledger. Foundation for audit findings C1/C2/C3/C5/C6.
 *
 * Every chart-state-mutating operation (setSymbol, setTimeframe, deploy, setSource)
 * calls `recordChartMutation(...)` BEFORE returning. Read paths (data_get_pine_*,
 * chart_get_state, tv_health_check) read the ledger to:
 *   - emit a `mutation_id` provenance field (C3)
 *   - detect staleness when their result was generated before the latest mutation
 *   - cross-check `chart_get_state.symbol` against the last-recorded mutation symbol (C1)
 *
 * Module-level state — survives within one server process, resets on restart.
 * Intentionally NOT persisted: the ledger only describes *this server's* CDP session.
 */

let _counter = 0;
let _current = {
  mutation_id: 0,
  kind: 'init',
  symbol: null,
  timeframe: null,
  hash: null,
  at: new Date(0).toISOString(),
};
const _perSymbol = new Map(); // symbol → { mutation_id, kind, at }

export function nextMutationId() {
  _counter += 1;
  return _counter;
}

/**
 * Record a chart-state mutation. Returns the new mutation_id.
 * @param {{kind:string, symbol?:string, timeframe?:string, hash?:string}} entry
 */
export function recordChartMutation(entry) {
  const id = nextMutationId();
  _current = {
    mutation_id: id,
    kind: entry.kind || 'unknown',
    symbol: entry.symbol ?? _current.symbol,
    timeframe: entry.timeframe ?? _current.timeframe,
    hash: entry.hash ?? null,
    at: new Date().toISOString(),
  };
  if (_current.symbol) {
    _perSymbol.set(_current.symbol, {
      mutation_id: id,
      kind: _current.kind,
      at: _current.at,
    });
  }
  return id;
}

export function currentMutationId() {
  return _current.mutation_id;
}

export function currentMutation() {
  return { ..._current };
}

export function lastMutationFor(symbol) {
  if (!symbol) return null;
  return _perSymbol.get(symbol) || null;
}

/** Test-only: reset state between unit tests. Not exported in production callers. */
export function _resetLedger() {
  _counter = 0;
  _current = { mutation_id: 0, kind: 'init', symbol: null, timeframe: null, hash: null, at: new Date(0).toISOString() };
  _perSymbol.clear();
}
