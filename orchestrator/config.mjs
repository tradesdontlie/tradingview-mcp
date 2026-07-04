/**
 * Orchestrator constants — the validated universe and the decision thresholds.
 *
 * The validated universe MUST mirror what each bot actually emits/applies
 * (verified in code 2026-06-13). It is the hard clamp: the agent can only ever
 * propose configs that narrow this set, never extend it. Keep this in sync with
 * VALIDATED_STRATEGIES / VALIDATED_FILTERS in scripts/auto_trade*.mjs.
 */

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

export const UNIVERSE = {
  spot: {
    // 6 strategies — 15m pinbar is defined but NOT wired in auto_trade.mjs
    strategies: ['sfp', 'divergence', 'cvd_divergence', 'levels', 'fibonacci', 'market_structure'],
    filters: ['pinbar_bias_4h', 'daily_structure', 'vwap_bias', 'value_area_bias'],
  },
  futures: {
    // 7 strategies — 15m pinbar IS wired in auto_trade_futures.mjs; no daily_structure filter
    strategies: ['sfp', 'divergence', 'cvd_divergence', 'levels', 'fibonacci', 'market_structure', 'pinbar'],
    filters: ['pinbar_bias_4h', 'vwap_bias', 'value_area_bias'],
  },
};

/**
 * The three-part objective. A candidate config is ACCEPTED only if it clears all
 * three on an adequate sample. These are deterministic gates — the LLM proposes,
 * guardrails.mjs enforces; the model cannot reason around them.
 */
export const THRESHOLDS = {
  WIN_FLOOR: 0.60,         // win% ≥ 60%
  EXPECTANCY_FLOOR: 0.20,  // mean net-R per trade ≥ +0.2R (kills high-win%/tiny-R scalps)
  MIN_SAMPLE: 20,          // ≥ 20 resolved trades per combo before acting (kills the 5/5 noise)
  MAX_CHANGES_PER_CYCLE: 1,
  EVAL_WINDOW_DAYS: 40,    // matches the existing ~4000-bar backtest depth
};

// Ignore profit_factor / avg_R on sub-15m rows — simulation artifacts (PF 700+, R 400+).
// Only win% is meaningful there. 15m and slower are trustworthy on all metrics.
export const TRUSTWORTHY_TFS = new Set(['15m', '1h', '4h', '1d']);
export const WINRATE_ONLY_TFS = new Set(['1m', '5m']);

// HISTORICAL_WIN_RATE in the bots is the risk gate. Unsupervised, the agent may
// only move it in the STRICTER (lower) direction — raising it loosens the gate
// and is an approval-required action (mirrors the 2026-06-12 audit principle).
export const RISK_WINRATE_DIRECTION = 'stricter-only';

export const MODEL = 'claude-opus-4-8';
