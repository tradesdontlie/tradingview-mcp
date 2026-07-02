/**
 * Canonical backtest metrics (T119).
 *
 * Shared by both backtest engines so a strategy-script report and an
 * indicator-signal report are directly comparable: both normalize to a trade
 * list of `{ pnl, return_pct, exit_t }` rows, then compute the same aggregates
 * here. Pure functions — no I/O.
 *
 * Unit conventions (documented once, applied everywhere):
 *   - money fields (net_profit, gross_*, avg_*, largest_*, max_drawdown) are in
 *     the account currency, same scale as the input pnl.
 *   - gross_loss is a POSITIVE magnitude; avg_loss / largest_loss are NEGATIVE.
 *   - rate fields (win_rate, max_drawdown_pct) are FRACTIONS in [0,1], not %.
 *   - a field is `null` when it is undefined for the data (e.g. win_rate with 0
 *     trades, profit_factor with 0 gross loss) rather than 0 or Infinity.
 */

/** Aggregate P&L stats from a normalized trade list (each row needs `pnl`). */
export function computeTradeMetrics(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      net_profit: 0, gross_profit: 0, gross_loss: 0, profit_factor: null,
      total_trades: 0, winning_trades: 0, losing_trades: 0, win_rate: null,
      avg_trade: null, avg_win: null, avg_loss: null, largest_win: null, largest_loss: null,
    };
  }
  let gp = 0, gl = 0, wins = 0, losses = 0, largestWin = null, largestLoss = null;
  for (const tr of trades) {
    const p = tr.pnl;
    if (p > 0) { gp += p; wins++; largestWin = largestWin === null ? p : Math.max(largestWin, p); }
    else if (p < 0) { gl += -p; losses++; largestLoss = largestLoss === null ? p : Math.min(largestLoss, p); }
  }
  const net = gp - gl;
  return {
    net_profit: net,
    gross_profit: gp,
    gross_loss: gl,
    profit_factor: gl > 0 ? gp / gl : null,
    total_trades: n,
    winning_trades: wins,
    losing_trades: losses,
    win_rate: wins / n,
    avg_trade: net / n,
    avg_win: wins > 0 ? gp / wins : null,
    avg_loss: losses > 0 ? -gl / losses : null,
    largest_win: largestWin,
    largest_loss: largestLoss,
  };
}

/** Realized-equity curve: initial capital, then a point after each closed trade. */
export function computeEquityCurve(trades, { initial_capital = 0, startT } = {}) {
  const curve = [];
  let eq = initial_capital;
  if (startT != null) curve.push({ t: startT, equity: eq });
  for (const tr of trades) {
    eq += tr.pnl;
    curve.push({ t: tr.exit_t, equity: eq });
  }
  return curve;
}

/** Peak-to-trough drawdown over an equity curve ([{t,equity}]). */
export function maxDrawdown(curve) {
  let peak = -Infinity, maxDD = 0, maxDDpct = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0) {
      const ddp = dd / peak;
      if (ddp > maxDDpct) maxDDpct = ddp;
    }
  }
  return { max_drawdown: maxDD, max_drawdown_pct: maxDDpct };
}
