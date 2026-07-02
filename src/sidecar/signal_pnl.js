/**
 * Code-side signal → P&L engine (T119, the valuable half of the strategy harness).
 *
 * Turns a captured signal series (the {t, values} rows from replay_walk / T115 or
 * backtest_pull / T118) plus simple declarative entry/exit rules into P&L,
 * win-rate, expectancy, drawdown and an equity curve — computed in code, which
 * sidesteps Pine's strategy-engine limits (2000-order cap, single-position
 * quirks). Pure & deterministic: no socket, no token, no fs. This is where
 * silent math bugs hide, so it is fixture-tested against hand-computed output.
 *
 * Rule shape:
 *   {
 *     side: 'long' | 'short',          // trade direction (default 'long')
 *     entry: <predicate>,              // required — open when flat and true
 *     exit:  <predicate>,              // optional — close when in-position and true
 *     price_field: 'close',            // which values field is the fill price
 *     qty: 1,                          // units per trade
 *     fee_per_trade: 0,                // round-turn cost subtracted from each trade
 *     initial_capital: <number>,       // optional — enables % drawdown vs equity
 *   }
 *
 * Predicate grammar (evaluated against the current bar + the previous bar):
 *   leaf       := { field, op, value? | field2? }
 *   combinator := { all: [pred...] } | { any: [pred...] } | { not: pred }
 *   ops: > < >= <= == != crosses_above crosses_below rising falling truthy falsy
 *
 * Fill model: one action per bar. When flat and `entry` fires, enter at that
 * bar's price_field; when in-position and `exit` fires, close at that bar's
 * price_field. A position still open after the last bar is force-closed at the
 * last bar (exit_reason 'end_of_data').
 */
import { computeTradeMetrics, computeEquityCurve, maxDrawdown } from './metrics.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fieldOf = (row, field) => (row && row.values ? row.values[field] : undefined);

function evalLeaf(pred, cur, prev) {
  const { field, op, value, field2 } = pred;
  const cv = fieldOf(cur, field);
  // Comparison threshold: another field on the same row, else a constant.
  const thr = field2 != null ? fieldOf(cur, field2) : value;
  const prevThr = field2 != null ? fieldOf(prev, field2) : value;
  const pv = fieldOf(prev, field);

  switch (op) {
    case 'truthy': return !!cv;
    case 'falsy': return !cv;
    case '>': return isNum(cv) && isNum(thr) && cv > thr;
    case '<': return isNum(cv) && isNum(thr) && cv < thr;
    case '>=': return isNum(cv) && isNum(thr) && cv >= thr;
    case '<=': return isNum(cv) && isNum(thr) && cv <= thr;
    case '==': return cv === thr;
    case '!=': return cv !== thr;
    case 'rising': return isNum(cv) && isNum(pv) && cv > pv;
    case 'falling': return isNum(cv) && isNum(pv) && cv < pv;
    case 'crosses_above':
      return !!prev && isNum(pv) && isNum(cv) && isNum(prevThr) && isNum(thr) && pv <= prevThr && cv > thr;
    case 'crosses_below':
      return !!prev && isNum(pv) && isNum(cv) && isNum(prevThr) && isNum(thr) && pv >= prevThr && cv < thr;
    default: throw new Error(`Unknown predicate op: "${op}".`);
  }
}

export function evalPredicate(pred, cur, prev) {
  if (!pred || typeof pred !== 'object') throw new Error('Predicate must be an object.');
  if (Array.isArray(pred.all)) return pred.all.every((p) => evalPredicate(p, cur, prev));
  if (Array.isArray(pred.any)) return pred.any.some((p) => evalPredicate(p, cur, prev));
  if (pred.not) return !evalPredicate(pred.not, cur, prev);
  return evalLeaf(pred, cur, prev);
}

export function backtestFromSignals({ series, rules } = {}) {
  if (!rules || !rules.entry) throw new Error('`entry` rule is required.');
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error('`series` is required (non-empty array of {t, values} rows).');
  }

  const side = rules.side === 'short' ? 'short' : 'long';
  const dir = side === 'short' ? -1 : 1;
  const priceField = rules.price_field || 'close';
  const qty = rules.qty != null ? rules.qty : 1;
  const fee = rules.fee_per_trade || 0;
  const initialCapital = rules.initial_capital;

  const priceAt = (row) => {
    const p = fieldOf(row, priceField);
    if (!isNum(p)) throw new Error(`price_field '${priceField}' is missing or non-numeric at t=${row.t}.`);
    return p;
  };

  const closeTrade = (open, exitRow, exitI, reason) => {
    const exitPrice = priceAt(exitRow);
    const pnl = dir * (exitPrice - open.entry_price) * qty - fee;
    return {
      side,
      qty,
      entry_t: open.entry_t,
      entry_price: open.entry_price,
      exit_t: exitRow.t,
      exit_price: exitPrice,
      pnl,
      return_pct: dir * (exitPrice - open.entry_price) / open.entry_price,
      bars_held: exitI - open.entry_i,
      exit_reason: reason,
    };
  };

  const trades = [];
  let pos = null;
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    const prev = i > 0 ? series[i - 1] : null;
    if (pos) {
      if (rules.exit && evalPredicate(rules.exit, cur, prev)) {
        trades.push(closeTrade(pos, cur, i, 'signal'));
        pos = null;
      }
    } else if (evalPredicate(rules.entry, cur, prev)) {
      pos = { entry_t: cur.t, entry_price: priceAt(cur), entry_i: i };
    }
  }
  if (pos) {
    const lastI = series.length - 1;
    trades.push(closeTrade(pos, series[lastI], lastI, 'end_of_data'));
  }

  const metrics = computeTradeMetrics(trades);
  const equity_curve = computeEquityCurve(trades, { initial_capital: initialCapital || 0, startT: series[0].t });
  const dd = maxDrawdown(equity_curve);
  return { ...metrics, ...dd, equity_curve, trades };
}
