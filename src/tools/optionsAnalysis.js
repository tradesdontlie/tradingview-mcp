import { z } from 'zod';
import { jsonResult } from './_format.js';
import { analyzeDirectional } from '../core/options/directionalAnalysis.js';

export function registerOptionsAnalysisTools(server) {
  server.tool(
    'options_analyze_directional',
    'PREFERRED high-level tool for directional US options analysis — call this instead of manually chaining options_get_chain + strategy/scenario/ranking internals. Deterministic, read-only: orchestrates options_get_chain -> strategy candidate generation -> scenario repricing -> ranking into one structured packet. NO AI/LLM logic, no narrative, no invented market assumptions — base_target_price must be supplied explicitly (never inferred from spot/analyst targets/technicals). IV shocks default to 0 with an IV_SCENARIO_NOT_SPECIFIED warning unless explicitly provided. The returned packet (ai_contract.numeric_source_of_truth) is authoritative for all numbers a downstream explainer reports — do not recalculate. consideration_eligible marks candidates passing deterministic gates only; it is NOT a recommendation. Volume and open interest are not used by this tool.',
    {
      symbol: z.string().describe('Exchange-qualified symbol, e.g. "NASDAQ:NVDA".'),
      direction: z.enum(['bullish', 'bearish']).describe('Directional thesis.'),
      horizon_days: z.coerce.number().describe('Analysis horizon in days. Also the minimum DTE candidates must satisfy.'),
      max_loss: z.coerce.number().describe('Hard maximum loss constraint in account currency.'),
      base_target_price: z.coerce.number().describe('Explicit user thesis target price. Required — never inferred by this tool.'),

      downside_target_price: z.coerce.number().optional().describe('Explicit unfavorable-scenario price. If omitted, derived deterministically from current spot and base_target_price.'),
      upside_target_price: z.coerce.number().optional().describe('Explicit favorable-scenario price. If omitted, derived deterministically by extending the expected move.'),
      downside_iv_change_points: z.coerce.number().optional().describe('IV shock in percentage points for the downside scenario. Defaults to 0 (with a warning) if none of the three IV shocks are provided.'),
      base_iv_change_points: z.coerce.number().optional().describe('IV shock in percentage points for the base scenario. Defaults to 0.'),
      upside_iv_change_points: z.coerce.number().optional().describe('IV shock in percentage points for the upside scenario. Defaults to 0.'),

      min_dte: z.coerce.number().optional().describe('Minimum days-to-expiry for candidate contracts (raised to horizon_days if lower).'),
      max_dte: z.coerce.number().optional().describe('Maximum days-to-expiry for candidate contracts. Defaults to horizon_days + 45.'),

      max_spread_pct: z.coerce.number().optional().describe('Max bid/ask spread % for a contract to be eligible (default 15).'),
      min_long_delta: z.coerce.number().optional().describe('Minimum |delta| for a long leg (default 0.30).'),
      max_long_delta: z.coerce.number().optional().describe('Maximum |delta| for a long leg (default 0.70).'),
      max_vertical_width: z.coerce.number().optional().describe('Maximum strike width for vertical spreads (default unbounded, capped by nearest-3-strikes pairing).'),
      execution_model: z.enum(['conservative', 'mid']).optional().describe('Fill assumption: conservative = long@ask/short@bid (default); mid = (bid+ask)/2.'),
      commission_per_contract: z.coerce.number().optional().describe('Commission per option leg (default 0).'),
      contract_multiplier: z.coerce.number().optional().describe('Shares per contract (default 100 — an assumption, not provider data).'),

      minimum_score_for_consideration: z.coerce.number().optional().describe('Ranking consideration threshold for score (default 60).'),
      minimum_confidence_for_consideration: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional().describe('Ranking consideration threshold for confidence (default MEDIUM).'),
      min_capped_reward_risk: z.coerce.number().optional().describe('Optional hard gate: reject BULL_CALL_SPREAD/BEAR_PUT_SPREAD candidates below this max_profit/max_loss ratio. Disabled by default.'),

      max_ranked_results: z.coerce.number().optional().describe('Max candidates returned in top_candidates (default 10, hard maximum 25).'),
      include_crr_hybrid_diagnostics: z.coerce.boolean().optional().describe('Diagnostic-only Phase 2D flag. When true and a CRR-shadow market-input provider is configured, includes crr_hybrid_policy evidence. Never changes ranking, eligibility, scoring, or recommendations.'),
    },
    async (req) => {
      try { return jsonResult(await analyzeDirectional(req)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
