/**
 * Strategy-script backtest reader (T119, the strategyReport half).
 *
 * For a theory formalized as a Pine `strategy()`, TradingView computes a full
 * backtest server-side. @mathieuc/tradingview exposes it on
 * `study.strategyReport` (net profit, profit factor, win rate, max DD, the full
 * trade list, equity history). This module pulls that report headlessly over
 * the socket and normalizes it into the SAME canonical metrics schema the
 * code-side signal engine (signal_pnl.js) emits, so strategy-script and
 * indicator-signal backtests are directly comparable.
 *
 * Two layers, so the mapping is unit-testable without a token:
 *   - normalizeStrategyReport(report, opts) — pure transform (fixture-tested).
 *   - backtestRunStrategy({...}) — validates args, runs the injectable socket
 *     fetch, then normalizes. Socket I/O (`fetchStrategyReport`) is injected via
 *     _deps exactly like backtest_socket.js's fetchStudy.
 *
 * Auth: TV_SESSION / TV_SIGNATURE from env (or opts). Critical secret — never
 * hardcode, log, or commit. The default socket fetch rides the same
 * reverse-engineered protocol as backtest_pull and must be re-smoked live.
 *
 * Field mapping is taken from @mathieuc/tradingview/src/chart/study.js
 * (StrategyReport / PerfReport / TradeReport typedefs). If TV renames keys, the
 * live dump this task calls for is the source of truth — update the maps here.
 */
import { createRequire } from 'node:module';
import { computeTradeMetrics, computeEquityCurve, maxDrawdown } from './metrics.js';
import { decodeCompressed } from './tv_decompress.js';

const require = createRequire(import.meta.url);

// The lib's parseCompressed assumes a ZIP container and throws on TV's zlib
// report blobs — crashing the async study listener (and the MCP server). We
// swap in our hardened decoder on the cached CJS protocol module. This MUST run
// before study.js loads (it does `const { parseCompressed } = require('../protocol')`
// at module-eval, capturing the reference). Since this module is imported at
// server startup (tools/replay.js) and the socket lib is only ever loaded
// lazily inside the fetch functions, a top-level install here patches
// protocol.js before study.js is ever required. Idempotent + best-effort: if
// the internal path moves, the live socket call surfaces it, not this patch.
let _decompressorInstalled = false;
function installDecompressor() {
  if (_decompressorInstalled) return;
  try {
    const protocol = require(require.resolve('@mathieuc/tradingview/src/protocol.js'));
    protocol.parseCompressed = async (data) => {
      try { return decodeCompressed(data); } catch { return { report: {} }; }
    };
    _decompressorInstalled = true;
  } catch { /* leave the lib as-is; the socket fetch will report any failure */ }
}
installDecompressor();

// TV's percentProfitable is a fraction (0..1); guard against a percent (0..100).
function toFraction(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v > 1 ? v / 100 : v;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// TV strategy trade times come back in milliseconds; the {t} convention across
// both engines (and the from/to filter) is seconds. Normalize ms → s.
function toSeconds(t) {
  const n = num(t);
  if (n == null) return null;
  return n > 1e11 ? Math.floor(n / 1000) : n;
}

// TV reports grossLoss as a negative number; canonical gross_loss is a positive
// magnitude. This helper is only used for the pass-through tv_native block.
function normalizeTrade(t) {
  const entry = t.entry || {};
  const exit = t.exit || {};
  const profit = t.profit || {};
  return {
    side: entry.type === 'short' ? 'short' : 'long',
    qty: num(t.quantity),
    entry_t: toSeconds(entry.time),
    entry_price: num(entry.value),
    exit_t: toSeconds(exit.time),
    exit_price: num(exit.value),
    pnl: num(profit.v) ?? 0,
    return_pct: num(profit.p),
    exit_reason: exit.name || null,
  };
}

export function normalizeStrategyReport(report = {}, { initial_capital = 0 } = {}) {
  const perf = report.performance || {};
  const all = perf.all || {};

  const trades = (report.trades || []).map(normalizeTrade);
  const metrics = computeTradeMetrics(trades);

  // Equity curve from the trade list (timestamped, uniform with the signal
  // engine). TV's history.equity is untimestamped so we don't key on it.
  const startT = trades.length ? Math.min(...trades.map((t) => t.entry_t)) : undefined;
  const equity_curve = computeEquityCurve(trades, { initial_capital, startT });
  const dd = maxDrawdown(equity_curve);

  const tv_native = {
    currency: report.currency ?? null,
    net_profit: num(all.netProfit),
    gross_profit: num(all.grossProfit),
    gross_loss: all.grossLoss != null ? Math.abs(all.grossLoss) : null,
    profit_factor: num(all.profitFactor),
    win_rate: toFraction(all.percentProfitable),
    total_trades: num(all.totalTrades),
    winning_trades: num(all.numberOfWiningTrades),
    losing_trades: num(all.numberOfLosingTrades),
    // TV 3.1 reports these as maxStrategyDrawDown{,Percent}; older builds used
    // maxDrawDown{,Percent}. Prefer the current key, fall back to the legacy one.
    max_drawdown: num(perf.maxStrategyDrawDown ?? perf.maxDrawDown),
    max_drawdown_pct: num(perf.maxStrategyDrawDownPercent ?? perf.maxDrawDownPercent),
    sharpe_ratio: num(perf.sharpeRatio),
    sortino_ratio: num(perf.sortinoRatio),
  };

  return { ...metrics, ...dd, equity_curve, trades, tv_native };
}

// Real socket fetch — dynamically imports the lib, loads the strategy script,
// and resolves once the strategy report has populated. Bounded by a hard
// timeout so a hung/broken socket fails loud. Mirrors backtest_socket.js.
async function _defaultFetchStrategyReport({ symbol, timeframe, range, indicatorId, token, signature, timeoutMs = 30000 }) {
  installDecompressor();
  const mod = await import('@mathieuc/tradingview');
  const TradingView = mod.default || mod;
  return await new Promise((resolve, reject) => {
    let client;
    const timer = setTimeout(() => {
      try { client && client.end(); } catch {}
      reject(new Error('Socket timeout — the reverse-engineered protocol may be broken, the session token is invalid/expired, or the script is not a strategy().'));
    }, timeoutMs);
    (async () => {
      client = new TradingView.Client({ token, signature });
      client.onError((...e) => { clearTimeout(timer); reject(new Error('Socket client error: ' + JSON.stringify(e))); });
      let indicator;
      if (String(indicatorId).startsWith('USER;')) {
        const priv = await TradingView.getPrivateIndicators(token, signature);
        const desc = priv.find((p) => p.id === indicatorId);
        if (!desc) throw new Error(`Private strategy not found for this account: ${indicatorId}`);
        indicator = await desc.get();
      } else {
        indicator = await TradingView.getIndicator(indicatorId);
      }
      const chart = new client.Session.Chart();
      chart.setMarket(symbol, { timeframe, range });
      const study = new chart.Study(indicator);
      let settled = false;
      const tryResolve = () => {
        if (settled) return;
        const rep = study.strategyReport || {};
        const hasData = (rep.trades && rep.trades.length) || (rep.performance && Object.keys(rep.performance).length);
        if (!hasData) return;
        settled = true;
        clearTimeout(timer);
        const out = { strategyReport: rep };
        try { client.end(); } catch {}
        resolve(out);
      };
      study.onError((...e) => { if (settled) return; settled = true; clearTimeout(timer); try { client.end(); } catch {} reject(new Error('Study error (is this a strategy() script?): ' + JSON.stringify(e))); });
      study.onUpdate(tryResolve);
      study.onStudyCompleted?.(tryResolve);
    })().catch((err) => { clearTimeout(timer); try { client && client.end(); } catch {} reject(err); });
  });
}

export async function backtestRunStrategy({ scriptId, symbol, timeframe = 'D', range, from, to, token, signature, initial_capital = 0, _deps } = {}) {
  const fetchStrategyReport = _deps?.fetchStrategyReport || _defaultFetchStrategyReport;

  if (!scriptId) throw new Error('`script_id` is required (e.g. "USER;<hash>" for your saved strategy, or "STD;..." built-in strategy).');
  if (!symbol) throw new Error('`symbol` is required (e.g. "NASDAQ:AAPL").');

  const tok = token || process.env.TV_SESSION;
  const sig = signature || process.env.TV_SIGNATURE;
  if (!tok) throw new Error('No session token — set TV_SESSION (and TV_SIGNATURE) in the environment. Required for strategy reports.');

  const barRange = Math.max(1, Number(range) || 500);
  const raw = await fetchStrategyReport({ symbol, timeframe, range: barRange, indicatorId: scriptId, token: tok, signature: sig });

  let normalized = normalizeStrategyReport(raw.strategyReport || {}, { initial_capital });

  // Optional trade-list date filter (the underlying report covers the loaded range).
  if (from != null || to != null) {
    const fromTs = from != null ? Math.floor(new Date(from).getTime() / 1000) : null;
    const toTs = to != null ? Math.floor(new Date(to).getTime() / 1000) : null;
    const kept = normalized.trades.filter((t) => (fromTs == null || t.entry_t >= fromTs) && (toTs == null || t.entry_t <= toTs));
    if (kept.length !== normalized.trades.length) {
      const metrics = computeTradeMetrics(kept);
      const startT = kept.length ? Math.min(...kept.map((t) => t.entry_t)) : undefined;
      const equity_curve = computeEquityCurve(kept, { initial_capital, startT });
      normalized = { ...metrics, ...maxDrawdown(equity_curve), equity_curve, trades: kept, tv_native: normalized.tv_native };
    }
  }

  return {
    success: true,
    engine: 'strategy',
    symbol,
    timeframe,
    script_id: scriptId,
    ...normalized,
  };
}
