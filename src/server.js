import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerQuantTools } from './tools/quant.js';

const server = new McpServer(
  {
    name: 'tradingview',
    version: '2.4.0',
    description: 'AI-assisted TradingView chart analysis, Pine v6 development, and quantitative alpha discovery via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — 100+ tools spanning live-chart control, Pine v6 development, and quantitative alpha research.

FAST PATHS (prefer these workflow tools over multi-step recipes):
- pine_deploy_strategy → ONE-SHOT: set source → save with name → add to chart → wait for study. Replaces 5-8 calls.
- strategy_get_report → ONE-SHOT: backtest summary + recent trades + chart context + delayed-feed flag.
- pine_grid_search → vary 1-3 strategy inputs across value lists, run each backtest, return ranked leaderboard.
- strategy_validate_quality → assert Sharpe/PF/DD/trades thresholds, get pass/fail per check.
- chart_ensure_symbol → set symbol + wait + WARN if TradingView fell back to delayed (_DLY) feed.
- symbol_resolve → free-text query → single best canonical symbol (ranks exact ticker first).
- pine_lint → static + server compile in one call; the primary "is my script OK?" check.
- pine_migrate_v6 → heuristic v4/v5 → v6 source rewrite (namespaces built-ins, bumps header).
- pine_explain_error → translate compile errors into actionable fix suggestions.
- pine_v6_reference → look up v6 builtin signatures (ta.*, math.*, strategy.*, request.*, etc.).

ALPHA-DISCOVERY TOOLKIT (use the full sequence to find a deployable edge):
- alpha_screen_metrics → extended metrics from trade list (Calmar, recovery, R-multiple, expectancy, profit concentration). Flags TOP_HEAVY, UNFAVORABLE_EDGE, etc.
- alpha_trade_distribution → moments (mean/std/skew/kurtosis) + percentile spread. Flags LEFT_TAIL_RISK, FAT_TAILS.
- alpha_bootstrap_significance → resampled p-value of mean trade return > 0.
- alpha_deflate_sharpe → Bailey/López de Prado deflated Sharpe (asymptotic approximation; general-purpose).
- alpha_deflate_sharpe_siyolah → CANONICAL Bailey DSR (exact formula with explicit probit + Euler-Mascheroni; requires sr_variance). Refuses n_trials<50. Use for Siyolah Phase-4 gate.
- alpha_pbo_cscv → Probability of Backtest Overfitting via Combinatorial Symmetric CV. PBO≥0.5 = leaderboard is noise. Mirrors siyolah-v3 pbo_cscv.
- alpha_hac_inference → Newey-West HAC SE on returns; t-stat vs zero and vs breakeven. Use to test mean-return significance with autocorrelation-robust SE.
- alpha_retail_long_only_gate → hard pass/fail vs retail_execution_contract.json (no shorts, basket 2-10, 10-50k SAR/position, ADTV≥3M, ≤4 trips/day). Run BEFORE forward-paper.
- alpha_kelly_fraction → optimal position-sizing fraction. Returns half / quarter Kelly too.
- alpha_robustness_check → run current strategy across N symbols; ROBUST_ALPHA vs LIKELY_OVERFIT verdict.
- alpha_walk_forward → IS optimisation → OOS test; reports degradation ratio + verdict.

ADVANCED PINE V6 TEMPLATES (quant-focused) — use via pine_template({type, pattern}):
  Indicators: plot_close, rsi, ema_cross, multitimeframe, udt_levels, map_ticker_tracker, polyline_zigzag, session_vwap, heatmap_table, tasi_session_mask
  Strategies (basic): rsi_crossover, ema_cross, bb_meanreversion, atr_stop_take_profit, trailing_stop, mtf_filter, daterange_window, pyramiding_dca, blank
  Strategies (QUANT/ALPHA): zscore_mr, rsi2_connors, nr7_breakout, donchian_turtle, vol_regime_filter, pairs_ratio_zscore, anchored_vwap_fade, hurst_regime, time_of_day_seasonality, kelly_atr_sizing, multi_factor_composite, half_life_mr
  Strategies (SIYOLAH/TASI): siyolah_derayah_base (foundation for all TASI strategies), topk_basket_long_only, event_window_study
  Libraries: blank, math_helpers

Reading your chart:
- chart_get_state → symbol, timeframe, studies (with is_strategy flag), delayed_feed flag. Call once.
- data_get_study_values → numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
- quote_get → real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new / label.new / table.new / box.new):
- data_get_pine_lines / labels / tables / boxes  — pass study_filter when possible.

Changing the chart:
- chart_ensure_symbol → set ticker AND get delayed_feed/resolved_symbol/warning back (prefer for any audit/validation path). chart_set_symbol is fire-and-forget — use only when you don't need confirmation.
- chart_set_timeframe, chart_set_type → resolution / style
- chart_manage_indicator → add/remove studies (FULL names: "Relative Strength Index" not "RSI")
- chart_scroll_to_date / chart_set_visible_range → date navigation
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script v6 development (recommended order):
- pine_template → vetted v6 scaffolds: indicator{plot_close,rsi,ema_cross,multitimeframe,udt_levels,map_ticker_tracker,polyline_zigzag,session_vwap,heatmap_table}, strategy{rsi_crossover,ema_cross,bb_meanreversion,atr_stop_take_profit,trailing_stop,mtf_filter,daterange_window,pyramiding_dca,blank}, library{blank,math_helpers}
- pine_v6_reference → look up function signatures BEFORE writing (avoids typos in ta.* / math.* / request.* prefixes)
- pine_migrate_v6 → if you've inherited v4/v5 code: rewrite namespaces and bump the version header
- pine_lint → catches errors offline (no chart needed)
- pine_deploy_strategy / pine_deploy_indicator → push + add to chart in one shot. Use _indicator alias when source begins with indicator(); use _strategy when source begins with strategy(). Both call the same core path.
- pine_get_errors → if errors, pipe each into pine_explain_error for fix suggestions
- pine_get_console → read log.info() output
- pine_dismiss_dialog / ui_dismiss_dialog → handle Save/Confirm modals
- pine_extract_inputs → parse input.*() from source (useful before pine_grid_search)

Strategy backtesting + iteration:
- strategy_get_report → headline metrics + trades + chart meta
- strategy_get_inputs / strategy_set_inputs → read/tweak inputs WITHOUT recompiling Pine
- pine_grid_search → systematic input sweep, ranks results by Sharpe / PF / drawdown
- strategy_validate_quality → assert thresholds (Sharpe >= 1.0, DD <= 15%, trades >= 30, etc.)
- data_get_strategy_results → defaults to SUMMARY mode; summary=false + include=["orders","trades"] for raw
- data_get_trades → trade list (capped 20)
- data_get_equity → equity curve

Robustness helpers:
- ui_dismiss_toasts → close ad/promo banners cluttering the UI
- ui_dismiss_dialog → close blocking modals (Save script, Confirm overwrite, etc.)

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch (Desktop) or Chrome CDP on Windows; tv_health_check to verify
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- data_get_strategy_results DEFAULTS to summary mode (~30 keys). Opt into raw with summary=false.
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine drawing tools
- NEVER use verbose=true unless the user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- chart_export_csv returns a FILE PATH (not the CSV body) — use it to feed alpha_pbo_cscv / alpha_hac_inference / external analysis without filling context
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerQuantTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
